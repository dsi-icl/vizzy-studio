import { env } from '@repo/env';
import { createFileRoute } from '@tanstack/react-router';

import { wallBindings } from '~/lib/busState';
import { isCustomProject } from '~/lib/customProject';
import { validatePortalToken } from '~/lib/portalTokens';
import { buildForwardedHeaders, buildRelayedHeaders } from '~/lib/serveHeaders';
import {
    buildServeUpstreamUrl,
    parseServePath,
    rewriteServeLocation,
    serveBasePath
} from '~/lib/serveUrls';
import { logAuditDenied, logAuditFailure, logAuditSuccess } from '~/server/audit';
import { getProject } from '~/server/projects';
import { resolveRequestAuthContext } from '~/server/requestAuthContext';
import { isWallBoundToProject } from '~/server/serveAuthz';
import {
    createServeCookie,
    resolveServeCookieActor,
    shouldRefreshServeCookie,
    type ServeActor
} from '~/server/serveCookie';
import { isWebSocketUpgrade, serveWebSocketHooks } from '~/server/serveWebSocket';

const SERVE_FETCH_TIMEOUT_MS = Number(process.env.SERVE_FETCH_TIMEOUT_MS ?? 30_000);

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

async function authorizeFreshRequest(
    request: Request,
    projectId: string
): Promise<ServeActor | null> {
    const token = bearerOrQueryToken(request);
    if (token) {
        const validated = validatePortalToken(token, 'control');
        if (validated && isWallBoundToProject(validated.wallId, projectId, validated.scopeId)) {
            return {
                surface: 'control',
                wallId: validated.wallId,
                scopeId: validated.scopeId
            };
        }
    }

    const { authContext } = await resolveRequestAuthContext(request);
    const device = authContext.device;
    if (device?.kind === 'wall' && device.wallId) {
        const scopeId = wallBindings.get(device.wallId);
        if (scopeId !== undefined && isWallBoundToProject(device.wallId, projectId, scopeId)) {
            return { surface: 'wall', wallId: device.wallId, scopeId };
        }
    }

    return null;
}

function notFound(): Response {
    return new Response('Not found', { status: 404 });
}

async function handler({ request }: { request: Request }): Promise<Response> {
    if (isWebSocketUpgrade(request)) {
        return Object.assign(new Response('WebSocket upgrade is required.', { status: 426 }), {
            crossws: serveWebSocketHooks
        });
    }

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
    if (actor && !isWallBoundToProject(actor.wallId, projectId, actor.scopeId)) {
        actor = null;
    }

    let mintCookie = actor !== null && shouldRefreshServeCookie(actor);
    const freshlyAuthorized = actor === null;

    if (!actor) {
        actor = await authorizeFreshRequest(request, projectId);
        if (!actor) {
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
            headers: buildForwardedHeaders(request, actor),
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
        headers.set('location', rewritten);
    }

    if (mintCookie) {
        headers.append('set-cookie', createServeCookie({ request, projectId, actor }));
    }

    if (freshlyAuthorized) {
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
