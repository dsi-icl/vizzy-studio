import { createFileRoute } from '@tanstack/react-router';

import { isFontAsset } from '~/lib/mediaUtils';
import { logAuditDenied } from '~/server/audit';
import { dbCol } from '~/server/collections';
import { listAssets } from '~/server/projects';
import type { AuthContext } from '~/server/requestAuthContext';

const isDev = process.env.NODE_ENV === 'development';

async function denied(input: {
    request: Request;
    authContext: AuthContext;
    reasonCode: string;
    projectId?: string | null;
    statusMessage?: string;
}): Promise<Response> {
    await logAuditDenied({
        action: 'WALL_FONTS_DENIED',
        projectId: input.projectId ?? null,
        resourceType: 'project',
        resourceId: input.projectId ?? null,
        reasonCode: input.reasonCode,
        statusMessage: input.statusMessage,
        authContext: input.authContext,
        executionContext: {
            surface: 'http',
            operation: 'GET /api/wall/fonts',
            request: input.request
        }
    });
    return new Response('Unauthorized', {
        status: 401,
        headers: isDev
            ? { 'X-Dev-Status-Message': input.statusMessage ?? input.reasonCode }
            : undefined
    });
}

export const Route = createFileRoute('/api/wall/fonts')({
    server: {
        handlers: {
            GET: async ({ request, context }) => {
                const authContext: AuthContext = ((context ?? {}) as { authContext?: AuthContext })
                    .authContext ?? { guest: true };
                const device = authContext.device;

                const projectId = new URL(request.url).searchParams.get('projectId');
                if (!projectId) {
                    return new Response('Bad Request', {
                        status: 400,
                        headers: isDev ? { 'X-Dev-Status-Message': 'Missing projectId' } : undefined
                    });
                }

                if (device?.kind !== 'wall' || !device.wallId) {
                    return denied({
                        request,
                        authContext,
                        projectId,
                        reasonCode: 'WALL_DEVICE_REQUIRED',
                        statusMessage: 'Wall Device Required'
                    });
                }

                const wall = await dbCol.walls.findByWallId(device.wallId);
                if (!wall || wall.boundProjectId !== projectId) {
                    return denied({
                        request,
                        authContext,
                        projectId,
                        reasonCode: 'WALL_PROJECT_MISMATCH',
                        statusMessage: 'Unauthorized Device'
                    });
                }

                const assets = await listAssets(projectId);
                const fonts = assets
                    .filter(isFontAsset)
                    .map((a) => ({ name: a.name, url: a.url, mimeType: a.mimeType ?? null }));

                return new Response(JSON.stringify({ fonts }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Cache-Control': 'private, max-age=60'
                    }
                });
            }
        }
    }
});
