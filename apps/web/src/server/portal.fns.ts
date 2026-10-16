import { env } from '@repo/env';
import { createServerFn } from '@tanstack/react-start';

import { scopedState, wallBindings } from '~/lib/busState';
import {
    buildDemoLaunchUrl,
    parseDemoSource,
    parseDirectDemoUpstreams
} from '~/lib/demoGatewayPaths';
import {
    buildProjectDemoLaunchUrl,
    parseDemoProjects,
    resolveProjectDemoSource
} from '~/lib/demoGatewayProjectPaths';
import { issueDemoLaunch } from '~/lib/demoGatewaySessions';
import { createPortalToken, pruneExpiredPortalTokens } from '~/lib/portalTokens';
import { z } from '~/lib/zod';
import { logAuditDenied } from '~/server/audit';
import { actorAuthContextMiddleware } from '~/server/auth-context.middleware';
import { getProject } from '~/server/projects';
import type { AuthContext } from '~/server/requestAuthContext';

function isManagedDemoUrl(rawUrl: string): boolean {
    try {
        const origin = new URL(rawUrl).origin;
        return [env.SERVER_DEMO_GATEWAY_PUBLIC_ORIGIN, env.SERVER_DEMO_GATEWAY_SOURCE_ORIGIN]
            .filter(Boolean)
            .some((configured) => new URL(configured).origin === origin);
    } catch {
        return false;
    }
}

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

/** A wall screen or gallery can open its bound demo through the gateway. */
export const $issueDemoGatewayLaunch = createServerFn({ method: 'POST' })
    .validator(
        z.object({
            wallId: z.string(),
            projectId: z.string(),
            kind: z.enum(['controller', 'screen'])
        })
    )
    .middleware([actorAuthContextMiddleware])
    .handler(async ({ data, context }) => {
        const authContext = (context as { authContext?: AuthContext } | undefined)?.authContext;
        const device = authContext?.device;
        const isBoundDevice =
            (data.kind === 'screen' && device?.kind === 'wall' && device.wallId === data.wallId) ||
            (data.kind === 'controller' &&
                device?.kind === 'gallery' &&
                (!device.wallId || device.wallId === data.wallId));
        const isAdmin = authContext?.user?.role === 'admin';
        if (!isBoundDevice && !isAdmin) {
            await logAuditDenied({
                action: 'DEMO_GATEWAY_TOKEN_ISSUE_DENIED',
                reasonCode: 'FORBIDDEN_ROLE',
                resourceType: 'portal_token',
                resourceId: data.wallId,
                authContext: authContext ?? { guest: true },
                executionContext: {
                    surface: 'serverfn',
                    operation: '$issueDemoGatewayLaunch'
                }
            });
            throw new Error('Forbidden');
        }

        const scopeId = wallBindings.get(data.wallId);
        const scope = scopeId === undefined ? undefined : scopedState.get(scopeId);
        if (scopeId === undefined || !scope || scope.projectId !== data.projectId) {
            throw new Error('Wall is not bound to this project');
        }

        const projectPathMode = !!env.SERVER_DEMO_GATEWAY_PUBLIC_ORIGIN;
        if (!projectPathMode && !env.SERVER_DEMO_GATEWAY_SOURCE_ORIGIN) {
            return null;
        }
        const project = await getProject(data.projectId);
        if (!project) throw new Error('Project not found');
        const rawUrl =
            data.kind === 'controller' ? project.customControlUrl : project.customRenderUrl;
        const projects = parseDemoProjects(env.SERVER_DEMO_GATEWAY_PROJECTS);
        if (!projects) throw new Error('Demo project mapping is invalid');
        const source = rawUrl
            ? projectPathMode
                ? resolveProjectDemoSource(
                      rawUrl,
                      data.projectId,
                      env.SERVER_DEMO_GATEWAY_PUBLIC_ORIGIN,
                      env.SERVER_DEMO_GATEWAY_SOURCE_ORIGIN,
                      projects
                  )
                : parseDemoSource(rawUrl, env.SERVER_DEMO_GATEWAY_SOURCE_ORIGIN)
            : null;
        if (!source) {
            if (projectPathMode && rawUrl && isManagedDemoUrl(rawUrl)) {
                throw new Error('This demo project is missing a valid gateway route');
            }
            return null;
        }
        const directUpstreams = parseDirectDemoUpstreams(env.SERVER_DEMO_GATEWAY_DIRECT_UPSTREAMS);
        if (!directUpstreams) throw new Error('Demo direct upstream configuration is invalid');
        if (!env.SERVER_DEMO_GATEWAY_UPSTREAM_ORIGIN && !directUpstreams.has(source.slug)) {
            return null;
        }

        const { ticket, expiresAt } = issueDemoLaunch({
            access: 'wall',
            wallId: data.wallId,
            scopeId,
            projectId: data.projectId,
            kind: data.kind,
            slug: source.slug,
            entryPath:
                'entryPath' in source
                    ? source.entryPath
                    : `${source.entry.pathname}${source.entry.search}`
        });
        return {
            url: projectPathMode
                ? buildProjectDemoLaunchUrl(
                      env.SERVER_DEMO_GATEWAY_PUBLIC_ORIGIN,
                      data.projectId,
                      data.kind,
                      ticket
                  )
                : buildDemoLaunchUrl(
                      env.SERVER_DEMO_GATEWAY_SOURCE_ORIGIN,
                      data.projectId,
                      data.kind,
                      ticket
                  ),
            expiresAt
        };
    });

