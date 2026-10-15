import { env } from '@repo/env';
import { createFileRoute } from '@tanstack/react-router';

import { isCustomProject } from '~/lib/customProject';
import { validatePortalToken } from '~/lib/portalTokens';
import { buildServeUpstreamUrl, parseServePath } from '~/lib/serveUrls';
import { logAuditDenied, logAuditFailure, logAuditSuccess } from '~/server/audit';
import { getProject } from '~/server/projects';
import type { AuthContext } from '~/server/requestAuthContext';
import { resolveRequestAuthContext } from '~/server/requestAuthContext';
import { createServeCookie, resolveServeCookieActor, type ServeActor } from '~/server/serveCookie';
import { resolveWallMediaCookieAuthContext } from '~/server/wallMediaCookie';

const SERVE_FETCH_TIMEOUT_MS = Number(process.env.SERVE_FETCH_TIMEOUT_MS ?? 30_000);

/**
 * Headers forwarded to the demo. Our own credentials are deliberately absent: the demo is
 * third-party code and must never see a session, wall or serve cookie.
 */
const FORWARDED_REQUEST_HEADERS = [
    'accept',
    'accept-language',
    'content-type',
    'range',
    'if-none-match',
    'if-modified-since',
    'user-agent'
];

/**
 * Headers relayed back. `set-cookie`, CSP and `x-frame-options` are dropped — upstream must
 * not set cookies or framing policy on our origin. `content-encoding` and `content-length`
 * are dropped too: fetch decompresses the body transparently, so upstream's values would
 * describe bytes the browser never receives.
 */
const RELAYED_RESPONSE_HEADERS = [
    'content-type',
    'cache-control',
    'etag',
    'last-modified',
    'content-range',
    'accept-ranges',
    'vary'
];

function bearerOrQueryToken(request: Request): string | null {
    const auth = request.headers.get('authorization');
    if (auth?.toLowerCase().startsWith('bearer ')) {
        const token = auth.slice(7).trim();
        if (token.length > 0) return token;
    }
    const params = new URL(request.url).searchParams;
    const queryToken = params.get('_viz_t')?.trim() ?? params.get('_gem_t')?.trim();
    return queryToken && queryToken.length > 0 ? queryToken : null;
}

/**
 * The surface is decided by which credential succeeds, not by the path. Both surfaces load
 * the same bundles, so cross-checking the path would reject a control iframe's assets.
 */
async function authorizeFreshRequest(request: Request): Promise<ServeActor | null> {
    const token = bearerOrQueryToken(request);
    if (token) {
        const validated = validatePortalToken(token, 'control');
        if (validated) return { surface: 'control', wallId: validated.wallId };
    }

    const { authContext } = await resolveRequestAuthContext(request);
    let device: AuthContext['device'] = authContext.device;
    if (!device) {
        device = (await resolveWallMediaCookieAuthContext(request)) ?? undefined;
    }
    if (device?.kind === 'wall' && device.wallId) {
        return { surface: 'wall', wallId: device.wallId };
    }

    return null;
}

function buildForwardedHeaders(request: Request): Headers {
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
    }

    const forwardedFor = request.headers.get('x-forwarded-for');
    const url = new URL(request.url);
    if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
    headers.set('x-forwarded-host', request.headers.get('host') ?? url.host);

    return headers;
}

function buildRelayedHeaders(upstream: Response): Headers {
    const headers = new Headers();
    for (const name of RELAYED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) headers.set(name, value);
    }
    return headers;
}

/** Keeps a redirect inside our origin so the demos VM's address is never disclosed. */
function rewriteLocation(location: string, upstreamOrigin: string): string {
    try {
        const resolved = new URL(location, upstreamOrigin);
        if (resolved.origin !== upstreamOrigin) return '/';
        return `${resolved.pathname}${resolved.search}${resolved.hash}`;
    } catch {
        return '/';
    }
}

function notFound(): Response {
    return new Response('Not found', { status: 404 });
}

async function handler({ request }: { request: Request }): Promise<Response> {
    const url = new URL(request.url);
    const parsed = parseServePath(url.pathname);
    if (!parsed) return notFound();

    const { projectId } = parsed;
    const project = await getProject(projectId).catch(() => null);
    if (!project || !isCustomProject(project)) return notFound();

    const port = project.customPort;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
        await logAuditFailure({
            action: 'SERVE_PROXY_FAILED',
            reasonCode: 'CUSTOM_PORT_NOT_CONFIGURED',
            resourceType: 'project',
            resourceId: projectId,
            executionContext: {
                surface: 'http',
                operation: `${request.method} /serve/$projectId/$`,
                request
            }
        });
        return new Response('Custom project has no port configured', { status: 503 });
    }

    let actor = resolveServeCookieActor(request, projectId);
    let mintCookie = false;

    if (!actor) {
        actor = await authorizeFreshRequest(request);
        if (!actor) {
            await logAuditDenied({
                action: 'SERVE_DENIED',
                reasonCode: 'NO_WALL_DEVICE_OR_CONTROL_TOKEN',
                resourceType: 'project',
                resourceId: projectId,
                authContext: { guest: true },
                executionContext: {
                    surface: 'http',
                    operation: `${request.method} /serve/$projectId/$`,
                    request
                }
            });
            return new Response('Forbidden', { status: 403 });
        }
        mintCookie = true;
    }

    const upstreamUrl = buildServeUpstreamUrl({
        host: env.DEMOS_FQDN,
        port,
        pathname: url.pathname,
        search: url.search
    });

    let upstream: Response;
    try {
        upstream = await fetch(upstreamUrl, {
            method: request.method,
            headers: buildForwardedHeaders(request),
            body: request.body,
            // Streams the request body instead of buffering it.
            duplex: 'half',
            redirect: 'manual',
            signal: AbortSignal.timeout(SERVE_FETCH_TIMEOUT_MS)
        } as RequestInit & { duplex: 'half' });
    } catch {
        await logAuditFailure({
            action: 'SERVE_PROXY_FAILED',
            reasonCode: 'UPSTREAM_UNREACHABLE',
            resourceType: 'project',
            resourceId: projectId,
            executionContext: {
                surface: 'http',
                operation: `${request.method} /serve/$projectId/$`,
                request
            }
        });
        return new Response('Demo unavailable', { status: 502 });
    }

    const headers = buildRelayedHeaders(upstream);

    const location = upstream.headers.get('location');
    if (location) {
        headers.set('location', rewriteLocation(location, `http://${env.DEMOS_FQDN}:${port}`));
    }

    if (mintCookie) {
        headers.append('set-cookie', createServeCookie({ request, projectId, actor }));
        // Logged on first authorisation only — every asset the demo loads would otherwise
        // write an audit row.
        await logAuditSuccess({
            action: 'SERVE_AUTHORIZED',
            resourceType: 'project',
            resourceId: projectId,
            changes: { surface: actor.surface, wallId: actor.wallId },
            executionContext: {
                surface: 'http',
                operation: `${request.method} /serve/$projectId/$`,
                request
            }
        });
    }

    return new Response(upstream.body, { status: upstream.status, headers });
}

export const Route = createFileRoute('/serve/$projectId/$')({
    server: {
        handlers: {
            GET: handler,
            HEAD: handler,
            POST: handler,
            PUT: handler,
            PATCH: handler,
            DELETE: handler,
            OPTIONS: handler
        }
    }
});
