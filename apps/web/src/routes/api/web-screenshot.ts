import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { stat, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';

import { createFileRoute } from '@tanstack/react-router';

import { computeBlurhash, generateVariants } from '~/lib/serverAssetUtils';
import { ASSET_DIR } from '~/lib/serverVariables';
import { logAuditDenied, logAuditFailure, logAuditSuccess } from '~/server/audit';
import { dbCol } from '~/server/collections';
import { canEditProject } from '~/server/projectAuthz';
import {
    buildRateLimitSubjectKey,
    checkRateLimit,
    getClientIpFromHeaders
} from '~/server/rateLimit';
import type { AuthContext } from '~/server/requestAuthContext';

function generateBaseId(): string {
    return `webshot_${randomBytes(64).toString('hex').slice(0, 32)}`;
}

async function cleanupPreviousFiles(baseId: string): Promise<void> {
    try {
        const { readdir } = await import('node:fs/promises');
        const files = await readdir(ASSET_DIR);
        for (const file of files) {
            if (file.startsWith(baseId)) {
                await unlink(join(ASSET_DIR, file)).catch(() => {});
            }
        }
    } catch {
        // Best-effort cleanup
    }
}

const screenshotAllowlist = String(process.env.WEB_SCREENSHOT_ALLOWLIST ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

function isForbiddenIp(ip: string): boolean {
    const version = isIP(ip);
    if (version === 4) {
        return (
            ip.startsWith('127.') ||
            ip.startsWith('10.') ||
            ip.startsWith('192.168.') ||
            /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) ||
            ip.startsWith('169.254.') ||
            ip === '0.0.0.0'
        );
    }
    if (version === 6) {
        const normalized = ip.toLowerCase();
        return (
            normalized === '::1' ||
            normalized.startsWith('fc') ||
            normalized.startsWith('fd') ||
            normalized.startsWith('fe80:')
        );
    }
    return false;
}

async function assertScreenshotTargetSafe(rawUrl: string) {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('Invalid URL');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http/https URLs are allowed');
    }

    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) {
        throw new Error('Blocked host');
    }
    if (screenshotAllowlist.length > 0 && !screenshotAllowlist.includes(host)) {
        throw new Error('Host is not allowlisted');
    }

    if (isForbiddenIp(host)) throw new Error('Blocked IP target');

    const resolved = await lookup(host, { all: true });
    if (resolved.some((entry) => isForbiddenIp(entry.address))) {
        throw new Error('Blocked resolved IP target');
    }
}

