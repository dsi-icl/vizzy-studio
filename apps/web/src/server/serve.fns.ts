import { createServerFn } from '@tanstack/react-start';

import { wallBindingIds, wallBindings } from '~/lib/busState';
import { isCustomProject } from '~/lib/customProject';
import { serveLaunchPath, serveSessionBasePath } from '~/lib/serveUrls';
import { z } from '~/lib/zod';
import { actorAuthContextMiddleware } from '~/server/auth-context.middleware';
import { getProject } from '~/server/projects';
import type { AuthContext } from '~/server/requestAuthContext';
import { isWallBoundToProject } from '~/server/serveAuthz';
import { issueServeLaunch } from '~/server/serveLaunch';
import { servePublicUrl } from '~/server/serveOrigin';

const projectId = z.string().regex(/^[a-f\d]{24}$/i);

function launchUrl(id: string, ticket: string): string {
    const url = new URL(servePublicUrl(serveLaunchPath(id)));
    url.searchParams.set('ticket', ticket);
    return url.toString();
}

export const $issueBoundServeLaunch = createServerFn({ method: 'POST' })
    .validator(z.object({ projectId, wallId: z.string(), entry: z.enum(['screen', 'control']) }))
    .middleware([actorAuthContextMiddleware])
    .handler(async ({ data, context }) => {
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
        const project = await getProject(data.projectId);
        if (!project || !isCustomProject(project)) throw new Error('Custom project not found');
        const { ticket, routeId } = await issueServeLaunch({
            projectId: data.projectId,
            entry: data.entry,
            actor: {
                surface: data.entry === 'screen' ? 'wall' : 'control',
                wallId: data.wallId,
                scopeId,
                bindingId
            }
        });
        return {
            url: launchUrl(data.projectId, ticket),
            keepaliveUrl: servePublicUrl(
                `${serveSessionBasePath(data.projectId, routeId)}/_keepalive`
            )
        };
    });

export const $issueAdminServePreview = createServerFn({ method: 'POST' })
    .validator(z.object({ projectId, entry: z.enum(['screen', 'control']) }))
    .middleware([actorAuthContextMiddleware])
    .handler(async ({ data, context }) => {
        const auth = (context as { authContext?: AuthContext } | undefined)?.authContext;
        if (auth?.user?.role !== 'admin') throw new Error('Forbidden');
        const project = await getProject(data.projectId);
        if (!project || !isCustomProject(project)) throw new Error('Custom project not found');
        const { ticket } = await issueServeLaunch({
            projectId: data.projectId,
            entry: data.entry,
            actor: { surface: data.entry === 'screen' ? 'preview-screen' : 'preview-control' }
        });
        return { url: launchUrl(data.projectId, ticket) };
    });
