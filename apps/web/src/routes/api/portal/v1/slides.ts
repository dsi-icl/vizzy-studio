import { createFileRoute } from '@tanstack/react-router';

import { scopedState, wallBindings } from '~/lib/busState';
import { getCorsHeaders, getBearerToken, json } from '~/lib/portalHttp';
import { pruneExpiredPortalTokens, validatePortalToken } from '~/lib/portalTokens';
import { logAuditDenied, logAuditFailure, logAuditSuccess } from '~/server/audit';
import { getSlidesMetadata } from '~/server/bus/bus.binding';

export const Route = createFileRoute('/api/portal/v1/slides')({
    server: {
        handlers: {
            OPTIONS: async ({ request }: { request: Request }) =>
                new Response(null, {
                    status: 204,
                    headers: getCorsHeaders(request)
                }),
            GET: async ({ request }: { request: Request }) => {
                pruneExpiredPortalTokens();

                const token = getBearerToken(request);
                if (!token) {
                    await logAuditDenied({
                        action: 'PORTAL_SLIDES_DENIED',
                        resourceType: 'portal_token',
                        reasonCode: 'MISSING_BEARER_TOKEN',
                        executionContext: {
                            surface: 'http',
                            operation: 'GET /api/portal/v1/slides',
                            request
                        }
                    });
                    return json(request, 401, { error: 'Missing bearer token' });
                }

                const validated = validatePortalToken(token);
                if (!validated) {
                    await logAuditDenied({
                        action: 'PORTAL_SLIDES_DENIED',
                        resourceType: 'portal_token',
                        reasonCode: 'INVALID_OR_EXPIRED_TOKEN',
                        executionContext: {
                            surface: 'http',
                            operation: 'GET /api/portal/v1/slides',
                            request
                        }
                    });
                    return json(request, 401, { error: 'Invalid or expired token' });
                }

                const currentScopeId = wallBindings.get(validated.wallId);
                if (currentScopeId === undefined || currentScopeId !== validated.scopeId) {
                    await logAuditFailure({
                        action: 'PORTAL_SLIDES_FAILED',
                        resourceType: 'portal_token',
                        reasonCode: 'TOKEN_SCOPE_MISMATCH',
                        executionContext: {
                            surface: 'http',
                            operation: 'GET /api/portal/v1/slides',
                            request
                        }
                    });
                    return json(request, 409, {
                        error: 'Wall is no longer bound to the token scope'
                    });
                }

                const scope = scopedState.get(validated.scopeId);
                if (!scope) {
                    await logAuditFailure({
                        action: 'PORTAL_SLIDES_FAILED',
                        resourceType: 'scope',
                        resourceId: String(validated.scopeId),
                        reasonCode: 'SCOPE_NOT_FOUND',
                        executionContext: {
                            surface: 'http',
                            operation: 'GET /api/portal/v1/slides',
                            request
                        }
                    });
                    return json(request, 409, { error: 'Scope no longer exists' });
                }

                const slidesMetadata = await getSlidesMetadata(scope.commitId);
                await logAuditSuccess({
                    action: 'PORTAL_SLIDES_READ',
                    resourceType: 'commit',
                    resourceId: scope.commitId,
                    executionContext: {
                        surface: 'http',
                        operation: 'GET /api/portal/v1/slides',
                        request
                    },
                    changes: {
                        wallId: validated.wallId,
                        projectId: scope.projectId,
                        count: slidesMetadata.length
                    }
                });

                return json(request, 200, {
                    ok: true,
                    wallId: validated.wallId,
                    projectId: scope.projectId,
                    commitId: scope.commitId,
                    slideId: scope.slideId,
                    slidesMetadata
                });
            }
        }
    }
});
