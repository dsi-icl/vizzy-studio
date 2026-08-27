import {
    adminMiddleware,
    authMiddleware,
    operatorMiddleware
} from '@repo/auth/tanstack/middleware';
import type { AuthContext } from '@repo/db/documents';
import { Collaborator } from '@repo/db/schema';
import { StageLayout } from '@repo/db/schema';
import { createServerFn } from '@tanstack/react-start';

import { z } from '~/lib/zod';

import {
    adminCreateWall,
    adminDeleteWall,
    adminDevicesEnrollBySignature,
    adminDeleteDevice,
    adminDevicesList,
    adminGetWall,
    adminListDevicesForWall,
    adminDeletePublicAsset,
    adminListConfig,
    adminGetWallBindingMeta,
    adminGetStats,
    adminListAuditsPage,
    adminListProjects,
    adminUpdateProjectCollaborators,
    adminListPublicAssets,
    adminListUsers,
    adminListWalls,
    adminSetUserBanStatus,
    adminSetUserTrustedPublisher,
    adminSetUserCanManageSignage,
    adminSetUserRole,
    adminImpersonateUser,
    adminStopImpersonation,
    adminSendSmtpTest,
    adminSetConfig,
    adminUpdateWallMetadata,
    adminUpdateWallLayoutTemplate,
    adminUpdateWallOpenToEditors,
    adminUnbindWall
} from './admin';
import { logAuditSuccess } from './audit';

function authContextFromServerFnContext(context: unknown): AuthContext {
    const c = context as
        | { authContext?: AuthContext; user?: { email?: string; role?: string } }
        | undefined;
    if (c?.authContext) return c.authContext;
    const email = c?.user?.email;
    const role = c?.user?.role;
    if (typeof email === 'string' && (role === 'admin' || role === 'operator' || role === 'user')) {
        return { user: { email, role } };
    }
    return { guest: true };
}

function buildAdminFnAuditContext(context: unknown, operation: string) {
    return {
        authContext: authContextFromServerFnContext(context),
        executionContext: { surface: 'serverfn' as const, operation }
    };
}

export const $adminListUsers = createServerFn({ method: 'GET' })
    .middleware([operatorMiddleware])
    .handler(async () => adminListUsers());

export const $adminListProjects = createServerFn({ method: 'GET' })
    .middleware([operatorMiddleware])
    .handler(async () => adminListProjects());

export const $adminUpdateProjectCollaborators = createServerFn({ method: 'POST' })
    .middleware([operatorMiddleware])
    .validator(
        z.object({
            projectId: z.string(),
            collaborators: z.array(Collaborator)
        })
    )
    .handler(async ({ data, context }) =>
        adminUpdateProjectCollaborators(
            { projectId: data.projectId, collaborators: data.collaborators },
            context.user.email,
            buildAdminFnAuditContext(context, '$adminUpdateProjectCollaborators')
        )
    );

const AuditOutcomeEnum = z.enum(['success', 'denied', 'failure', 'error']);
const AuditResourceTypeEnum = z.enum([
    'project',
    'commit',
    'asset',
    'wall',
    'device',
    'user',
    'upload_token',
    'start_route',
    'ws_message',
    'portal_token',
    'bootstrap',
    'config',
    'smtp',
    'scope',
    'signage_slideshow',
    'unknown'
]);
const AuditSurfaceEnum = z.enum(['http', 'serverfn', 'ws', 'yjs', 'job', 'system', 'unknown']);

export const $adminListAuditsPage = createServerFn({ method: 'GET' })
    .middleware([adminMiddleware])
    .validator(
        z.object({
            projectId: z.string().nullable().optional(),
            limit: z.number().int().min(1).max(100).optional(),
            cursor: z
                .object({
                    createdAt: z.number().int().min(1),
                    id: z.string().min(1)
                })
                .nullable()
                .optional(),
            outcomes: z.array(AuditOutcomeEnum).max(8).optional(),
            resourceTypes: z.array(AuditResourceTypeEnum).max(20).optional(),
            operation: z.string().min(1).max(120).optional(),
            surface: AuditSurfaceEnum.optional(),
            actorId: z.string().min(1).max(200).optional(),
            reasonCode: z.string().min(1).max(120).optional()
        })
    )
    .handler(async ({ data }) =>
        adminListAuditsPage({
            projectId: data.projectId ?? null,
            limit: data.limit,
            cursor: data.cursor ?? null,
            outcomes: data.outcomes,
            resourceTypes: data.resourceTypes,
            operation: data.operation,
            surface: data.surface,
            actorId: data.actorId,
            reasonCode: data.reasonCode
        })
    );

