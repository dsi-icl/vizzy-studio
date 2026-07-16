import { createServerFn } from '@tanstack/react-start';

import { wallBindings } from '~/lib/busState';
import { createPortalToken, pruneExpiredPortalTokens } from '~/lib/portalTokens';
import { z } from '~/lib/zod';
import { logAuditDenied } from '~/server/audit';
import { actorAuthContextMiddleware } from '~/server/auth-context.middleware';
import type { AuthContext } from '~/server/requestAuthContext';

export const $issueControllerPortalToken = createServerFn({ method: 'POST' })
    .validator(
        z.object({
            wallId: z.string()
        })
    )
    .middleware([actorAuthContextMiddleware])
    .handler(async ({ data, context }) => {
        const authContext = (context as { authContext?: AuthContext } | undefined)?.authContext;
        const device = authContext?.device;
        const user = authContext?.user;
        const isGalleryDevice = Boolean(device && device.kind === 'gallery');
        const isAdminUser = user?.role === 'admin';

        if (!isGalleryDevice && !isAdminUser) {
            await logAuditDenied({
                action: 'PORTAL_TOKEN_ISSUE_DENIED',
                reasonCode: 'FORBIDDEN_ROLE',
                resourceType: 'portal_token',
                resourceId: data.wallId,
                authContext: authContext ?? { guest: true },
                executionContext: {
                    surface: 'serverfn',
                    operation: '$issueControllerPortalToken'
                }
            });
            throw new Error('Forbidden');
        }
        if (isGalleryDevice && device?.wallId && device.wallId !== data.wallId) {
            await logAuditDenied({
                action: 'PORTAL_TOKEN_ISSUE_DENIED',
                reasonCode: 'FORBIDDEN_WALL_SCOPE',
                resourceType: 'portal_token',
                resourceId: data.wallId,
                authContext: authContext ?? { guest: true },
                executionContext: {
                    surface: 'serverfn',
                    operation: '$issueControllerPortalToken'
                }
            });
            throw new Error('Forbidden');
        }

        pruneExpiredPortalTokens();
        const scopeId = wallBindings.get(data.wallId);
        if (scopeId === undefined) {
            throw new Error('Wall is not currently bound');
        }
        return createPortalToken(data.wallId, scopeId);
    });
