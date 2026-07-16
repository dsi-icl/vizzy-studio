import { createFileRoute } from '@tanstack/react-router';

import { logAuditDenied, logAuditSuccess } from '~/server/audit';
import type { AuthContext } from '~/server/requestAuthContext';
import { createWallMediaCookie } from '~/server/wallMediaCookie';

const isDev = process.env.NODE_ENV === 'development';

async function logAssetDenied(input: {
    request: Request;
    authContext: AuthContext;
    reasonCode: string;
    statusMessage?: string;
}) {
    await logAuditDenied({
        action: 'WALL_MEDIA_COOKIE_DENIED',
        reasonCode: input.reasonCode,
        statusMessage: input.statusMessage,
        authContext: input.authContext,
        executionContext: {
            surface: 'http',
            operation: 'POST /api/wall/media-cookie',
            request: input.request
        }
    });
}

export const Route = createFileRoute('/api/wall/media-cookie')({
    server: {
        handlers: {
            POST: async ({ request, context }) => {
                const authContext: AuthContext = ((context ?? {}) as { authContext?: AuthContext })
                    .authContext ?? { guest: true };
                const device = authContext.device;

                if (device?.kind !== 'wall' || !device.wallId) {
                    await logAssetDenied({
                        request,
                        authContext,
                        reasonCode: 'WALL_DEVICE_REQUIRED',
                        statusMessage: 'Wall Device Required'
                    });
                    return new Response('Unauthorized', {
                        status: 401,
                        headers: isDev
                            ? { 'X-Dev-Status-Message': 'Wall Device Required' }
                            : undefined
                    });
                }

                const cookie = createWallMediaCookie({ request, device });
                if (!cookie) {
                    await logAssetDenied({
                        request,
                        authContext,
                        reasonCode: 'COOKIE_CREATION_FAILED',
                        statusMessage: 'Cookie Creation Failed'
                    });
                    return new Response('Unauthorized', {
                        status: 401,
                        headers: isDev
                            ? { 'X-Dev-Status-Message': 'Cookie Creation Failed' }
                            : undefined
                    });
                }

                await logAuditSuccess({
                    action: 'WALL_MEDIA_COOKIE_ISSUED',
                    actorId: `device:${device.id}`,
                    resourceType: 'device',
                    resourceId: device.id,
                    authContext,
                    executionContext: {
                        surface: 'http',
                        operation: 'POST /api/wall/media-cookie',
                        request
                    }
                });

                return new Response(null, {
                    status: 204,
                    headers: {
                        'Set-Cookie': cookie,
                        'Cache-Control': 'no-store'
                    }
                });
            }
        }
    }
});
