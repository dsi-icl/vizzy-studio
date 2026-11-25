import { randomBytes } from 'node:crypto';

import { createServerFn } from '@tanstack/react-start';
import { getRequest, getResponseHeaders } from '@tanstack/react-start/server';

import { wallBindingIds, wallBindings } from '~/lib/busState';
import { isCustomProject } from '~/lib/customProject';
import {
    SERVE_SESSION_QUERY_PARAM,
    serveControlPath,
    serveKeepalivePath,
    serveWallPath
} from '~/lib/serveUrls';
import { z } from '~/lib/zod';
import { actorAuthContextMiddleware } from '~/server/auth-context.middleware';
import type { AuthContext } from '~/server/requestAuthContext';
import { isWallBoundToProject } from '~/server/serveAuthz';
import {
    boundServeRouteId,
    createServeCookie,
    obsoleteServeCookieHeaders,
    type ServeActor
} from '~/server/serveCookie';
import { servePublicUrl } from '~/server/serveOrigin';
import { getServeProject } from '~/server/serveProject';
import { recordServeTiming, serveTraceId } from '~/server/serveTiming';

const projectId = z.string().regex(/^[a-f\d]{24}$/i);

function launchUrl(
    id: string,
    entry: 'screen' | 'control',
    routeId: string,
    actor: ServeActor
): string {
    const url = new URL(
        servePublicUrl(entry === 'screen' ? serveWallPath(id) : serveControlPath(id))
    );
    url.searchParams.set(SERVE_SESSION_QUERY_PARAM, routeId);
    if (entry === 'control' && actor.surface === 'control') {
        url.searchParams.set('l', 'gallery');
        url.searchParams.set('w', actor.wallId);
    } else if (actor.surface === 'preview') {
        url.searchParams.set('preview', '1');
    }
    return url.toString();
}

function issueServeCookie(projectId: string, routeId: string, actor: ServeActor): void {
    const request = getRequest();
    const headers = getResponseHeaders();
    for (const stale of obsoleteServeCookieHeaders(request, projectId, actor)) {
        headers.append('Set-Cookie', stale);
    }
    headers.append('Set-Cookie', createServeCookie({ request, projectId, routeId, actor }));
    headers.set('Cache-Control', 'no-store');
}

export const $issueBoundServeLaunch = createServerFn({ method: 'POST' })
    .validator(z.object({ projectId, wallId: z.string(), entry: z.enum(['screen', 'control']) }))
    .middleware([actorAuthContextMiddleware])
    .handler(async ({ data, context }) => {
        const startedAt = performance.now();
        const auth = (context as { authContext?: AuthContext } | undefined)?.authContext;
        const device = auth?.device;
        const allowed =
            data.entry === 'screen'
                ? device?.kind === 'wall' && device.wallId === data.wallId
                : (device?.kind === 'gallery' &&
                      (!device.wallId || device.wallId === data.wallId)) ||
                  auth?.user?.role === 'admin';
        if (!allowed) throw new Error('Forbidden');
        const scopeId = wallBindings.get(data.wallId);
        const bindingId = wallBindingIds.get(data.wallId);
        if (
            scopeId === undefined ||
            !bindingId ||
            !isWallBoundToProject(data.wallId, data.projectId, scopeId, bindingId)
        ) {
            throw new Error('Wall is not bound to this project');
        }
        const project = await getServeProject(data.projectId);
        if (!project || !isCustomProject(project)) throw new Error('Custom project not found');
        const projectResolvedAt = performance.now();
        const actor: ServeActor = {
            surface: data.entry === 'screen' ? 'wall' : 'control',
            wallId: data.wallId,
            scopeId,
            bindingId
        };
        const routeId = boundServeRouteId({
            projectId: data.projectId,
            wallId: data.wallId,
            bindingId,
            entry: data.entry
        });
        issueServeCookie(data.projectId, routeId, actor);
        const traceId = serveTraceId(bindingId);
        recordServeTiming('authorize', performance.now() - startedAt, {
            traceId,
            wallId: data.wallId,
            projectId: data.projectId,
            entry: data.entry,
            projectLookupMs: Math.round(projectResolvedAt - startedAt)
        });
        return {
            url: launchUrl(data.projectId, data.entry, routeId, actor),
            keepaliveUrl: servePublicUrl(serveKeepalivePath(data.projectId, routeId)),
            traceId
        };
    });

export const $issueAdminServePreview = createServerFn({ method: 'POST' })
    .validator(z.object({ projectId, entry: z.enum(['screen', 'control']) }))
    .middleware([actorAuthContextMiddleware])
    .handler(async ({ data, context }) => {
        const auth = (context as { authContext?: AuthContext } | undefined)?.authContext;
        if (auth?.user?.role !== 'admin') throw new Error('Forbidden');
        const project = await getServeProject(data.projectId);
        if (!project || !isCustomProject(project)) throw new Error('Custom project not found');
        const routeId = randomBytes(16).toString('base64url');
        const actor: ServeActor = { surface: 'preview' };
        issueServeCookie(data.projectId, routeId, actor);
        return { url: launchUrl(data.projectId, data.entry, routeId, actor) };
    });