export const $adminGetStats = createServerFn({ method: 'GET' })
    .middleware([adminMiddleware])
    .handler(async () => adminGetStats());

export const $adminListWalls = createServerFn({ method: 'GET' })
    .middleware([adminMiddleware])
    .handler(async () => adminListWalls());

export const $adminListPublicAssets = createServerFn({ method: 'GET' })
    .middleware([operatorMiddleware])
    .handler(async () => adminListPublicAssets());

export const $adminDeletePublicAsset = createServerFn({ method: 'POST' })
    .middleware([operatorMiddleware])
    .validator(z.object({ id: z.string() }))
    .handler(async ({ data, context }) => adminDeletePublicAsset(data.id, context.user.email));

export const $adminUnbindWall = createServerFn({ method: 'POST' })
    .middleware([adminMiddleware])
    .validator(z.object({ wallId: z.string() }))
    .handler(async ({ data }) => adminUnbindWall(data.wallId));

export const $adminCreateWall = createServerFn({ method: 'POST' })
    .middleware([adminMiddleware])
    .validator(z.object({ wallId: z.string(), name: z.string().optional().nullable() }))
    .handler(async ({ data }) => adminCreateWall({ wallId: data.wallId, name: data.name ?? null }));

export const $adminGetWall = createServerFn({ method: 'GET' })
    .middleware([adminMiddleware])
    .validator(z.object({ wallId: z.string() }))
    .handler(async ({ data }) => adminGetWall(data.wallId));

export const $adminUpdateWallMetadata = createServerFn({ method: 'POST' })
    .middleware([adminMiddleware])
    .validator(
        z.object({
            wallId: z.string(),
            name: z.string().optional().nullable(),
            site: z.string().optional().nullable(),
            notes: z.string().optional().nullable()
        })
    )
    .handler(async ({ data }) =>
        adminUpdateWallMetadata({
            wallId: data.wallId,
            name: data.name ?? null,
            site: data.site ?? null,
            notes: data.notes ?? null
        })
    );

export const $adminUpdateWallLayoutTemplate = createServerFn({ method: 'POST' })
    .middleware([adminMiddleware])
    .validator(
        z.object({
            wallId: z.string(),
            layout: StageLayout.nullable()
        })
    )
    .handler(({ data, context }) =>
        adminUpdateWallLayoutTemplate({
            wallId: data.wallId,
            layout: data.layout,
            actorEmail: context.user.email
        })
    );

export const $adminUpdateWallOpenToEditors = createServerFn({ method: 'POST' })
    .middleware([adminMiddleware])
    .validator(
        z.object({
            wallId: z.string(),
            openToEditors: z.boolean()
        })
    )
    .handler(({ data, context }) =>
        adminUpdateWallOpenToEditors({
            wallId: data.wallId,
            openToEditors: data.openToEditors,
            actorEmail: context.user.email
        })
    );

export const $adminDeleteWall = createServerFn({ method: 'POST' })
    .middleware([adminMiddleware])
    .validator(z.object({ wallId: z.string() }))
    .handler(async ({ data }) => adminDeleteWall(data.wallId));

export const $adminGetUploadToken = createServerFn({ method: 'POST' })
    .middleware([operatorMiddleware])
    .handler(async ({ context }) => {
        const { createUploadToken } = await import('~/lib/uploadTokens');
        const { PUBLIC_ASSET_PROJECT_ID } = await import('~/lib/constants');
        const token = createUploadToken(PUBLIC_ASSET_PROJECT_ID, context.user.email);
        await logAuditSuccess({
            action: 'ADMIN_UPLOAD_TOKEN_CREATED',
            actorId: context.user.email,
            projectId: PUBLIC_ASSET_PROJECT_ID,
            resourceType: 'upload_token',
            resourceId: `project:${PUBLIC_ASSET_PROJECT_ID}`,
            ...buildAdminFnAuditContext(context, '$adminGetUploadToken')
        });
        return token;
    });

export const $adminGetWallBindingMeta = createServerFn({ method: 'GET' })
    .middleware([adminMiddleware])
    .validator(
        z.object({
            boundProjectId: z.string().nullable().optional(),
            boundCommitId: z.string().nullable().optional(),
            boundSlideId: z.string().nullable().optional()
        })
    )
    .handler(async ({ data }) =>
        adminGetWallBindingMeta({
            boundProjectId: data.boundProjectId ?? null,
            boundCommitId: data.boundCommitId ?? null,
            boundSlideId: data.boundSlideId ?? null
        })
    );

