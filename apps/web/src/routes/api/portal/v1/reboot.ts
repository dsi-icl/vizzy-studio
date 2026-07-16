import { createFileRoute } from '@tanstack/react-router';

import { wallBindings } from '~/lib/busState';
import { getCorsHeaders, getBearerToken, json } from '~/lib/portalHttp';
import { pruneExpiredPortalTokens, validatePortalToken } from '~/lib/portalTokens';
import { z } from '~/lib/zod';
import { logAuditDenied, logAuditFailure, logAuditSuccess } from '~/server/audit';

const rebootRequestSchema = z
    .object({
        wallId: z.string().optional(),
        c: z.number().int().nonnegative().optional(),
        r: z.number().int().nonnegative().optional()
    })
    .default({});

export const Route = createFileRoute('/api/portal/v1/reboot')({
    server: {
        handlers: {
            OPTIONS: async ({ request }: { request: Request }) =>
                new Response(null, {
                    status: 204,
                    headers: getCorsHeaders(request)
                }),
            POST: async ({ request }: { request: Request }) => {
                pruneExpiredPortalTokens();

                const token = getBearerToken(request);
                if (!token) {
                    await logAuditDenied({
                        action: 'PORTAL_REBOOT_DENIED',
                        resourceType: 'portal_token',
                        reasonCode: 'MISSING_BEARER_TOKEN',
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/portal/v1/reboot',
                            request
                        }
                    });
                    return json(request, 401, { error: 'Missing bearer token' });
                }

                const validated = validatePortalToken(token);
                if (!validated) {
                    await logAuditDenied({
                        action: 'PORTAL_REBOOT_DENIED',
                        resourceType: 'portal_token',
                        reasonCode: 'INVALID_OR_EXPIRED_TOKEN',
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/portal/v1/reboot',
                            request
                        }
                    });
                    return json(request, 401, { error: 'Invalid or expired token' });
                }

                let body: z.infer<typeof rebootRequestSchema>;
                try {
                    body = rebootRequestSchema.parse(await request.json().catch(() => ({})));
                } catch (error: any) {
                    await logAuditFailure({
                        action: 'PORTAL_REBOOT_FAILED',
                        resourceType: 'portal_token',
                        reasonCode: 'INVALID_REQUEST_BODY',
                        statusMessage: error?.message ?? String(error),
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/portal/v1/reboot',
                            request
                        }
                    });
                    return json(request, 400, {
                        error: 'Invalid request body',
                        details: error?.message ?? String(error)
                    });
                }

                const targetWallId = body.wallId ?? validated.wallId;
                if (targetWallId !== validated.wallId) {
                    await logAuditDenied({
                        action: 'PORTAL_REBOOT_DENIED',
                        resourceType: 'portal_token',
                        resourceId: targetWallId,
                        reasonCode: 'TOKEN_WALL_MISMATCH',
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/portal/v1/reboot',
                            request
                        }
                    });
                    return json(request, 403, {
                        error: 'Token is not allowed to control this wall'
                    });
                }

                const currentScopeId = wallBindings.get(targetWallId);
                if (currentScopeId === undefined || currentScopeId !== validated.scopeId) {
                    await logAuditFailure({
                        action: 'PORTAL_REBOOT_FAILED',
                        resourceType: 'portal_token',
                        reasonCode: 'TOKEN_SCOPE_MISMATCH',
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/portal/v1/reboot',
                            request
                        }
                    });
                    return json(request, 409, {
                        error: 'Wall is no longer bound to the token scope'
                    });
                }

                const rebootWall = process.__REBOOT_WALL__;
                if (!rebootWall) {
                    await logAuditFailure({
                        action: 'PORTAL_REBOOT_FAILED',
                        resourceType: 'wall',
                        resourceId: targetWallId,
                        reasonCode: 'BUS_BRIDGE_UNAVAILABLE',
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/portal/v1/reboot',
                            request
                        }
                    });
                    return json(request, 503, { error: 'Wall bus bridge unavailable' });
                }

                const hasNodeTarget = body.c !== undefined || body.r !== undefined;
                if ((body.c === undefined) !== (body.r === undefined)) {
                    await logAuditFailure({
                        action: 'PORTAL_REBOOT_FAILED',
                        resourceType: 'wall',
                        resourceId: targetWallId,
                        reasonCode: 'INVALID_NODE_TARGET',
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/portal/v1/reboot',
                            request
                        }
                    });
                    return json(request, 400, {
                        error: 'Both c and r must be provided together when targeting a node'
                    });
                }

                const sent = hasNodeTarget
                    ? rebootWall(targetWallId, { c: body.c!, r: body.r! })
                    : rebootWall(targetWallId);

                if (sent <= 0) {
                    await logAuditFailure({
                        action: 'PORTAL_REBOOT_FAILED',
                        resourceType: 'wall',
                        resourceId: targetWallId,
                        reasonCode: 'NO_CONNECTED_WALL_NODES',
                        executionContext: {
                            surface: 'http',
                            operation: 'POST /api/portal/v1/reboot',
                            request
                        }
                    });
                    return json(request, 404, {
                        error: hasNodeTarget
                            ? 'No wall node found for the requested c/r'
                            : 'No connected wall nodes for this wall'
                    });
                }
                await logAuditSuccess({
                    action: 'PORTAL_REBOOT_SUCCEEDED',
                    resourceType: 'wall',
                    resourceId: targetWallId,
                    executionContext: {
                        surface: 'http',
                        operation: 'POST /api/portal/v1/reboot',
                        request
                    },
                    changes: {
                        sent,
                        targetedNode: hasNodeTarget ? `${body.c}:${body.r}` : null
                    }
                });

                return json(request, 200, {
                    ok: true,
                    wallId: targetWallId,
                    scopeId: validated.scopeId,
                    targetedNode: hasNodeTarget ? { c: body.c, r: body.r } : null,
                    sent
                });
            }
        }
    }
});
