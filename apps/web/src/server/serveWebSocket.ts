import '@tanstack/react-start/server-only';
import { env } from '@repo/env';
import { createWebSocketProxy, defineHooks, type Peer } from 'crossws';

import { isCustomProject } from '~/lib/customProject';
import { parseServePath } from '~/lib/serveUrls';
import { logAuditDenied, logAuditFailure } from '~/server/audit';
import { getProject } from '~/server/projects';
import { resolveServeCookieActor } from '~/server/serveCookie';

/**
 * Relays a custom project's own WebSocket. Each demo runs its own socket server.
 */
const UPSTREAM_CONTEXT_KEY = 'serveUpstreamUrl';

const UPGRADE_CONNECT_TIMEOUT_MS = Number(process.env.SERVE_WS_CONNECT_TIMEOUT_MS ?? 10_000);

export function isWebSocketUpgrade(request: Request): boolean {
    return (
        request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
        (request.headers.get('connection')?.toLowerCase().includes('upgrade') ?? false)
    );
}

async function resolveUpstream(request: Request): Promise<string | null> {
    const url = new URL(request.url);
    const parsed = parseServePath(url.pathname);
    if (!parsed) return null;

    const { projectId } = parsed;
    const executionContext = {
        surface: 'ws' as const,
        operation: 'UPGRADE /serve/$projectId/$',
        request
    };

    if (!resolveServeCookieActor(request, projectId)) {
        await logAuditDenied({
            action: 'SERVE_WS_DENIED',
            reasonCode: 'NO_SERVE_COOKIE',
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

    return `ws://${env.DEMOS_FQDN}:${port}${url.pathname}${url.search}`;
}

function resolvedUpstream(peer: Peer): string | null {
    const upstream = peer.context[UPSTREAM_CONTEXT_KEY];
    return typeof upstream === 'string' && upstream.length > 0 ? upstream : null;
}

const proxy = createWebSocketProxy({
    target: (peer) => resolvedUpstream(peer) ?? '',
    connectTimeout: UPGRADE_CONNECT_TIMEOUT_MS
});

export const serveWebSocketHooks = defineHooks({
    ...proxy,

    async upgrade(request) {
        const upstream = await resolveUpstream(request);
        return { context: upstream ? { [UPSTREAM_CONTEXT_KEY]: upstream } : {} };
    },

    async open(peer) {
        if (!resolvedUpstream(peer)) {
            peer.close(1008, 'unauthorized');
            return;
        }
        await proxy.open?.(peer);
    }
});