export const Route = createFileRoute('/api/web-screenshot')({
    server: {
        handlers: {
            POST: async ({ request, context }: { request: Request; context?: unknown }) => {
                const upstream = (context ?? {}) as {
                    authContext?: AuthContext;
                    user?: Record<string, any> | null;
                };
                const authContext: AuthContext = upstream.authContext ?? { guest: true };
                const userEmail =
                    typeof authContext.user?.email === 'string' && authContext.user.email.length > 0
                        ? authContext.user.email
                        : null;
                if (!userEmail) {
                    await logAuditDenied({
                        action: 'WEB_SCREENSHOT_DENIED',
                        reasonCode: 'UNAUTHORIZED',
                        resourceType: 'asset',
                        authContext,
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/web-screenshot',
                            request
                        }
                    });
                    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                        status: 401,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                const requesterIp = getClientIpFromHeaders(request.headers);
                const subjectKey = buildRateLimitSubjectKey({
                    actorId: userEmail,
                    ip: requesterIp
                });
                const rateLimit = checkRateLimit({
                    subjectKey
                });
                if (!rateLimit.allowed) {
                    await logAuditDenied({
                        action: 'WEB_SCREENSHOT_DENIED',
                        reasonCode: 'RATE_LIMITED',
                        actorId: userEmail,
                        resourceType: 'asset',
                        authContext,
                        changes: { retryAfterMs: rateLimit.retryAfterMs },
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/web-screenshot',
                            request,
                            ip: requesterIp
                        }
                    });
                    return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
                        status: 429,
                        headers: {
                            'Content-Type': 'application/json',
                            'Retry-After': String(Math.ceil(rateLimit.retryAfterMs / 1000))
                        }
                    });
                }

                let body: {
                    url: string;
                    projectId: string;
                    width: number;
                    height: number;
                    scale?: number;
                    previousBaseId?: string;
                };

                try {
                    body = await request.json();
                } catch {
                    await logAuditFailure({
                        action: 'WEB_SCREENSHOT_FAILED',
                        reasonCode: 'INVALID_JSON_BODY',
                        actorId: userEmail,
                        resourceType: 'asset',
                        authContext,
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/web-screenshot',
                            request
                        }
                    });
                    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                const { url, projectId, width, height, scale = 1 } = body;

                if (!url || !projectId || !width || !height) {
                    await logAuditFailure({
                        action: 'WEB_SCREENSHOT_FAILED',
                        reasonCode: 'MISSING_REQUIRED_FIELDS',
                        actorId: userEmail,
                        projectId: projectId || null,
                        resourceType: 'asset',
                        authContext,
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/web-screenshot',
                            request
                        }
                    });
                    return new Response(
                        JSON.stringify({ error: 'projectId, url, width, and height are required' }),
                        { status: 400, headers: { 'Content-Type': 'application/json' } }
                    );
                }

                const canEdit = await canEditProject(
                    { email: userEmail, role: authContext.user?.role },
                    projectId
                );
                if (!canEdit) {
                    await logAuditDenied({
                        action: 'WEB_SCREENSHOT_DENIED',
                        reasonCode: 'PROJECT_EDIT_FORBIDDEN',
                        actorId: userEmail,
                        projectId,
                        resourceType: 'project',
                        resourceId: projectId,
                        authContext,
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/web-screenshot',
                            request
                        }
                    });
                    return new Response(JSON.stringify({ error: 'Access denied' }), {
                        status: 403,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                if (
                    !Number.isFinite(width) ||
                    !Number.isFinite(height) ||
                    width < 64 ||
                    height < 64 ||
                    width > 8192 ||
                    height > 8192
                ) {
                    await logAuditFailure({
                        action: 'WEB_SCREENSHOT_FAILED',
                        reasonCode: 'INVALID_DIMENSIONS',
                        actorId: userEmail,
                        projectId,
                        resourceType: 'asset',
                        authContext,
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/web-screenshot',
                            request
                        }
                    });
                    return new Response(JSON.stringify({ error: 'Invalid viewport dimensions' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                if (!Number.isFinite(scale) || scale <= 0 || scale > 4) {
                    await logAuditFailure({
                        action: 'WEB_SCREENSHOT_FAILED',
                        reasonCode: 'INVALID_SCALE',
                        actorId: userEmail,
                        projectId,
                        resourceType: 'asset',
                        authContext,
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/web-screenshot',
                            request
                        }
                    });
                    return new Response(JSON.stringify({ error: 'Invalid scale' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                try {
                    await assertScreenshotTargetSafe(url);
                } catch (error: any) {
                    await logAuditFailure({
                        action: 'WEB_SCREENSHOT_FAILED',
                        reasonCode: 'BLOCKED_TARGET',
                        statusMessage: error?.message ?? 'Blocked target',
                        actorId: userEmail,
                        projectId,
                        resourceType: 'asset',
                        authContext,
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/web-screenshot',
                            request
                        }
                    });
                    return new Response(
                        JSON.stringify({ error: error?.message ?? 'Blocked target' }),
                        {
                            status: 400,
                            headers: { 'Content-Type': 'application/json' }
                        }
                    );
                }

                // Clean up previous screenshot files and DB record if provided
                if (body.previousBaseId) {
                    await Promise.all([
                        cleanupPreviousFiles(body.previousBaseId),
                        dbCol.assets.hardDeleteByUrl(`${body.previousBaseId}.png`)
                    ]);
                }

                const baseId = generateBaseId();
                const filename = `${baseId}.png`;
                const screenshotPath = join(ASSET_DIR, filename);

                // Match the wall iframe: viewport = layer size / scale, so the page
                // renders exactly as it appears in the scaled iframe on the wall.
                const viewportWidth = Math.max(1, Math.round(width / scale));
                const viewportHeight = Math.max(1, Math.round(height / scale));

                let browser;
                try {
                    const { chromium } = await import('playwright');
                    browser = await chromium.launch({ headless: true });
                    const context = await browser.newContext({
                        viewport: { width: viewportWidth, height: viewportHeight }
                    });
                    const page = await context.newPage();

                    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });

                    // Clip to the viewport so the screenshot matches the layer dimensions
                    await page.screenshot({
                        path: screenshotPath,
                        type: 'png',
                        clip: { x: 0, y: 0, width: viewportWidth, height: viewportHeight }
                    });
                    await browser.close();
                    browser = undefined;

                    // Generate blurhash and variants using the shared pipeline
                    const blurhash = await computeBlurhash(screenshotPath);
                    const sizes = await generateVariants(screenshotPath, baseId);

                    // Insert a hidden asset record so the serving route can auth-check it
                    // without the record appearing in asset library listings.
                    const fileSize = (await stat(screenshotPath).catch(() => null))?.size ?? 0;
                    await dbCol.assets.insert({
                        projectId,
                        url: filename,
                        size: fileSize,
                        sizes: sizes.length > 0 ? sizes : undefined,
                        blurhash: blurhash ?? undefined,
                        mimeType: 'image/png',
                        hidden: true,
                        name: `web-screenshot:${url}`,
                        createdBy: userEmail
                    });
                    await logAuditSuccess({
                        action: 'WEB_SCREENSHOT_CREATED',
                        actorId: userEmail,
                        projectId,
                        resourceType: 'asset',
                        resourceId: baseId,
                        authContext,
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/web-screenshot',
                            request
                        },
                        changes: {
                            filename,
                            width: viewportWidth,
                            height: viewportHeight
                        }
                    });

                    return new Response(JSON.stringify({ filename, baseId, blurhash, sizes }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    });
                } catch (err: any) {
                    console.error('[WebScreenshot] Failed:', err);
                    if (browser) await browser.close().catch(() => {});
                    const message = String(err?.message ?? 'Screenshot capture failed');
                    await logAuditFailure({
                        action: 'WEB_SCREENSHOT_FAILED',
                        reasonCode: 'CAPTURE_ERROR',
                        statusMessage: message,
                        actorId: userEmail,
                        projectId,
                        resourceType: 'asset',
                        authContext,
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/web-screenshot',
                            request
                        }
                    });
                    const notReady =
                        message.includes('Executable does not exist') ||
                        message.includes('browserType.launch') ||
                        message.includes('playwright');
                    return new Response(
                        JSON.stringify({
                            error: notReady
                                ? 'Screenshot browser is not ready yet. Retry shortly.'
                                : message
                        }),
                        {
                            status: notReady ? 503 : 500,
                            headers: { 'Content-Type': 'application/json' }
                        }
                    );
                }
            }
        }
    }
});