/** A signed-in administrator can inspect a demo without binding any wall. */
export const $issueAdminDemoPreviewLaunch = createServerFn({ method: 'POST' })
    .validator(
        z.object({
            projectId: z.string(),
            kind: z.enum(['controller', 'screen'])
        })
    )
    .middleware([actorAuthContextMiddleware])
    .handler(async ({ data, context }) => {
        const authContext = (context as { authContext?: AuthContext } | undefined)?.authContext;
        if (authContext?.user?.role !== 'admin') {
            await logAuditDenied({
                action: 'DEMO_GATEWAY_PREVIEW_DENIED',
                reasonCode: 'FORBIDDEN_ROLE',
                resourceType: 'project',
                resourceId: data.projectId,
                authContext: authContext ?? { guest: true },
                executionContext: {
                    surface: 'serverfn',
                    operation: '$issueAdminDemoPreviewLaunch'
                }
            });
            throw new Error('Forbidden');
        }

        const projectPathMode = !!env.SERVER_DEMO_GATEWAY_PUBLIC_ORIGIN;
        if (!projectPathMode && !env.SERVER_DEMO_GATEWAY_SOURCE_ORIGIN) {
            throw new Error('Demo gateway is not configured');
        }
        const project = await getProject(data.projectId);
        if (!project) throw new Error('Project not found');
        const rawUrl =
            data.kind === 'controller' ? project.customControlUrl : project.customRenderUrl;
        const projects = parseDemoProjects(env.SERVER_DEMO_GATEWAY_PROJECTS);
        if (!projects) throw new Error('Demo project mapping is invalid');
        const source = rawUrl
            ? projectPathMode
                ? resolveProjectDemoSource(
                      rawUrl,
                      data.projectId,
                      env.SERVER_DEMO_GATEWAY_PUBLIC_ORIGIN,
                      env.SERVER_DEMO_GATEWAY_SOURCE_ORIGIN,
                      projects
                  )
                : parseDemoSource(rawUrl, env.SERVER_DEMO_GATEWAY_SOURCE_ORIGIN)
            : null;
        if (!source) throw new Error('This project has no demo URL on the protected host');
        const directUpstreams = parseDirectDemoUpstreams(env.SERVER_DEMO_GATEWAY_DIRECT_UPSTREAMS);
        if (!directUpstreams) throw new Error('Demo direct upstream configuration is invalid');
        if (!env.SERVER_DEMO_GATEWAY_UPSTREAM_ORIGIN && !directUpstreams.has(source.slug)) {
            throw new Error('No upstream is configured for this demo');
        }

        const { ticket, expiresAt } = issueDemoLaunch({
            access: 'admin-preview',
            projectId: data.projectId,
            kind: data.kind,
            slug: source.slug,
            entryPath:
                'entryPath' in source
                    ? source.entryPath
                    : `${source.entry.pathname}${source.entry.search}`
        });
        return {
            url: projectPathMode
                ? buildProjectDemoLaunchUrl(
                      env.SERVER_DEMO_GATEWAY_PUBLIC_ORIGIN,
                      data.projectId,
                      data.kind,
                      ticket
                  )
                : buildDemoLaunchUrl(
                      env.SERVER_DEMO_GATEWAY_SOURCE_ORIGIN,
                      data.projectId,
                      data.kind,
                      ticket
                  ),
            expiresAt
        };
    });
