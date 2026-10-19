/// <reference types="bun" />

import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.VITE_BASE_URL = 'https://studio.example';
process.env.SERVER_SERVE_ORIGIN = 'https://demos.example';
process.env.SERVER_AUTH_SECRET = 'test-only-secret';
process.env.DEMOS_FQDN = '127.0.0.1';

const projectId = '507f1f77bcf86cd799439011';
const wallBindings = new Map([
    ['wall-a', 7],
    ['wall-b', 8]
]);
const wallBindingIds = new Map([
    ['wall-a', 'AAAAAAAAAAAAAAAAAAAAAA'],
    ['wall-b', 'BBBBBBBBBBBBBBBBBBBBBB']
]);
const scopedState = new Map([
    [7, { projectId }],
    [8, { projectId }]
]);
const storedTickets = new Map<string, Date>();

mock.module('~/lib/busState', () => ({ wallBindings, wallBindingIds, scopedState }));
mock.module('~/server/projects', () => ({ getProject: async () => ({ customPort: 3008 }) }));
mock.module('~/server/audit', () => ({
    logAuditDenied: async () => {},
    logAuditFailure: async () => {}
}));
mock.module('~/server/collections', () => ({
    collections: {
        serveLaunches: {
            createIndex: async () => 'expiresAt_1',
            insertOne: async (doc: { _id: string; expiresAt: Date }) => {
                storedTickets.set(doc._id, doc.expiresAt);
            },
            findOneAndDelete: async (query: { _id: string }) => {
                const expiresAt = storedTickets.get(query._id);
                storedTickets.delete(query._id);
                return expiresAt && expiresAt > new Date() ? { _id: query._id, expiresAt } : null;
            }
        }
    }
}));

const { issueServeLaunch } = await import('../../apps/web/src/server/serveLaunch');
const { handleServeRequest } = await import('../../apps/web/src/routes/serve.$projectId.$');

const forwarded: Array<{ url: string; headers: Headers }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    forwarded.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response('<html>demo</html>', {
        headers: { 'content-type': 'text/html', location: '/assets/app.js', 'set-cookie': 'bad=1' }
    });
}) as typeof fetch;

function request(path: string, cookie?: string, origin = 'https://demos.example'): Request {
    return new Request(`${origin}${path}`, {
        headers: { host: new URL(origin).host, ...(cookie ? { cookie } : {}) }
    });
}

describe('isolated serve gateway', () => {
    test('rejects the Vizzy origin and direct unauthenticated demo navigation', async () => {
        assert.equal(
            (
                await handleServeRequest(
                    request(`/serve/${projectId}/screen`, undefined, 'https://studio.example')
                )
            ).status,
            404
        );
        assert.equal(
            (
                await handleServeRequest(
                    request(`/serve/${projectId}/s/AAAAAAAAAAAAAAAAAAAAAA/screen`)
                )
            ).status,
            403
        );
        const websocket = new Request(
            `https://demos.example/serve/${projectId}/s/AAAAAAAAAAAAAAAAAAAAAA/bus`,
            {
                headers: {
                    host: 'demos.example',
                    origin: 'https://demos.example',
                    connection: 'Upgrade',
                    upgrade: 'websocket'
                }
            }
        );
        assert.equal((await handleServeRequest(websocket)).status, 403);
    });

    test('consumes a launch once and proxies only its signed session path', async () => {
        const { ticket, routeId } = await issueServeLaunch({
            projectId,
            entry: 'screen',
            actor: {
                surface: 'wall',
                wallId: 'wall-a',
                scopeId: 7,
                bindingId: 'AAAAAAAAAAAAAAAAAAAAAA'
            }
        });
        const launchPath = `/serve/${projectId}/_launch?ticket=${encodeURIComponent(ticket)}&c=2&r=3`;
        const launch = await handleServeRequest(request(launchPath));
        assert.equal(launch.status, 303);
        assert.equal(
            launch.headers.get('location'),
            `/serve/${projectId}/s/${routeId}/screen?c=2&r=3`
        );
        assert.equal((await handleServeRequest(request(launchPath))).status, 401);
        const cookie = launch.headers.get('set-cookie')!.split(';')[0]!;
        const page = await handleServeRequest(
            request(
                `/serve/${projectId}/s/${routeId}/screen`,
                `${cookie}; vizzy_main_auth=must-not-leak`
            )
        );
        assert.equal(page.status, 200);
        assert.equal(
            page.headers.get('location'),
            `/serve/${projectId}/s/${routeId}/assets/app.js`
        );
        assert.match(
            page.headers.get('content-security-policy') ?? '',
            /frame-ancestors https:\/\/studio\.example/
        );
        assert.equal(page.headers.get('set-cookie'), null);
        assert.equal(forwarded.at(-1)?.url, `http://127.0.0.1:3008/serve/${projectId}/screen`);
        assert.equal(forwarded.at(-1)?.headers.get('cookie'), null);
        assert.equal(forwarded.at(-1)?.headers.get('x-vizzy-wall-id'), 'wall-a');
        assert.equal(
            forwarded.at(-1)?.headers.get('x-vizzy-public-base'),
            `/serve/${projectId}/s/${routeId}`
        );
        const beforeKeepalive = forwarded.length;
        const keepalive = await handleServeRequest(
            request(`/serve/${projectId}/s/${routeId}/_keepalive`, cookie)
        );
        assert.equal(keepalive.status, 200);
        assert.equal(keepalive.headers.get('content-type'), 'image/gif');
        assert.ok(keepalive.headers.get('set-cookie'));
        assert.equal(forwarded.length, beforeKeepalive);
        wallBindingIds.set('wall-a', 'CCCCCCCCCCCCCCCCCCCCCC');
        assert.equal(
            (await handleServeRequest(request(`/serve/${projectId}/s/${routeId}/screen`, cookie)))
                .status,
            403
        );
        wallBindings.delete('wall-a');
        assert.equal(
            (await handleServeRequest(request(`/serve/${projectId}/s/${routeId}/screen`, cookie)))
                .status,
            403
        );
    });

    test('admin preview works without a wall and has a fixed short cookie lifetime', async () => {
        const { ticket, routeId } = await issueServeLaunch({
            projectId,
            entry: 'control',
            actor: { surface: 'preview-control' }
        });
        const launch = await handleServeRequest(
            request(`/serve/${projectId}/_launch?ticket=${ticket}`)
        );
        assert.equal(launch.status, 303);
        assert.ok(launch.headers.get('set-cookie')?.includes('Max-Age=900'));
        const cookie = launch.headers.get('set-cookie')!.split(';')[0]!;
        const page = await handleServeRequest(
            request(`/serve/${projectId}/s/${routeId}/control`, cookie)
        );
        assert.equal(page.status, 200);
        const keepalive = await handleServeRequest(
            request(`/serve/${projectId}/s/${routeId}/_keepalive`, cookie)
        );
        assert.equal(keepalive.headers.get('set-cookie'), null);
    });
});

process.on('exit', () => {
    globalThis.fetch = realFetch;
});
