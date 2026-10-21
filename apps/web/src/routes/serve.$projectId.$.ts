import { env } from '@repo/env';
import { createFileRoute } from '@tanstack/react-router';

import { isCustomProject } from '~/lib/customProject';
import { buildForwardedHeaders, buildRelayedHeaders } from '~/lib/serveHeaders';
import {
    addServeCorsHeaders,
    isAllowedServeRequest,
    servePreflightResponse
} from '~/lib/serveRequestPolicy';
import {
    buildServeUpstreamUrl,
    parseServePath,
    resolveDemoHost,
    rewriteServeLocation,
    serveBasePath,
    SERVE_SESSION_QUERY_PARAM,
    upstreamPathname
} from '~/lib/serveUrls';
import { logAuditDenied, logAuditFailure } from '~/server/audit';
import { getProject } from '~/server/projects';
import { isWallBoundToProject } from '~/server/serveAuthz';
import {
    createServeCookie,
    resolveServeCookieGrant,
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
const SERVE_SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-same-site-none-cookies';
const SERVE_CONTENT_RESTRICTIONS = "object-src 'none'; base-uri 'self'";

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
    if (!parsed || parsed.rest.startsWith('/s/')) return notFound();

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
        const destination = new URL(
            `${serveBasePath(parsed.projectId)}/${launch.entry}`,
            serveOrigin
        );
        destination.searchParams.set(SERVE_SESSION_QUERY_PARAM, launch.routeId);
        if (launch.entry === 'screen') {
            for (const name of ['c', 'r']) {
                const value = url.searchParams.get(name);
                if (value && /^\d{1,3}$/.test(value)) destination.searchParams.set(name, value);
            }
        } else if (launch.actor.surface === 'control') {
            destination.searchParams.set('l', 'gallery');
            destination.searchParams.set('w', launch.actor.wallId);
        } else if (launch.actor.surface === 'preview') {
            destination.searchParams.set('preview', '1');
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

    if (!isAllowedServeRequest(request, serveOrigin.origin)) {
        return new Response('Forbidden', { status: 403 });
    }

    if (isWebSocketUpgrade(request)) {
        if (
            !['null', serveOrigin.origin].includes(request.headers.get('origin') ?? '') ||
            !(await resolveServeWebSocketUpstream(request))
        ) {
            return new Response('Forbidden', { status: 403 });
        }
        return Object.assign(new Response('WebSocket upgrade is required.', { status: 426 }), {
            crossws: serveWebSocketHooks
        });
    }

    const preflight = servePreflightResponse(request);
    if (preflight) return preflight;
    if (
        !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
        request.headers.get('origin') !== 'null' &&
        request.headers.get('origin') !== serveOrigin.origin
    )
        return new Response('Forbidden', { status: 403 });
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

    const grant = resolveServeCookieGrant(request, projectId, (actor) =>
        actorIsLive(actor, projectId)
    );
    if (!grant) {
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
    const { actor, routeId } = grant;
    const mintCookie = shouldRefreshServeCookie(actor);

    if (parsed.rest === '/_keepalive') {
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
        return new Response(KEEPALIVE_GIF, {
            headers: {
                'Content-Type': 'image/gif',
                'Cache-Control': 'private, no-store',
                'Referrer-Policy': 'same-origin',
                ...(actor.surface !== 'preview'
                    ? { 'Set-Cookie': createServeCookie({ request, projectId, routeId, actor }) }
                    : {})
            }
        });
    }

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

    url.searchParams.delete(SERVE_SESSION_QUERY_PARAM);
    const upstreamUrl = buildServeUpstreamUrl({
        host,
        port,
        pathname: upstreamPathname(parsed, url.pathname, project.customStripPrefix),
        search: url.search
    });

    let upstream: Response;
    try {
        upstream = await fetch(upstreamUrl, {
            method: request.method,
            headers: buildForwardedHeaders(request, actor, serveBasePath(projectId)),
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

    const headers = buildRelayedHeaders(upstream, request);
    headers.set('Cache-Control', 'private, no-store');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    // Any upstream content that a browser treats as a document (HTML, SVG,
    // XML, PDF) must be sandboxed, including direct admin preview tabs.
    // A nested HTML iframe has an opaque-origin demo document as an ancestor.
    // `frame-ancestors 'self'` blocks that iframe, even though it is served
    // from this host. Only relax framing for a session-bound HTML iframe;
    // keep the sandbox and the top-level entry documents unchanged.
    const isNestedHtmlIframe =
        request.method === 'GET' &&
        request.headers.get('sec-fetch-dest') === 'iframe' &&
        parsed.rest.toLowerCase().endsWith('.html') &&
        new URL(request.url).searchParams.get(SERVE_SESSION_QUERY_PARAM) === routeId;
    headers.set(
        'Content-Security-Policy',
        isNestedHtmlIframe
            ? `${SERVE_SANDBOX_CSP}; ${SERVE_CONTENT_RESTRICTIONS}`
            : `${SERVE_SANDBOX_CSP}; frame-ancestors 'self'; ${SERVE_CONTENT_RESTRICTIONS}`
    );
    addServeCorsHeaders(request, headers);

    const location = upstream.headers.get('location');
    if (location) {
        const rewritten = rewriteServeLocation(location, upstreamUrl, serveBasePath(projectId));
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
        const destination = new URL(rewritten, serveOrigin);
        destination.searchParams.set(SERVE_SESSION_QUERY_PARAM, routeId);
        headers.set('location', `${destination.pathname}${destination.search}${destination.hash}`);
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
