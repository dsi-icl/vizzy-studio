import { createFileRoute } from '@tanstack/react-router';

import { scopedState, wallBindings } from '~/lib/busState';
import { getBearerToken, getCorsHeaders, json } from '~/lib/portalHttp';
import { pruneExpiredPortalTokens, validatePortalToken } from '~/lib/portalTokens';
import { z } from '~/lib/zod';
import { logAuditDenied, logAuditFailure, logAuditSuccess } from '~/server/audit';
import { applyControllerTransientLayer } from '~/server/bus/bus.transientLayers';

const routeParamsSchema = z.object({
    slideId: z.string().trim().min(1),
    numericId: z.coerce.number().int().nonnegative()
});

const requestSchema = z.object({
    scale: z.number().min(0.75).max(22),
    centerX: z.number(),
    centerY: z.number()
});

const operation = 'POST /api/portal/v1/slides/:slideId/images/:numericId/zoom';

export const Route = createFileRoute('/api/portal/v1/slides/$slideId/images/$numericId/zoom')({
    server: {
        handlers: {
            OPTIONS: async ({ request }: { request: Request }) =>
                new Response(null, { status: 204, headers: getCorsHeaders(request) }),

            POST: async ({
                request,
                params
            }: {
                request: Request;
                params: { slideId: string; numericId: string };
            }) => {
                pruneExpiredPortalTokens();

                const token = getBearerToken(request);
                if (!token) {
                    await logAuditDenied({
                        action: 'PORTAL_IMAGE_ZOOM_DENIED',
                        resourceType: 'portal_token',
                        reasonCode: 'MISSING_BEARER_TOKEN',
                        executionContext: { surface: 'http', operation, request }
                    });
                    return json(request, 401, { error: 'Missing bearer token' });
                }

                const session = validatePortalToken(token);
                if (!session) {
                    await logAuditDenied({
                        action: 'PORTAL_IMAGE_ZOOM_DENIED',
                        resourceType: 'portal_token',
                        reasonCode: 'INVALID_OR_EXPIRED_TOKEN',
                        executionContext: { surface: 'http', operation, request }
                    });
                    return json(request, 401, { error: 'Invalid or expired token' });
                }

                const authContext = { portal: { wallId: session.wallId } };
                const parsedParams = routeParamsSchema.safeParse(params);
                if (!parsedParams.success) {
                    await logAuditFailure({
                        action: 'PORTAL_IMAGE_ZOOM_FAILED',
                        resourceType: 'scope',
                        resourceId: String(session.scopeId),
                        reasonCode: 'INVALID_ROUTE_PARAMS',
                        authContext,
                        executionContext: { surface: 'http', operation, request }
                    });
                    return json(request, 400, { error: 'Invalid zoom target' });
                }

                const parsedRequest = requestSchema.safeParse(
                    await request.json().catch(() => undefined)
                );
                if (!parsedRequest.success) {
                    await logAuditFailure({
                        action: 'PORTAL_IMAGE_ZOOM_FAILED',
                        resourceType: 'scope',
                        resourceId: String(session.scopeId),
                        reasonCode: 'INVALID_REQUEST_BODY',
                        authContext,
                        executionContext: { surface: 'http', operation, request }
                    });
                    return json(request, 400, { error: 'Invalid zoom request' });
                }

                const scopeId = wallBindings.get(session.wallId);
                if (scopeId !== session.scopeId) {
                    await logAuditFailure({
                        action: 'PORTAL_IMAGE_ZOOM_FAILED',
                        resourceType: 'portal_token',
                        reasonCode: 'TOKEN_SCOPE_MISMATCH',
                        authContext,
                        executionContext: { surface: 'http', operation, request }
                    });
                    return json(request, 409, {
                        error: 'Wall is no longer bound to the token scope'
                    });
                }

                const scope = scopedState.get(scopeId);
                if (!scope) {
                    await logAuditFailure({
                        action: 'PORTAL_IMAGE_ZOOM_FAILED',
                        resourceType: 'scope',
                        resourceId: String(scopeId),
                        reasonCode: 'SCOPE_NOT_FOUND',
                        authContext,
                        executionContext: { surface: 'http', operation, request }
                    });
                    return json(request, 409, { error: 'Scope no longer exists' });
                }

                const { slideId, numericId } = parsedParams.data;
                if (scope.slideId !== slideId) {
                    await logAuditFailure({
                        action: 'PORTAL_IMAGE_ZOOM_FAILED',
                        projectId: scope.projectId,
                        resourceType: 'scope',
                        resourceId: String(scopeId),
                        reasonCode: 'SLIDE_SCOPE_MISMATCH',
                        authContext,
                        executionContext: { surface: 'http', operation, request }
                    });
                    return json(request, 409, {
                        error: 'Wall is no longer bound to the requested slide'
                    });
                }

                const source = scope.layers.get(numericId);
                if (!source || source.type !== 'image') {
                    await logAuditSuccess({
                        action: 'PORTAL_IMAGE_ZOOM_SUCCEEDED',
                        projectId: scope.projectId,
                        resourceType: 'scope',
                        resourceId: String(scopeId),
                        authContext,
                        executionContext: { surface: 'http', operation, request },
                        changes: { slideId, numericId, applied: false }
                    });
                    return new Response(null, {
                        status: 204,
                        headers: getCorsHeaders(request)
                    });
                }

                const { scale, centerX, centerY } = parsedRequest.data;
                const dx = (0.5 - centerX) * source.config.width * source.config.scaleX * scale;
                const dy = (0.5 - centerY) * source.config.height * source.config.scaleY * scale;
                const layer = {
                    ...source,
                    config: {
                        ...source.config,
                        cx: source.config.cx + dx,
                        cy: source.config.cy + dy,
                        scaleX: source.config.scaleX * scale,
                        scaleY: source.config.scaleY * scale
                    }
                };

                applyControllerTransientLayer({
                    wallId: session.wallId,
                    layer,
                    origin: 'controller:image_zoom'
                });

                await logAuditSuccess({
                    action: 'PORTAL_IMAGE_ZOOM_SUCCEEDED',
                    projectId: scope.projectId,
                    resourceType: 'scope',
                    resourceId: String(scopeId),
                    authContext,
                    executionContext: { surface: 'http', operation, request },
                    changes: { slideId, numericId, scale, centerX, centerY, applied: true }
                });

                return json(request, 200, { ok: true, numericId, scale });
            }
        }
    }
});
