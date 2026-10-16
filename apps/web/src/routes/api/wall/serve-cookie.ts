import { createFileRoute } from '@tanstack/react-router';

import { wallBindings } from '~/lib/busState';
import { isCustomProject } from '~/lib/customProject';
import { z } from '~/lib/zod';
import { logAuditDenied, logAuditSuccess } from '~/server/audit';
import { getProject } from '~/server/projects';
import type { AuthContext } from '~/server/requestAuthContext';
import { isWallBoundToProject } from '~/server/serveAuthz';
import { createServeCookie } from '~/server/serveCookie';

const requestSchema = z.object({ projectId: z.string() });

async function deny(input: {
    request: Request;
    authContext: AuthContext;
    reasonCode: string;
    projectId?: string;
}) {
    await logAuditDenied({
        action: 'SERVE_COOKIE_DENIED',
        reasonCode: input.reasonCode,
        resourceType: 'project',
        ...(input.projectId ? { resourceId: input.projectId } : {}),
        authContext: input.authContext,
        executionContext: {
            surface: 'http',
            operation: 'POST /api/wall/serve-cookie',
            request: input.request
        }
    });
    return new Response('Unauthorized', { status: 401 });
}

export const Route = createFileRoute('/api/wall/serve-cookie')({
    server: {
        handlers: {
            POST: async ({ request, context }) => {
                const authContext: AuthContext = ((context ?? {}) as { authContext?: AuthContext })
                    .authContext ?? { guest: true };
                const device = authContext.device;

                if (device?.kind !== 'wall' || !device.wallId) {
                    return deny({ request, authContext, reasonCode: 'WALL_DEVICE_REQUIRED' });
                }

                let body: z.infer<typeof requestSchema>;
                try {
                    body = requestSchema.parse(await request.json());
                } catch {
                    return new Response('Bad request', { status: 400 });
                }

                const project = await getProject(body.projectId).catch(() => null);
                if (!project || !isCustomProject(project)) {
                    return deny({
                        request,
                        authContext,
                        reasonCode: 'NOT_A_CUSTOM_PROJECT',
                        projectId: body.projectId
                    });
                }

                const scopeId = wallBindings.get(device.wallId);
                if (
                    scopeId === undefined ||
                    !isWallBoundToProject(device.wallId, body.projectId, scopeId)
                ) {
                    return deny({
                        request,
                        authContext,
                        reasonCode: 'WALL_NOT_BOUND_TO_PROJECT',
                        projectId: body.projectId
                    });
                }

                await logAuditSuccess({
                    action: 'SERVE_COOKIE_ISSUED',
                    actorId: `device:${device.id}`,
                    resourceType: 'project',
                    resourceId: body.projectId,
                    changes: { wallId: device.wallId, scopeId },
                    authContext,
                    executionContext: {
                        surface: 'http',
                        operation: 'POST /api/wall/serve-cookie',
                        request
                    }
                });

                return new Response(null, {
                    status: 204,
                    headers: {
                        'Set-Cookie': createServeCookie({
                            request,
                            projectId: body.projectId,
                            actor: { surface: 'wall', wallId: device.wallId, scopeId }
                        }),
                        'Cache-Control': 'no-store'
                    }
                });
            }
        }
    }
});
