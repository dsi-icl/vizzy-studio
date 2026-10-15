import '@tanstack/react-start/server-only';
import { env } from '@repo/env';
import { createWebSocketProxy, type Hooks, type Peer } from 'crossws';

import { scopedState, wallBindings } from '~/lib/busState';
import {
    directDemoPath,
    isAllowedDemoPath,
    parseDemoLaunchPath,
    parseDirectDemoUpstreams,
    safeDemoRedirect
} from '~/lib/demoGatewayPaths';
import {
    consumeDemoLaunch,
    getDemoSession,
    issueDemoSession,
    type DemoGrant
} from '~/lib/demoGatewaySessions';

const UPSTREAM_TIMEOUT_MS = 15_000;
// The demos Nginx allows a 60 s cache lock plus 120 s proxy read for tiles,
// and a 300 s proxy read for do-image. These are header wait limits only:
// once streaming starts, a fixed total deadline would cut off valid responses.
const TILE_HEADER_TIMEOUT_MS = 210_000;
const DO_IMAGE_HEADER_TIMEOUT_MS = 360_000;
const directUpstreams = parseDirectDemoUpstreams(env.SERVER_DEMO_GATEWAY_DIRECT_UPSTREAMS);
const REQUEST_HEADERS = [
    'accept',
    'accept-encoding',
    'accept-language',
    'cache-control',
    'content-type',
    'if-match',
    'if-modified-since',
    'if-none-match',
    'if-unmodified-since',
    'range'
];
const BLOCKED_RESPONSE_HEADERS = new Set([
    'connection',
    'content-encoding',
    'content-length',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'set-cookie',
    'transfer-encoding',
    'upgrade'
]);

function response(status: number, message: string): Response {
    return new Response(message, {
        status,
        headers: {
            'Cache-Control': 'no-store',
            'Content-Type': 'text/plain; charset=utf-8',
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff'
        }
    });
}

function extendedHeaderTimeoutMs(pathname: string): number | null {
    if (pathname === '/tiles' || pathname.startsWith('/tiles/')) {
        return TILE_HEADER_TIMEOUT_MS;
    }
    if (pathname === '/do-image' || pathname.startsWith('/do-image/')) {
        return DO_IMAGE_HEADER_TIMEOUT_MS;
    }
    return null;
}

function configuredOrigin(raw: string): URL | null {
    try {
        const url = new URL(raw);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
            return null;
        }
        return url;
    } catch {
        return null;
    }
}

function sessionCookieName(publicOrigin: URL): string {
    return publicOrigin.protocol === 'https:' ? '__Host-vizzy_demo_session' : 'vizzy_demo_session';
}

function readCookie(request: Request, name: string): string | null {
    for (const part of (request.headers.get('cookie') ?? '').split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
        const value = part.slice(separator + 1).trim();
        return value.length <= 256 ? value : null;
    }
    return null;
}

function demoCookies(request: Request, reservedName: string): string | null {
    const parts = (request.headers.get('cookie') ?? '')
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part && part.split('=')[0]?.trim() !== reservedName);
    return parts.length ? parts.join('; ') : null;
}

function grantIsLive(grant: DemoGrant): boolean {
    if (grant.access === 'admin-preview') return true;
    return (
        wallBindings.get(grant.wallId) === grant.scopeId &&
        scopedState.get(grant.scopeId)?.projectId === grant.projectId
    );
}

function requestHost(request: Request): string {
    return request.headers.get('host') ?? new URL(request.url).host;
}

function isSafePath(pathname: string): boolean {
    if (pathname.length > 4_096 || pathname.includes('\\')) return false;
    try {
        return pathname.split('/').every((segment) => {
            const decoded = decodeURIComponent(segment);
            const hasControlCharacter = Array.from(decoded).some((character) => {
                const code = character.charCodeAt(0);
                return code < 32 || code === 127;
            });
            return (
                decoded !== '.' &&
                decoded !== '..' &&
                !decoded.includes('/') &&
                !decoded.includes('\\') &&
                !hasControlCharacter
            );
        });
    } catch {
        return false;
    }
}

function safeOrigin(request: Request, publicOrigin: URL): boolean {
    const origin = request.headers.get('origin');
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        return origin === publicOrigin.origin;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        return origin === publicOrigin.origin;
    }
    return !origin || origin === publicOrigin.origin;
}

