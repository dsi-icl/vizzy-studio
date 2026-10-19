import '@tanstack/react-start/server-only';
import { env } from '@repo/env';
import { createWebSocketProxy, defineHooks, type Peer } from 'crossws';
import WebSocket from 'ws';

import { isCustomProject } from '~/lib/customProject';
import { parseServeSessionPath, serveBasePath, serveSessionBasePath } from '~/lib/serveUrls';
import { logAuditDenied, logAuditFailure } from '~/server/audit';
import { getProject } from '~/server/projects';
import { isWallBoundToProject } from '~/server/serveAuthz';
import { resolveServeCookieActor } from '~/server/serveCookie';
import { getServeOrigin, isServeOriginRequest } from '~/server/serveOrigin';

const UPSTREAM_CONTEXT_KEY = 'serveUpstreamUrl';

const UPGRADE_CONNECT_TIMEOUT_MS = Number(process.env.SERVE_WS_CONNECT_TIMEOUT_MS ?? 10_000);

export function isWebSocketUpgrade(request: Request): boolean {
    return (
        request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
        (request.headers.get('connection')?.toLowerCase().includes('upgrade') ?? false)
    );
}

export async function resolveServeWebSocketUpstream(request: Request): Promise<string | null> {
    if (!isServeOriginRequest(request)) return null;
    const url = new URL(request.url);
    const parsed = parseServeSessionPath(url.pathname);
    if (!parsed) return null;

    const { projectId } = parsed;
    const executionContext = {
        surface: 'ws' as const,
        operation: 'UPGRADE /serve/$projectId/$',
        request
    };

    const actor = resolveServeCookieActor(request, projectId, parsed.routeId);
    if (
        !actor ||
        ((actor.surface === 'wall' || actor.surface === 'control') &&
            !isWallBoundToProject(actor.wallId, projectId, actor.scopeId, actor.bindingId))
    ) {
        await logAuditDenied({
            action: 'SERVE_WS_DENIED',
            reasonCode: actor ? 'WALL_NOT_BOUND_TO_PROJECT' : 'NO_SERVE_COOKIE',
            resourceType: 'project',
            resourceId: projectId,
            authContext: { guest: true },
            executionContext
        });
        return null;
    }

    const project = await getProject(projectId).catch(() => null);
    if (!project || !isCustomProject(project)) return null;

    const port = project.customPort;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
        await logAuditFailure({
            action: 'SERVE_WS_FAILED',
            reasonCode: 'CUSTOM_PORT_NOT_CONFIGURED',
            resourceType: 'project',
            resourceId: projectId,
            executionContext
        });
        return null;
    }

    return `ws://${env.DEMOS_FQDN}:${port}${serveBasePath(projectId)}${parsed.rest}${url.search}`;
}

function resolvedUpstream(peer: Peer): string | null {
    const upstream = peer.context[UPSTREAM_CONTEXT_KEY];
    return typeof upstream === 'string' && upstream.length > 0 ? upstream : null;
}

const proxy = createWebSocketProxy({
    target: (peer) => resolvedUpstream(peer) ?? '',
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    headers: (peer) => {
        const parsed = parseServeSessionPath(new URL(peer.request.url).pathname);
        if (!parsed) return {};
        const actor = resolveServeCookieActor(peer.request, parsed.projectId, parsed.routeId);
        if (!actor) return {};
        return {
            Origin: getServeOrigin()?.origin ?? '',
            'X-Vizzy-Surface': actor.surface,
            ...(actor.surface === 'wall' || actor.surface === 'control'
                ? { 'X-Vizzy-Wall-Id': actor.wallId }
                : {}),
            'X-Vizzy-Public-Base': serveSessionBasePath(parsed.projectId, parsed.routeId)
        };
    },
    connectTimeout: UPGRADE_CONNECT_TIMEOUT_MS
});
const reapers = new Map<string, ReturnType<typeof setInterval>>();

export const serveWebSocketHooks = defineHooks({
    ...proxy,

    async upgrade(request) {
        const upstream = await resolveServeWebSocketUpstream(request);
        return { context: upstream ? { [UPSTREAM_CONTEXT_KEY]: upstream } : {} };
    },

    async open(peer) {
        if (!resolvedUpstream(peer)) {
            peer.close(1008, 'unauthorized');
            return;
        }
        await proxy.open?.(peer);
        const timer = setInterval(() => {
            const parsed = parseServeSessionPath(new URL(peer.request.url).pathname);
            const actor =
                parsed && resolveServeCookieActor(peer.request, parsed.projectId, parsed.routeId);
            if (
                !parsed ||
                !actor ||
                ((actor.surface === 'wall' || actor.surface === 'control') &&
                    !isWallBoundToProject(
                        actor.wallId,
                        parsed.projectId,
                        actor.scopeId,
                        actor.bindingId
                    ))
            ) {
                peer.close(1008, 'demo session expired');
            }
        }, 5000);
        reapers.set(peer.id, timer);
    },

    close(peer, details) {
        const timer = reapers.get(peer.id);
        if (timer) clearInterval(timer);
        reapers.delete(peer.id);
        return proxy.close?.(peer, details);
    }
});
