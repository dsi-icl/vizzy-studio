import type { JsonValue } from '@repo/db/documents';
import { createFileRoute } from '@tanstack/react-router';

import { logAuditDenied, logAuditFailure, logAuditSuccess } from '~/server/audit';
import type { AuthContext } from '~/server/requestAuthContext';
import { resolveRequestAuthContext } from '~/server/requestAuthContext';
import { resolveWallMediaCookieAuthContext } from '~/server/wallMediaCookie';

const isDev = process.env.NODE_ENV === 'development';
const PROXY_ALLOWED_REFERRERS = (process.env.PROXY_ALLOWED_REFERRERS ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
const PROXY_ALLOW_MISSING_REFERRER =
    process.env.PROXY_ALLOW_MISSING_REFERRER === 'true' || process.env.NODE_ENV !== 'production';
const PROXY_FETCH_TIMEOUT_MS = Number(process.env.PROXY_FETCH_TIMEOUT_MS ?? 8000);
const PROXY_MAX_BYTES = Number(process.env.PROXY_MAX_BYTES ?? 4 * 1024 * 1024);

function redirectTo(path: '/web-nonet?l=wall' | '/web-corsissue?l=wall'): Response {
    return new Response(null, {
        status: 302,
        headers: {
            location: path,
            ...(isDev ? { 'X-Dev-Status-Message': `Redirect: ${path}` } : {})
        }
    });
}

async function logAssetDenied(input: {
    request: Request;
    authContext: AuthContext;
    reasonCode: string;
    details?: Record<string, JsonValue>;
    statusMessage?: string;
}) {
    await logAuditDenied({
        action: 'PROXY_DENIED',
        reasonCode: input.reasonCode,
        statusMessage: input.statusMessage,
        authContext: input.authContext,
        ...(input.details ? { changes: input.details } : {}),
        executionContext: {
            surface: 'http',
            operation: 'GET /api/proxy',
            request: input.request
        }
    });
}

function isHttpUrl(value: string): boolean {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

function getAncestorOrigin(request: Request): string | null {
    const referer = request.headers.get('referer');
    const origin = request.headers.get('origin');
    try {
        if (referer) return new URL(referer).origin;
    } catch {}
    try {
        if (origin) return new URL(origin).origin;
    } catch {}
    return null;
}

function getAllowedReferrers(request: Request): string[] {
    const host =
        request.headers.get('host') ??
        request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ??
        new URL(request.url).host;
    return [...PROXY_ALLOWED_REFERRERS, `http://${host}`, `https://${host}`];
}

function isAllowedReferrer(rawValue: string | null, allowlist: string[]): boolean {
    if (!rawValue) return false;
    try {
        const valueUrl = new URL(rawValue);
        return allowlist.some((allowed) => {
            if (allowed.includes('://')) {
                return rawValue.startsWith(allowed);
            }
            return valueUrl.host === allowed || valueUrl.hostname === allowed;
        });
    } catch {
        return false;
    }
}

function parseFrameAncestors(csp: string): string[] | null {
    const parts = csp.split(';').map((p) => p.trim());
    const directive = parts.find((p) => p.toLowerCase().startsWith('frame-ancestors'));
    if (!directive) return null;
    return directive
        .split(/\s+/)
        .slice(1)
        .map((v) => v.trim())
        .filter(Boolean);
}

function tokenAllowsAncestor(token: string, ancestorOrigin: string, targetOrigin: string): boolean {
    const t = token.toLowerCase();
    if (t === '*') return true;
    if (t === "'none'") return false;
    if (t === "'self'") return ancestorOrigin === targetOrigin;
    if (t === "'unsafe-inline'" || t === "'unsafe-eval'") return false;
    if (t.endsWith(':') && !t.includes('/')) {
        return ancestorOrigin.startsWith(t);
    }
    try {
        return new URL(token).origin === ancestorOrigin;
    } catch {
        return false;
    }
}

function wouldRejectFraming(
    headers: Headers,
    targetUrl: string,
    ancestorOrigin: string | null
): { reject: boolean; reason?: string } {
    const xfo = (headers.get('x-frame-options') ?? '').toLowerCase();
    const csp = headers.get('content-security-policy') ?? '';
    const targetOrigin = new URL(targetUrl).origin;

    if (xfo.includes('deny')) {
        return { reject: true, reason: 'x-frame-options=DENY' };
    }
    if (xfo.includes('sameorigin')) {
        if (!ancestorOrigin || ancestorOrigin !== targetOrigin) {
            return { reject: true, reason: 'x-frame-options=SAMEORIGIN' };
        }
    }

    const allowFromMatch = xfo.match(/allow-from\s+([^\s]+)/i);
    if (allowFromMatch?.[1]) {
        try {
            const allowedOrigin = new URL(allowFromMatch[1]).origin;
            if (!ancestorOrigin || ancestorOrigin !== allowedOrigin) {
                return { reject: true, reason: 'x-frame-options=ALLOW-FROM mismatch' };
            }
        } catch {
            return { reject: true, reason: 'x-frame-options=ALLOW-FROM invalid' };
        }
    }

    const frameAncestors = parseFrameAncestors(csp);
    if (frameAncestors && frameAncestors.length > 0) {
        if (!ancestorOrigin) {
            return { reject: true, reason: 'csp frame-ancestors present; unknown ancestor origin' };
        }
        const allowed = frameAncestors.some((token) =>
            tokenAllowsAncestor(token, ancestorOrigin, targetOrigin)
        );
        if (!allowed) {
            return { reject: true, reason: 'csp frame-ancestors blocks this ancestor' };
        }
    }

    return { reject: false };
}

function ensureBaseTag(html: string, upstreamUrl: string): string {
    const baseTag = `<base href="${upstreamUrl.replaceAll('"', '&quot;')}">`;
    if (/<base\b[^>]*>/i.test(html)) {
        return html.replace(/<base\b[^>]*>/i, baseTag);
    }
    if (/<head\b[^>]*>/i.test(html)) {
        return html.replace(/<head\b[^>]*>/i, (m) => `${m}${baseTag}`);
    }
    if (/<html\b[^>]*>/i.test(html)) {
        return html.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${baseTag}</head>`);
    }
    return `<head>${baseTag}</head>${html}`;
}

function rewriteHtml(html: string, upstreamUrl: string): string {
    return ensureBaseTag(html, upstreamUrl);
}

async function readWithCap(response: Response, maxBytes: number): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const decoder = new TextDecoder();
    let total = 0;
    let out = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
            throw new Error(`__proxy_too_large__:${maxBytes}`);
        }
        out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
}

export const Route = createFileRoute('/api/proxy')({
    server: {
        handlers: {
            GET: async ({ request, context }: { request: Request; context?: unknown }) => {
                const upstream = (context ?? {}) as {
                    authContext?: AuthContext;
                };

                let authContext =
                    upstream.authContext ?? (await resolveRequestAuthContext(request)).authContext;

                if (!authContext.device) {
                    const mediaCookieDevice = await resolveWallMediaCookieAuthContext(request);
                    if (mediaCookieDevice) {
                        authContext = {
                            ...authContext,
                            guest: undefined,
                            device: mediaCookieDevice
                        };
                    }
                }

                if (authContext.device?.kind !== 'wall') {
                    await logAssetDenied({
                        request,
                        authContext,
                        reasonCode: 'WALL_DEVICE_REQUIRED',
                        statusMessage: 'Redirect: /web-nonet?l=wall'
                    });
                    return redirectTo('/web-nonet?l=wall');
                }

                const requestUrl = new URL(request.url);
                const check = requestUrl.searchParams.get('check');
                const checkOnly = check === '1' || check === 'true';
                const rawUrl = requestUrl.searchParams.get('url') ?? '';
                if (!rawUrl || !isHttpUrl(rawUrl)) {
                    if (checkOnly) {
                        return Response.json(
                            { ok: false, reason: 'invalid_url', fallback: '/web-nonet?l=wall' },
                            {
                                status: 200,
                                headers: isDev
                                    ? { 'X-Dev-Status-Message': 'Invalid URL' }
                                    : undefined
                            }
                        );
                    }
                    return redirectTo('/web-nonet?l=wall');
                }

                const allowlist = getAllowedReferrers(request);
                const referer = request.headers.get('referer');
                const origin = request.headers.get('origin');
                const allowed =
                    isAllowedReferrer(referer ?? null, allowlist) ||
                    isAllowedReferrer(origin ?? null, allowlist);

                if (!allowed && !PROXY_ALLOW_MISSING_REFERRER) {
                    await logAssetDenied({
                        request,
                        authContext,
                        reasonCode: 'FORBIDDEN_ORIGIN',
                        statusMessage: 'Forbidden Origin',
                        details: {
                            referer: referer ?? null,
                            origin: origin ?? null
                        }
                    });
                    if (checkOnly) {
                        return Response.json(
                            {
                                ok: false,
                                reason: 'forbidden_origin',
                                fallback: '/web-nonet?l=wall'
                            },
                            {
                                status: 200,
                                headers: isDev
                                    ? { 'X-Dev-Status-Message': 'Forbidden Origin' }
                                    : undefined
                            }
                        );
                    }
                    return redirectTo('/web-nonet?l=wall');
                }

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), PROXY_FETCH_TIMEOUT_MS);

                try {
                    // Intentionally do NOT forward caller cookies/auth headers to upstream.
                    // This keeps wall/session credentials scoped to this app only.
                    const upstreamResponse = await fetch(rawUrl, {
                        redirect: 'follow',
                        signal: controller.signal,
                        headers: {
                            'user-agent': 'vizzy-wall-proxy/1.0',
                            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'
                        }
                    });

                    if (!upstreamResponse.ok) {
                        await logAuditFailure({
                            action: 'PROXY_FETCH_FAILED',
                            reasonCode: `UPSTREAM_HTTP_${upstreamResponse.status}`,
                            statusMessage: `Upstream Status ${upstreamResponse.status}`,
                            authContext,
                            executionContext: {
                                surface: 'http',
                                operation: 'GET /api/proxy',
                                request
                            }
                        });
                        if (checkOnly) {
                            return Response.json(
                                {
                                    ok: false,
                                    reason: `upstream_status_${upstreamResponse.status}`,
                                    fallback: '/web-nonet?l=wall'
                                },
                                {
                                    status: 200,
                                    headers: isDev
                                        ? {
                                              'X-Dev-Status-Message': `Upstream Status ${upstreamResponse.status}`
                                          }
                                        : undefined
                                }
                            );
                        }
                        return redirectTo('/web-nonet?l=wall');
                    }

                    if (checkOnly) {
                        const framing = wouldRejectFraming(
                            upstreamResponse.headers,
                            upstreamResponse.url || rawUrl,
                            getAncestorOrigin(request)
                        );
                        if (framing.reject) {
                            await logAuditFailure({
                                action: 'PROXY_FRAME_CHECK_FAILED',
                                reasonCode: 'FRAME_BLOCKED',
                                statusMessage: framing.reason ?? 'Frame Blocked',
                                authContext,
                                executionContext: {
                                    surface: 'http',
                                    operation: 'GET /api/proxy',
                                    request
                                }
                            });
                            return Response.json(
                                {
                                    ok: false,
                                    reason: framing.reason ?? 'frame_blocked',
                                    fallback: '/web-corsissue?l=wall'
                                },
                                {
                                    status: 200,
                                    headers: isDev
                                        ? {
                                              'X-Dev-Status-Message':
                                                  framing.reason ?? 'Frame Blocked'
                                          }
                                        : undefined
                                }
                            );
                        }
                        await logAuditSuccess({
                            action: 'PROXY_FRAME_CHECK_PASSED',
                            authContext,
                            executionContext: {
                                surface: 'http',
                                operation: 'GET /api/proxy',
                                request
                            }
                        });
                        return Response.json({ ok: true }, { status: 200 });
                    }

                    const contentType = upstreamResponse.headers.get('content-type') ?? '';
                    const isHtmlLike =
                        contentType.includes('text/html') ||
                        contentType.includes('application/xhtml+xml') ||
                        contentType === '';
                    if (!isHtmlLike) {
                        await logAuditFailure({
                            action: 'PROXY_CONTENT_TYPE_REJECTED',
                            reasonCode: 'NON_HTML_CONTENT',
                            authContext,
                            executionContext: {
                                surface: 'http',
                                operation: 'GET /api/proxy',
                                request
                            }
                        });
                        return redirectTo('/web-nonet?l=wall');
                    }

                    const sourceHtml = await readWithCap(upstreamResponse, PROXY_MAX_BYTES);
                    const rewritten = rewriteHtml(sourceHtml, upstreamResponse.url || rawUrl);
                    await logAuditSuccess({
                        action: 'PROXY_FETCH_SUCCEEDED',
                        authContext,
                        executionContext: {
                            surface: 'http',
                            operation: 'GET /api/proxy',
                            request
                        }
                    });

                    // Intentionally return a strict header allowlist only.
                    // Do not relay upstream response headers such as Set-Cookie/CSP/XFO.
                    return new Response(rewritten, {
                        status: 200,
                        headers: {
                            'content-type': 'text/html; charset=utf-8',
                            'cache-control': 'no-store',
                            'x-content-type-options': 'nosniff'
                        }
                    });
                } catch {
                    await logAuditFailure({
                        action: 'PROXY_FETCH_FAILED',
                        reasonCode: 'NETWORK_ERROR',
                        statusMessage: 'Network Error',
                        authContext,
                        executionContext: {
                            surface: 'http',
                            operation: 'GET /api/proxy',
                            request
                        }
                    });
                    if (checkOnly) {
                        return Response.json(
                            { ok: false, reason: 'network_error', fallback: '/web-nonet?l=wall' },
                            {
                                status: 200,
                                headers: isDev
                                    ? { 'X-Dev-Status-Message': 'Network Error' }
                                    : undefined
                            }
                        );
                    }
                    return redirectTo('/web-nonet?l=wall');
                } finally {
                    clearTimeout(timeout);
                }
            }
        }
    }
});
