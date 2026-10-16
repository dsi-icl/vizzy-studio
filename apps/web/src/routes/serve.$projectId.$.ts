import { env } from '@repo/env';
import { createFileRoute } from '@tanstack/react-router';

import { isCustomProject } from '~/lib/customProject';
import { buildForwardedHeaders, buildRelayedHeaders } from '~/lib/serveHeaders';
import {
    buildServeUpstreamUrl,
    parseServePath,
    parseServeSessionPath,
    resolveDemoHost,
    rewriteServeLocation,
    serveBasePath,
    serveSessionBasePath,
    upstreamPathname
} from '~/lib/serveUrls';
import { logAuditDenied, logAuditFailure } from '~/server/audit';
import { getProject } from '~/server/projects';
import { isWallBoundToProject } from '~/server/serveAuthz';
import {
    createServeCookie,
    resolveServeCookieActor,
    shouldRefreshServeCookie,
    type ServeActor
} from '~/server/serveCookie';
import { consumeServeLaunch } from '~/server/serveLaunch';
import { getServeOrigin, isServeOriginRequest } from '~/server/serveOrigin';
import {
    isWebSocketUpgrade,
    resolveServeWebSocketUpstream,
    serveWebSocketHooks
} from '~/server/serveWebSocket';

const SERVE_FETCH_TIMEOUT_MS = Number(process.env.SERVE_FETCH_TIMEOUT_MS ?? 30_000);
const KEEPALIVE_GIF = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64');

function actorIsLive(actor: ServeActor, projectId: string): boolean {
    if (actor.surface === 'wall' || actor.surface === 'control') {
        return isWallBoundToProject(actor.wallId, projectId, actor.scopeId, actor.bindingId);
    }
    return true;
}

function notFound(): Response {
    return new Response('Not found', { status: 404 });
}

export async function handleServeRequest(request: Request): Promise<Response> {
    if (!isServeOriginRequest(request)) return notFound();
    const serveOrigin = getServeOrigin()!;
    const url = new URL(request.url);
    const parsed = parseServePath(url.pathname);
    if (!parsed) return notFound();

    if (parsed.rest === '/_launch') {
        if (request.method !== 'GET' || isWebSocketUpgrade(request))
            return new Response('Method not allowed', { status: 405 });
        const ticket = url.searchParams.get('ticket') ?? '';
        const launch = await consumeServeLaunch(ticket);
        if (
            !launch ||
            launch.projectId !== parsed.projectId ||
            !actorIsLive(launch.actor, parsed.projectId)
        ) {
            return new Response('Invalid demo launch', { status: 401 });
        }
        const project = await getProject(parsed.projectId).catch(() => null);
        if (!project || !isCustomProject(project)) return notFound();
        const base = serveSessionBasePath(parsed.projectId, launch.routeId);
        const destination = new URL(`${base}/${launch.entry}`, serveOrigin);
        if (launch.entry === 'screen') {
            for (const name of ['c', 'r']) {
                const value = url.searchParams.get(name);
                if (value && /^\d{1,3}$/.test(value)) destination.searchParams.set(name, value);
            }
        } else if (launch.actor.surface === 'control') {
            destination.searchParams.set('l', 'gallery');
            destination.searchParams.set('w', launch.actor.wallId);
        }
        return new Response(null, {
            status: 303,
            headers: {
                Location: `${destination.pathname}${destination.search}`,
                'Set-Cookie': createServeCookie({
                    request,
                    projectId: parsed.projectId,
                    routeId: launch.routeId,
                    actor: launch.actor
                }),
                'Cache-Control': 'no-store',
                'Referrer-Policy': 'no-referrer'
            }
        });
    }

    if (isWebSocketUpgrade(request)) {
        if (
            request.headers.get('origin') !== serveOrigin.origin ||
            !(await resolveServeWebSocketUpstream(request))
        ) {
            return new Response('Forbidden', { status: 403 });
        }
        return Object.assign(new Response('WebSocket upgrade is required.', { status: 426 }), {
            crossws: serveWebSocketHooks
        });
    }

    if (
        !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
        request.headers.get('origin') !== serveOrigin.origin
    ) {
        return new Response('Forbidden', { status: 403 });
    }
    const session = parseServeSessionPath(url.pathname);
    if (!session) return notFound();
    const { projectId, routeId } = session;
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

    const actor = resolveServeCookieActor(request, projectId, routeId);
    if (!actor || !actorIsLive(actor, projectId)) {
        await logAuditDenied({
            action: 'SERVE_DENIED',
            reasonCode: 'NOT_BOUND_OR_NO_CREDENTIAL',
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
    const mintCookie = shouldRefreshServeCookie(actor);

    if (session.rest === '/_keepalive') {
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
        return new Response(KEEPALIVE_GIF, {
            headers: {
                'Content-Type': 'image/gif',
                'Cache-Control': 'private, no-store',
                'Referrer-Policy': 'no-referrer',
                ...(!actor.surface.startsWith('preview-')
                    ? { 'Set-Cookie': createServeCookie({ request, projectId, routeId, actor }) }
                    : {})
            }
        });
    }

    const upstreamPath = `${serveBasePath(projectId)}${session.rest}`;

    const host = resolveDemoHost(env.DEMOS_HOSTS, project.customHost);
    if (!host) {
        await logAuditFailure({
            action: 'SERVE_PROXY_FAILED',
            reasonCode: 'DEMO_HOST_NOT_ALLOWED',
            resourceType: 'project',
            resourceId: projectId,
            executionContext: {
                surface: 'http',
                operation: `${request.method} /serve/$projectId/$`,
                request
            }
        });
        return new Response('Demo host is not configured', { status: 503 });
    }

    const upstreamUrl = buildServeUpstreamUrl({
        host,
        port,
        pathname: upstreamPathname(
            { projectId, rest: session.rest },
            upstreamPath,
            project.customStripPrefix
        ),
        search: url.search
    });

    let upstream: Response;
    try {
        upstream = await fetch(upstreamUrl, {
            method: request.method,
            headers: buildForwardedHeaders(
                request,
                actor,
                serveSessionBasePath(projectId, routeId)
            ),
            body: request.body,
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
    headers.set('Cache-Control', 'private, no-store');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    if (upstream.headers.get('content-type')?.toLowerCase().includes('text/html')) {
        headers.set(
            'Content-Security-Policy',
            `default-src 'self' data: blob: https:; connect-src 'self' ws: wss: https:; base-uri 'self'; object-src 'none'; frame-ancestors ${new URL(env.VITE_BASE_URL).origin}`
        );
    }

    const location = upstream.headers.get('location');
    if (location) {
        const rewritten = rewriteServeLocation(
            location,
            upstreamUrl,
            serveBasePath(projectId),
            serveSessionBasePath(projectId, routeId)
        );
        if (rewritten === null) {
            await logAuditFailure({
                action: 'SERVE_PROXY_FAILED',
                reasonCode: 'INVALID_UPSTREAM_LOCATION',
                resourceType: 'project',
                resourceId: projectId,
                executionContext: {
                    surface: 'http',
                    operation: `${request.method} /serve/$projectId/$`,
                    request
                }
            });
            return new Response('Demo sent an invalid redirect', { status: 502 });
        }
        headers.set('location', rewritten);
    }

    if (mintCookie) {
        headers.append('set-cookie', createServeCookie({ request, projectId, routeId, actor }));
    }

    return new Response(upstream.body, { status: upstream.status, headers });
}

const handler = ({ request }: { request: Request }) => handleServeRequest(request);

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
