import { lookup } from 'node:dns/promises';
import { mkdirSync } from 'node:fs';
import net from 'node:net';

import { env, bootHealth } from '@repo/env';
import handler, { createServerEntry } from '@tanstack/react-start/server-entry';
import { MongoClient } from 'mongodb';

import { startMediaWorker } from '~/lib/jobs/mediaWorker';
import { UPLOAD_DIR, TMP_DIR, ASSET_DIR } from '~/lib/serverVariables';
import { getBootstrapStatus } from '~/server/bootstrap';

const bootIssues: string[] = [...bootHealth.issues];
let startupChecksPromise: Promise<void> | null = null;

try {
    mkdirSync(UPLOAD_DIR, { recursive: true });
    mkdirSync(TMP_DIR, { recursive: true });
    mkdirSync(ASSET_DIR, { recursive: true });
} catch (err) {
    console.error('Asset management directory creation failed:', err);
    bootIssues.push('Unable to initialize storage directories (UPLOAD_DIR/TMP_DIR/ASSET_DIR).');
}

function renderBootErrorPage(issues: string[]): string {
    const items = issues.map((issue) => `<li>${issue}</li>`).join('');
    return `<!doctype html>
    <html lang="en">
        <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Vizzy Studio Unavailable</title>
        <style>
            :root { color-scheme: dark; }
            body {
                margin: 0;
                min-height: 100vh;
                display: grid;
                place-items: center;
                background: #0a0a0a;
                color: #a3a3a3;
                font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
            }
            .card {
                width: min(860px, calc(100vw - 32px));
                border: 1px solid #27272a;
                border-radius: 16px;
                padding: 24px;
                background: linear-gradient(180deg, #111113, #0d0d0f);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
            }
            h1 { margin: 0 0 8px; color: #fafafa; font-size: 22px; }
            p { margin: 0 0 16px; color: #a1a1aa; }
            ul { margin: 0; padding-left: 18px; color: #d4d4d8; }
            li { margin: 4px 0; }
            .hint { margin-top: 18px; color: #71717a; font-size: 13px; }
        </style>
        </head>
            <body>
                <main class="card">
                    <h1>Service temporarily unavailable</h1>
                    <p>Vizzy Studio started in degraded mode due to missing or invalid startup configuration.</p>
                    <ul>${items}</ul>
                    <p class="hint">Update environment configuration and restart the service.</p>
                </main>
            </body>
    </html>`;
}

async function verifyMongoReplicaSet(): Promise<void> {
    if (!env.SERVER_DATABASE_URL) return;

    let client: MongoClient | null = null;
    try {
        client = new MongoClient(env.SERVER_DATABASE_URL, {
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 5000
        });
        await client.connect();

        const adminDb = client.db('admin');
        let hello: Record<string, unknown>;
        try {
            hello = (await adminDb.command({ hello: 1 })) as Record<string, unknown>;
        } catch {
            // Backward compatibility with older Mongo deployments that do not support hello.
            hello = (await adminDb.command({ isMaster: 1 })) as Record<string, unknown>;
        }

        const setName = typeof hello?.setName === 'string' ? hello.setName : null;
        const serverMsg = typeof hello?.msg === 'string' ? hello.msg : null;
        const isMongos = serverMsg === 'isdbgrid';
        const hasReplicaSet = typeof setName === 'string' && setName.length > 0;

        // Accept either:
        // 1) direct replica-set mongod topology (`setName` present), or
        // 2) mongos router topology (`msg: isdbgrid`) in front of a sharded cluster.
        if (!hasReplicaSet && !isMongos) {
            bootIssues.push(
                'MongoDB is reachable but did not report replica-set or mongos topology. Change streams require replica-set-backed deployments (direct RS or mongos).'
            );
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        bootIssues.push(`MongoDB connectivity check failed: ${message}`);
    } finally {
        if (client) {
            await client.close().catch(() => {});
        }
    }
}

function isNetworkCheckEnabled(): boolean {
    return !['0', 'false', 'off', 'no'].includes(env.BOOT_NETWORK_CHECK_ENABLED.toLowerCase());
}

async function verifyOutboundConnectivity(): Promise<void> {
    if (!isNetworkCheckEnabled()) return;

    const host = env.BOOT_NETWORK_CHECK_HOST;
    const port = env.BOOT_NETWORK_CHECK_PORT;
    const timeoutMs = env.BOOT_NETWORK_CHECK_TIMEOUT_MS;

    try {
        await lookup(host);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        bootIssues.push(
            `Network bootstrap check failed: DNS resolution failed for "${host}" (${message}).`
        );
        return;
    }

    await new Promise<void>((resolve) => {
        const socket = new net.Socket();
        let done = false;

        const finish = (issue?: string) => {
            if (done) return;
            done = true;
            socket.destroy();
            if (issue) bootIssues.push(issue);
            resolve();
        };

        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish());
        socket.once('timeout', () =>
            finish(
                `Network bootstrap check failed: connection timeout to "${host}:${port}" after ${timeoutMs}ms.`
            )
        );
        socket.once('error', (err) => {
            const message = err instanceof Error ? err.message : String(err);
            finish(
                `Network bootstrap check failed: could not connect to "${host}:${port}" (${message}).`
            );
        });

        socket.connect(port, host);
    });
}

async function runStartupChecksOnce(): Promise<void> {
    if (!startupChecksPromise) {
        startupChecksPromise = (async () => {
            if (bootIssues.length > 0) return;
            await verifyMongoReplicaSet();
            if (bootIssues.length > 0) return;
            await verifyOutboundConnectivity();
            if (bootIssues.length > 0) return;
            await getBootstrapStatus();
            await startMediaWorker();
        })();
    }
    await startupChecksPromise;
}

export default createServerEntry({
    async fetch(request) {
        await runStartupChecksOnce();
        if (bootIssues.length > 0) {
            const url = new URL(request.url);
            if (url.pathname.startsWith('/api/')) {
                return new Response(
                    JSON.stringify({
                        error: 'service_unavailable',
                        message:
                            'Service started in degraded mode due to startup configuration issues.',
                        issues: bootIssues
                    }),
                    { status: 503, headers: { 'Content-Type': 'application/json' } }
                );
            }
            return new Response(renderBootErrorPage(bootIssues), {
                status: 503,
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }
        return handler.fetch(request);
    }
});