function upstreamHeaders(request: Request, publicOrigin: URL, grant: DemoGrant): Headers {
    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
    }
    const cookies = demoCookies(request, sessionCookieName(publicOrigin));
    if (cookies) headers.set('Cookie', cookies);
    if (request.headers.get('origin') === publicOrigin.origin) {
        headers.set('Origin', publicOrigin.origin);
    }
    // The demos Nginx selects its shared /api, /ws and /bus upstream by Referer.
    headers.set('Host', publicOrigin.host);
    headers.set('Referer', `${publicOrigin.origin}/${grant.slug}/`);
    return headers;
}

function safeSetCookie(raw: string, reservedName: string, secure: boolean): string | null {
    const attributes = raw.split(';').map((part) => part.trim());
    const name = attributes[0]?.split('=')[0]?.trim();
    if (!name || name.toLowerCase() === reservedName.toLowerCase()) return null;
    const filtered = attributes.filter((part, index) => index === 0 || !/^domain=/i.test(part));
    if (secure && !filtered.some((part) => /^secure$/i.test(part))) filtered.push('Secure');
    return filtered.join('; ');
}

function copyResponseHeaders(upstream: Response, publicOrigin: URL): Headers {
    const headers = new Headers();
    for (const [name, value] of upstream.headers) {
        const lower = name.toLowerCase();
        if (BLOCKED_RESPONSE_HEADERS.has(lower) || lower.startsWith('access-control-')) continue;
        headers.set(name, value);
    }
    for (const raw of upstream.headers.getSetCookie()) {
        const cookie = safeSetCookie(
            raw,
            sessionCookieName(publicOrigin),
            publicOrigin.protocol === 'https:'
        );
        if (cookie) headers.append('Set-Cookie', cookie);
    }
    headers.set('Cache-Control', 'private, no-store');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    return headers;
}

function websocketResponse(
    request: Request,
    publicOrigin: URL,
    upstreamOrigin: URL,
    upstreamPath: string,
    grant: DemoGrant,
    sessionToken: string
): Response {
    const target = new URL(`${upstreamPath}${new URL(request.url).search}`, upstreamOrigin);
    target.protocol = upstreamOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
    target.host = upstreamOrigin.host;
    const proxy = createWebSocketProxy({
        target,
        headers: {
            Host: publicOrigin.host,
            Origin: publicOrigin.origin,
            Referer: `${publicOrigin.origin}/${grant.slug}/`,
            ...(demoCookies(request, sessionCookieName(publicOrigin))
                ? { Cookie: demoCookies(request, sessionCookieName(publicOrigin))! }
                : {})
        }
    });
    const timers = new Map<string, ReturnType<typeof setInterval>>();
    const hooks: Partial<Hooks> = {
        ...proxy,
        open(peer: Peer) {
            proxy.open?.(peer);
            const timer = setInterval(() => {
                if (!getDemoSession(sessionToken) || !grantIsLive(grant)) {
                    clearInterval(timer);
                    peer.close(1008, 'Demo session ended');
                }
            }, 5_000);
            timers.set(peer.id, timer);
        },
        close(peer, details) {
            const timer = timers.get(peer.id);
            if (timer) clearInterval(timer);
            timers.delete(peer.id);
            proxy.close?.(peer, details);
        }
    };
    return Object.assign(new Response(null, { status: 426 }), { crossws: hooks });
}

