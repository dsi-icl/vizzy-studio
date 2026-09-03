import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createFileRoute } from '@tanstack/react-router';
import { setResponseHeader } from '@tanstack/react-start/server';

import { scopedState, wallBindings } from '~/lib/busState';
import { type CspDirectives, modifyCsp, serializeCsp } from '~/lib/csp';
import { getBearerToken, getCorsHeaders, json } from '~/lib/portalHttp';
import { pruneExpiredPortalTokens, validatePortalToken } from '~/lib/portalTokens';
import { CONTROLLER_DIR } from '~/lib/serverVariables';
import { logAuditDenied, logAuditFailure, logAuditSuccess } from '~/server/audit';
import { canViewProject } from '~/server/projectAuthz';
import { getProject } from '~/server/projects';
import { resolveRequestAuthContext } from '~/server/requestAuthContext';

export const Route = createFileRoute('/api/portal/v1/controllers/$projectId')({
    server: {
        handlers: {
            OPTIONS: async ({ request }: { request: Request }) =>
                new Response(null, {
                    status: 204,
                    headers: getCorsHeaders(request)
                }),
            GET: async ({
                params,
                request,
                context
            }: {
                params: { projectId: string };
                request: Request;
                context?: {
                    cspDirectives?: CspDirectives;
                    cspHeaderName?: string;
                    [key: string]: unknown;
                };
            }) => {
                const { projectId } = params;

                const project = await getProject(projectId);
                if (!project) {
                    await logAuditDenied({
                        action: 'CUSTOM_CONTROLLER_HTML_DENIED',
                        resourceType: 'project',
                        resourceId: projectId,
                        reasonCode: 'PROJECT_NOT_FOUND',
                        executionContext: {
                            surface: 'http',
                            operation: 'GET /api/portal/v1/controllers/$projectId',
                            request
                        }
                    });
                    return json(request, 404, { error: 'Project not found' });
                }

                pruneExpiredPortalTokens();
                let authorized = false;

                const token = getBearerToken(request);
                if (token) {
                    const session = validatePortalToken(token);
                    if (session) {
                        const currentScopeId = wallBindings.get(session.wallId);
                        if (currentScopeId !== undefined && currentScopeId === session.scopeId) {
                            const scope = scopedState.get(session.scopeId);
                            if (scope && scope.projectId === project.id) {
                                authorized = true;
                            }
                        }
                    }
                }

                if (!authorized) {
                    const authContext = await resolveRequestAuthContext(request);
                    if (authContext.user) {
                        const actor = {
                            email: authContext.user.email,
                            role: authContext.user.role
                        };
                        if (await canViewProject(actor, project.id)) {
                            authorized = true;
                        }
                    }
                }

                if (!authorized) {
                    await logAuditDenied({
                        action: 'CUSTOM_CONTROLLER_HTML_DENIED',
                        resourceType: 'project',
                        resourceId: projectId,
                        reasonCode: 'FORBIDDEN',
                        executionContext: {
                            surface: 'http',
                            operation: 'GET /api/portal/v1/controllers/$projectId',
                            request
                        }
                    });
                    return json(request, 401, { error: 'Unauthorized' });
                }

                let html: string;
                try {
                    html = await readFile(
                        join(CONTROLLER_DIR, project.id, 'controller.html'),
                        'utf8'
                    );
                } catch {
                    await logAuditFailure({
                        action: 'CUSTOM_CONTROLLER_HTML_FAILED',
                        resourceType: 'project',
                        resourceId: projectId,
                        reasonCode: 'CONTROLLER_HTML_NOT_FOUND',
                        executionContext: {
                            surface: 'http',
                            operation: 'GET /api/portal/v1/controllers/$projectId',
                            request
                        }
                    });
                    return json(request, 404, { error: 'No controller HTML found' });
                }

                if (context?.cspDirectives && context.cspHeaderName) {
                    const directives = modifyCsp(context.cspDirectives, {
                        'script-src': ["'self'", "'unsafe-inline'", 'https:'],
                        'style-src': ["'self'", "'unsafe-inline'", 'https:'],
                        'style-src-elem': ["'self'", "'unsafe-inline'", 'https:'],
                        'frame-ancestors': ["'self'"]
                    });
                    setResponseHeader(context.cspHeaderName, serializeCsp(directives));
                }
                await logAuditSuccess({
                    action: 'CUSTOM_CONTROLLER_HTML_READ',
                    resourceType: 'project',
                    resourceId: projectId,
                    executionContext: {
                        surface: 'http',
                        operation: 'GET /api/portal/v1/controllers/$projectId',
                        request
                    }
                });

                return new Response(html, {
                    status: 200,
                    headers: {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Cache-Control': 'no-store'
                    }
                });
            }
        }
    }
});