export const $adminListConfig = createServerFn({ method: 'GET' })
    .middleware([adminMiddleware])
    .handler(async () => adminListConfig());

export const $adminSetConfig = createServerFn({ method: 'POST' })
    .middleware([adminMiddleware])
    .validator(
        z.object({
            key: z.string(),
            value: z.string()
        })
    )
    .handler(async ({ data, context }) =>
        adminSetConfig(
            { key: data.key, value: data.value, updatedBy: context.user.email },
            buildAdminFnAuditContext(context, '$adminSetConfig')
        )
    );

export const $adminSendSmtpTest = createServerFn({ method: 'POST' })
    .middleware([adminMiddleware])
    .validator(z.object({ to: z.email() }))
    .handler(async ({ data, context }) =>
        adminSendSmtpTest(
            { to: data.to, actorEmail: context.user.email },
            buildAdminFnAuditContext(context, '$adminSendSmtpTest')
        )
    );

export const $adminDevicesList = createServerFn({ method: 'GET' })
    .middleware([adminMiddleware])
    .handler(async () => adminDevicesList());

export const $adminDevicesForWall = createServerFn({ method: 'GET' })
    .middleware([adminMiddleware])
    .validator(z.object({ wallId: z.string() }))
    .handler(async ({ data }) => adminListDevicesForWall(data.wallId));

export const $adminDevicesEnrollBySignature = createServerFn({ method: 'POST' })
    .middleware([adminMiddleware])
    .validator(
        z.object({
            id: z.string(),
            signature: z.string(),
            kind: z.enum(['wall', 'gallery', 'controller']),
            wallId: z.string()
        })
    )
    .handler(async ({ data, context }) =>
        adminDevicesEnrollBySignature({
            id: data.id,
            signature: data.signature,
            kind: data.kind,
            wallId: data.wallId,
            assignedBy: context.user.email
        })
    );

export const $adminDeleteDevice = createServerFn({ method: 'POST' })
    .middleware([adminMiddleware])
    .validator(
        z.object({
            id: z.string()
        })
    )
    .handler(async ({ data, context }) =>
        adminDeleteDevice({
            id: data.id,
            deletedBy: context.user.email
        })
    );

export const $adminSetUserBanStatus = createServerFn({ method: 'POST' })
    .middleware([adminMiddleware])
    .validator(
        z.object({
            userId: z.string(),
            banned: z.boolean()
        })
    )
    .handler(async ({ data, context }) =>
        adminSetUserBanStatus({
            userId: data.userId,
            banned: data.banned,
            actorEmail: context.user.email
        })
    );

export const $adminSetUserRole = createServerFn({ method: 'POST' })
    .middleware([adminMiddleware])
    .validator(
        z.object({
            userId: z.string().optional().nullable(),
            userEmail: z.string().optional().nullable(),
            role: z.enum(['admin', 'operator', 'user'])
        })
    )
    .handler(async ({ data, context }) =>
        adminSetUserRole({
            userId: data.userId,
            userEmail: data.userEmail,
            role: data.role,
            actorEmail: context.user.email
        })
    );

export const $adminSetUserTrustedPublisher = createServerFn({ method: 'POST' })
    .middleware([operatorMiddleware])
    .validator(
        z.object({
            userId: z.string(),
            trustedPublisher: z.boolean()
        })
    )
    .handler(async ({ data, context }) =>
        adminSetUserTrustedPublisher({
            userId: data.userId,
            trustedPublisher: data.trustedPublisher,
            actorEmail: context.user.email
        })
    );

export const $adminSetUserCanManageSignage = createServerFn({ method: 'POST' })
    .middleware([adminMiddleware])
    .validator(
        z.object({
            userId: z.string(),
            canManageSignage: z.boolean()
        })
    )
    .handler(async ({ data, context }) =>
        adminSetUserCanManageSignage({
            userId: data.userId,
            canManageSignage: data.canManageSignage,
            actorEmail: context.user.email
        })
    );

export const $adminImpersonateUser = createServerFn({ method: 'POST' })
    .middleware([adminMiddleware])
    .validator(
        z.object({
            userId: z.string()
        })
    )
    .handler(async ({ data, context }) =>
        adminImpersonateUser({
            userId: data.userId,
            actorEmail: context.user.email,
            actorRole: typeof context.user.role === 'string' ? context.user.role : undefined
        })
    );

export const $adminStopImpersonation = createServerFn({ method: 'POST' })
    .middleware([authMiddleware])
    .handler(async ({ context }) =>
        adminStopImpersonation({
            currentEmail: context.user.email,
            currentRole: typeof context.user.role === 'string' ? context.user.role : undefined
        })
    );