export async function handleDemoGatewayRequest(request: Request): Promise<Response | null> {
    const publicOrigin = configuredOrigin(env.SERVER_DEMO_GATEWAY_SOURCE_ORIGIN);
    const upstreamOrigin = configuredOrigin(env.SERVER_DEMO_GATEWAY_UPSTREAM_ORIGIN);
    if (!publicOrigin || requestHost(request) !== publicOrigin.host) return null;
    if (!directUpstreams || (!upstreamOrigin && directUpstreams.size === 0)) {
        return response(503, 'Demo gateway is not configured');
    }
    if (env.SERVER_DEMO_GATEWAY_UPSTREAM_ORIGIN && !upstreamOrigin) {
        return response(503, 'Demo gateway is not configured');
    }

    const url = new URL(request.url);
    if (!isSafePath(url.pathname)) return response(404, 'Demo path not found');

    if (url.pathname === '/_vizzy/gateway-health') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return response(405, 'Health check requires GET or HEAD');
        }
        return response(200, 'OK');
    }

    if (url.pathname.startsWith('/_vizzy/')) {
        const launch = parseDemoLaunchPath(url.pathname);
        if (!launch) return response(404, 'Demo launch not found');
        if (request.method !== 'GET' || request.headers.has('upgrade')) {
            return response(405, 'Demo launch requires GET');
        }
        const ticket = url.searchParams.get('ticket') ?? '';
        if (!ticket || ticket.length > 256) return response(401, 'Demo launch ticket is invalid');
        const grant = consumeDemoLaunch(ticket);
        if (
            !grant ||
            !grantIsLive(grant) ||
            grant.projectId !== launch.projectId ||
            grant.kind !== launch.kind
        ) {
            return response(401, 'Demo launch ticket is invalid or expired');
        }
        if (!directUpstreams.has(grant.slug) && !upstreamOrigin) {
            return response(503, 'Demo upstream is not configured');
        }
        const session = issueDemoSession(grant);
        const destination = new URL(grant.entryPath, publicOrigin);
        if (grant.kind === 'controller' && grant.access === 'wall') {
            destination.searchParams.set('l', 'gallery');
            destination.searchParams.set('w', grant.wallId);
        } else if (grant.kind === 'screen') {
            for (const name of ['c', 'r']) {
                const value = url.searchParams.get(name);
                if (value && /^\d{1,3}$/.test(value)) destination.searchParams.set(name, value);
            }
        }
        return new Response(null, {
            status: 303,
            headers: {
                Location: `${destination.pathname}${destination.search}`,
                'Set-Cookie': `${sessionCookieName(publicOrigin)}=${session.token}; Path=/; HttpOnly; ${publicOrigin.protocol === 'https:' ? 'Secure; ' : ''}SameSite=Lax`,
                'Cache-Control': 'no-store',
                'Referrer-Policy': 'no-referrer'
            }
        });
    }

    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)) {
        return response(405, 'Method not allowed');
    }
    if (!safeOrigin(request, publicOrigin)) return response(403, 'Demo origin is not allowed');
    const sessionToken = readCookie(request, sessionCookieName(publicOrigin));
    const grant = sessionToken ? getDemoSession(sessionToken) : null;
    if (!grant || !grantIsLive(grant)) return response(401, 'Demo session is missing or expired');
    if (!isAllowedDemoPath(url.pathname, grant.slug)) return response(404, 'Demo path not found');
    const directRoute = directUpstreams.get(grant.slug);
    const selectedOrigin = directRoute?.origin ?? upstreamOrigin;
    if (!selectedOrigin || selectedOrigin.origin === publicOrigin.origin) {
        return response(503, 'Demo upstream is not configured');
    }
    const upstreamPath = directRoute
        ? directDemoPath(url.pathname, grant.slug, directRoute)
        : url.pathname;

    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        return websocketResponse(
            request,
            publicOrigin,
            selectedOrigin,
            upstreamPath,
            grant,
            sessionToken!
        );
    }
    if (request.headers.has('upgrade')) return response(426, 'Unsupported upgrade');

    const target = new URL(`${upstreamPath}${url.search}`, selectedOrigin);
    const headerTimeoutMs = extendedHeaderTimeoutMs(url.pathname);
    const headerAbort = headerTimeoutMs === null ? null : new AbortController();
    const headerTimer =
        headerAbort && headerTimeoutMs !== null
            ? setTimeout(() => headerAbort.abort(), headerTimeoutMs)
            : null;
    const init: RequestInit & { duplex?: 'half' } = {
        method: request.method,
        headers: upstreamHeaders(request, publicOrigin, grant),
        redirect: 'manual',
        signal: headerAbort?.signal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    };
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
        init.body = request.body;
        init.duplex = 'half';
    }
    let upstream: Response;
    try {
        upstream = await fetch(target, init);
    } catch {
        return response(502, 'Demo upstream is unavailable');
    } finally {
        if (headerTimer) clearTimeout(headerTimer);
    }

    const headers = copyResponseHeaders(upstream, publicOrigin);
    const location = upstream.headers.get('location');
    if (location && upstream.status >= 300 && upstream.status < 400) {
        const safe = safeDemoRedirect(
            location,
            target,
            selectedOrigin,
            publicOrigin,
            grant.slug,
            directRoute
        );
        if (!safe) return response(502, 'Demo redirect left the allowed path');
        headers.set('Location', safe);
    }
    const noBody = request.method === 'HEAD' || [204, 205, 304].includes(upstream.status);
    return new Response(noBody ? null : upstream.body, { status: upstream.status, headers });
}
