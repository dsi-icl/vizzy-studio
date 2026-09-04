import { authMiddleware, freshAuthMiddleware } from '@repo/auth/tanstack/middleware';
import { Collaborator, ProjectVisibility } from '@repo/db/schema';
import { createServerFn } from '@tanstack/react-start';

import { createUploadToken, validateUploadToken } from '~/lib/uploadTokens';
import { z } from '~/lib/zod';
import { logAuditDenied, logAuditSuccess } from '~/server/audit';
import { dbCol } from '~/server/collections';
import {
    actorFromAuthContext,
    canEditProject,
    canPublishProject,
    canViewProject,
    ownsProject,
    resolveProjectIdForAsset,
    resolveProjectIdForCommit,
    resolveProjectIdForUploadToken
} from '~/server/projectAuthz';
import type { AuthContext } from '~/server/requestAuthContext';

import {
    archiveProject,
    copySlideInCommit,
    createBranchHead,
    createProject,
    deleteAsset,
    deleteSlideFromCommit,
    ensureMutableHead,
    getAudits,
    getAuditsPage,
    getCommit,
    getProject,
    getProjectCommits,
    listAssets,
    listAssetsByUrlsForPicker,
    listKnownTags,
    listProjects,
    listPublishedProjects,
    promoteBranchHead,
    publishCommit,
    publishCustomRenderProject,
    restoreProject,
    revokeUploadTokenForActor,
    updateProject
} from './projects';

const HttpUrlString = z
    .string()
    .refine((val) => !val || /^https?:\/\//i.test(val), 'Must be a valid HTTP or HTTPS URL');

const CreateProjectInput = z.object({
    name: z.string().min(1, 'Name is required'),
    authorOrganisation: z.string().min(1, 'Author/Organisation is required'),
    description: z.string().default(''),
    tags: z.array(z.string()).default([]),
    visibility: ProjectVisibility.default('private'),
    heroImages: z.array(z.string()).default([]),
    customControlUrl: HttpUrlString.optional(),
    customRenderUrl: HttpUrlString.optional(),
    customRenderCompat: z.boolean().default(false),
    customRenderProxy: z.boolean().default(false),
    collaborators: z.array(Collaborator).default([])
});

const UpdateProjectInput = z.object({
    id: z.string(),
    name: z.string().min(1, 'Name is required').optional(),
    authorOrganisation: z.string().min(1, 'Author/Organisation is required').optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    visibility: ProjectVisibility.optional(),
    heroImages: z.array(z.string()).optional(),
    customControlUrl: HttpUrlString.optional(),
    customRenderUrl: HttpUrlString.optional(),
    customRenderCompat: z.boolean().optional(),
    customRenderProxy: z.boolean().optional(),
    collaborators: z.array(Collaborator).optional(),
    publishedCommitId: z.string().nullable().optional()
});
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
    'unknown'
]);
const AuditSurfaceEnum = z.enum(['http', 'serverfn', 'ws', 'yjs', 'job', 'system', 'unknown']);

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

function buildProjectFnAuditContext(context: unknown, operation: string) {
    return {
        authContext: authContextFromServerFnContext(context),
        executionContext: {
            surface: 'serverfn' as const,
            operation
        }
    };
}

async function denyProjectFn(params: {
    context: unknown;
    operation: string;
    reasonCode: string;
    projectId?: string | null;
    resourceType?: 'project' | 'commit' | 'asset' | 'upload_token' | 'unknown';
    resourceId?: string | null;
}) {
    await logAuditDenied({
        action: 'PROJECTS_FN_ACCESS_DENIED',
        projectId: params.projectId ?? null,
        resourceType: params.resourceType ?? 'unknown',
        resourceId: params.resourceId ?? null,
        reasonCode: params.reasonCode,
        authContext: authContextFromServerFnContext(params.context),
        executionContext: {
            surface: 'serverfn',
            operation: params.operation
        }
    });
}

export const $listProjects = createServerFn({ method: 'GET' })
    .validator(z.object({ includeArchived: z.boolean().optional() }))
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        return listProjects(context.user.email, data.includeArchived);
    });

export const $listPublishedProjects = createServerFn({ method: 'GET' }).handler(async () => {
    return listPublishedProjects();
});

export const $listKnownTags = createServerFn({ method: 'GET' })
    .middleware([authMiddleware])
    .handler(async ({ context }) => {
        return listKnownTags(context.user.email);
    });

export const $listAssets = createServerFn({ method: 'GET' })
    .validator(z.object({ projectId: z.string() }))
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$listAssets',
                reasonCode: 'MISSING_ACTOR',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        const allowed = await canViewProject(actor, data.projectId);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$listAssets',
                reasonCode: 'PROJECT_VIEW_FORBIDDEN',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        return listAssets(data.projectId);
    });

export const $listAssetsByUrlsForPicker = createServerFn({ method: 'POST' })
    .validator(
        z.object({
            projectId: z.string(),
            urls: z.array(z.string()).max(200)
        })
    )
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$listAssetsByUrlsForPicker',
                reasonCode: 'MISSING_ACTOR',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        const allowed = await canViewProject(actor, data.projectId);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$listAssetsByUrlsForPicker',
                reasonCode: 'PROJECT_VIEW_FORBIDDEN',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        return listAssetsByUrlsForPicker(data.projectId, data.urls);
    });

export const $getProject = createServerFn({ method: 'GET' })
    .validator(z.object({ id: z.string() }))
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const project = await getProject(data.id);
        if (!project) throw new Error('Project not found');
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$getProject',
                reasonCode: 'MISSING_ACTOR',
                projectId: data.id,
                resourceType: 'project',
                resourceId: data.id
            });
            throw new Error('Access denied');
        }
        const allowed = await canViewProject(actor, data.id);
        if (!allowed) {
            const isPublicPublishedProject =
                project.visibility === 'public' && Boolean(project.publishedCommitId);
            if (!isPublicPublishedProject) {
                await denyProjectFn({
                    context,
                    operation: '$getProject',
                    reasonCode: 'PROJECT_VIEW_FORBIDDEN',
                    projectId: data.id,
                    resourceType: 'project',
                    resourceId: data.id
                });
                throw new Error('Access denied');
            }
        }
        return project;
    });

export const $getCommit = createServerFn({ method: 'GET' })
    .validator(z.object({ id: z.string() }))
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const commit = await getCommit(data.id);
        if (!commit) throw new Error('Commit not found');
        const commitProjectId = String(commit.projectId);
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$getCommit',
                reasonCode: 'MISSING_ACTOR',
                resourceType: 'commit',
                resourceId: data.id
            });
            throw new Error('Access denied');
        }
        const allowed = await canViewProject(actor, commitProjectId);
        if (!allowed) {
            const project = await getProject(commitProjectId);
            const isPublishedCommitOfPublicProject =
                project?.visibility === 'public' && project.publishedCommitId === commit.id;
            if (!isPublishedCommitOfPublicProject) {
                await denyProjectFn({
                    context,
                    operation: '$getCommit',
                    reasonCode: 'PROJECT_VIEW_FORBIDDEN',
                    projectId: commitProjectId,
                    resourceType: 'commit',
                    resourceId: data.id
                });
                throw new Error('Access denied');
            }
        }
        return commit;
    });

export const $createProject = createServerFn({ method: 'POST' })
    .validator(CreateProjectInput)
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        return createProject(
            data,
            context.user.email,
            buildProjectFnAuditContext(context, '$createProject')
        );
    });

export const $updateProject = createServerFn({ method: 'POST' })
    .validator(UpdateProjectInput)
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$updateProject',
                reasonCode: 'MISSING_ACTOR',
                projectId: data.id,
                resourceType: 'project',
                resourceId: data.id
            });
            throw new Error('Access denied');
        }
        const allowed = await canEditProject(actor, data.id);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$updateProject',
                reasonCode: 'PROJECT_EDIT_FORBIDDEN',
                projectId: data.id,
                resourceType: 'project',
                resourceId: data.id
            });
            throw new Error('Access denied');
        }

        if (data.collaborators !== undefined) {
            const isOwner = (await ownsProject(actor, data.id)) || actor.role === 'admin';
            if (!isOwner) {
                await denyProjectFn({
                    context,
                    operation: '$updateProject',
                    reasonCode: 'PROJECT_OWNER_REQUIRED',
                    projectId: data.id,
                    resourceType: 'project',
                    resourceId: data.id
                });
                throw new Error('Only the project owner can update collaborators');
            }
        }

        if (
            (data.publishedCommitId !== undefined && data.publishedCommitId !== null) ||
            data.visibility === 'public'
        ) {
            if (!canPublishProject(actor)) {
                await denyProjectFn({
                    context,
                    operation: '$updateProject',
                    reasonCode: 'PROJECT_PUBLISH_FORBIDDEN',
                    projectId: data.id,
                    resourceType: 'project',
                    resourceId: data.id
                });
                throw new Error('Publish access denied');
            }
        }

        return updateProject(
            data,
            context.user.email,
            buildProjectFnAuditContext(context, '$updateProject')
        );
    });

export const $archiveProject = createServerFn({ method: 'POST' })
    .validator(z.object({ id: z.string() }))
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$archiveProject',
                reasonCode: 'MISSING_ACTOR',
                projectId: data.id,
                resourceType: 'project',
                resourceId: data.id
            });
            throw new Error('Access denied');
        }
        const allowed = await ownsProject(actor, data.id);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$archiveProject',
                reasonCode: 'PROJECT_OWNER_REQUIRED',
                projectId: data.id,
                resourceType: 'project',
                resourceId: data.id
            });
            throw new Error('Access denied');
        }
        await archiveProject(
            data.id,
            context.user.email,
            buildProjectFnAuditContext(context, '$archiveProject')
        );
    });

export const $deleteAsset = createServerFn({ method: 'POST' })
    .validator(z.object({ id: z.string() }))
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const assetRecord = await dbCol.assets.findById(data.id);
        if (!assetRecord) throw new Error('Asset not found');
        const projectId = await resolveProjectIdForAsset(data.id);
        if (!projectId) throw new Error('Asset not found');
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$deleteAsset',
                reasonCode: 'MISSING_ACTOR',
                projectId,
                resourceType: 'asset',
                resourceId: data.id
            });
            throw new Error('Access denied');
        }
        if (assetRecord.public && actor.role !== 'admin') {
            await denyProjectFn({
                context,
                operation: '$deleteAsset',
                reasonCode: 'PUBLIC_ASSET_DELETE_ADMIN_REQUIRED',
                projectId,
                resourceType: 'asset',
                resourceId: data.id
            });
            throw new Error('Access denied');
        }
        const allowed = await canEditProject(actor, projectId);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$deleteAsset',
                reasonCode: 'PROJECT_EDIT_FORBIDDEN',
                projectId,
                resourceType: 'asset',
                resourceId: data.id
            });
            throw new Error('Access denied');
        }
        await deleteAsset(
            data.id,
            context.user.email,
            buildProjectFnAuditContext(context, '$deleteAsset')
        );
    });

export const $restoreProject = createServerFn({ method: 'POST' })
    .validator(z.object({ id: z.string() }))
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$restoreProject',
                reasonCode: 'MISSING_ACTOR',
                projectId: data.id,
                resourceType: 'project',
                resourceId: data.id
            });
            throw new Error('Access denied');
        }
        const allowed = await ownsProject(actor, data.id);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$restoreProject',
                reasonCode: 'PROJECT_OWNER_REQUIRED',
                projectId: data.id,
                resourceType: 'project',
                resourceId: data.id
            });
            throw new Error('Access denied');
        }
        await restoreProject(
            data.id,
            context.user.email,
            buildProjectFnAuditContext(context, '$restoreProject')
        );
    });

export const $publishCommit = createServerFn({ method: 'POST' })
    .validator(z.object({ projectId: z.string(), commitId: z.string().nullable() }))
    .middleware([freshAuthMiddleware])
    .handler(async ({ context, data }) => {
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$publishCommit',
                reasonCode: 'MISSING_ACTOR',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        const allowed = await canEditProject(actor, data.projectId);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$publishCommit',
                reasonCode: 'PROJECT_EDIT_FORBIDDEN',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        if (data.commitId !== null && !canPublishProject(actor)) {
            await denyProjectFn({
                context,
                operation: '$publishCommit',
                reasonCode: 'PROJECT_PUBLISH_FORBIDDEN',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Publish access denied');
        }
        return publishCommit(
            data.projectId,
            data.commitId,
            context.user.email,
            buildProjectFnAuditContext(context, '$publishCommit')
        );
    });

export const $publishCustomRenderProject = createServerFn({ method: 'POST' })
    .validator(z.object({ projectId: z.string() }))
    .middleware([freshAuthMiddleware])
    .handler(async ({ context, data }) => {
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$publishCustomRenderProject',
                reasonCode: 'MISSING_ACTOR',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        const allowed = await canEditProject(actor, data.projectId);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$publishCustomRenderProject',
                reasonCode: 'PROJECT_EDIT_FORBIDDEN',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        if (!canPublishProject(actor)) {
            await denyProjectFn({
                context,
                operation: '$publishCustomRenderProject',
                reasonCode: 'PROJECT_PUBLISH_FORBIDDEN',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Publish access denied');
        }
        return publishCustomRenderProject(
            data.projectId,
            context.user.email,
            buildProjectFnAuditContext(context, '$publishCustomRenderProject')
        );
    });

export const $getAudits = createServerFn({ method: 'GET' })
    .validator(z.object({ projectId: z.string() }))
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$getAudits',
                reasonCode: 'MISSING_ACTOR',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        const allowed = await canViewProject(actor, data.projectId);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$getAudits',
                reasonCode: 'PROJECT_VIEW_FORBIDDEN',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        return getAudits(data.projectId);
    });

export const $getAuditsPage = createServerFn({ method: 'GET' })
    .validator(
        z.object({
            projectId: z.string(),
            limit: z.number().int().min(1).max(100).optional(),
            cursor: z
                .object({
                    createdAt: z.number().int().min(1),
                    id: z.string().min(1)
                })
                .nullable()
                .optional(),
            outcomes: z.array(AuditOutcomeEnum).max(8).optional(),
            actions: z.array(z.string().min(1)).max(30).optional(),
            actorIds: z.array(z.string().min(1)).max(20).optional(),
            resourceTypes: z.array(AuditResourceTypeEnum).max(20).optional(),
            reasonCodes: z.array(z.string().min(1)).max(20).optional(),
            operation: z.string().min(1).max(120).optional(),
            surface: AuditSurfaceEnum.optional(),
            fromCreatedAt: z.number().int().min(1).optional(),
            toCreatedAt: z.number().int().min(1).optional()
        })
    )
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$getAuditsPage',
                reasonCode: 'MISSING_ACTOR',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        const allowed = await canViewProject(actor, data.projectId);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$getAuditsPage',
                reasonCode: 'PROJECT_VIEW_FORBIDDEN',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        return getAuditsPage(data.projectId, {
            limit: data.limit,
            cursor: data.cursor ?? null,
            outcomes: data.outcomes,
            actions: data.actions,
            actorIds: data.actorIds,
            resourceTypes: data.resourceTypes,
            reasonCodes: data.reasonCodes,
            operation: data.operation,
            surface: data.surface,
            fromCreatedAt: data.fromCreatedAt,
            toCreatedAt: data.toCreatedAt
        });
    });

export const $ensureMutableHead = createServerFn({ method: 'POST' })
    .validator(z.object({ projectId: z.string() }))
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$ensureMutableHead',
                reasonCode: 'MISSING_ACTOR',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        const allowed = await canEditProject(actor, data.projectId);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$ensureMutableHead',
                reasonCode: 'PROJECT_EDIT_FORBIDDEN',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        return ensureMutableHead(
            data.projectId,
            context.user.email,
            buildProjectFnAuditContext(context, '$ensureMutableHead')
        );
    });

export const $getProjectCommits = createServerFn({ method: 'GET' })
    .validator(z.object({ projectId: z.string() }))
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$getProjectCommits',
                reasonCode: 'MISSING_ACTOR',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        const allowed = await canViewProject(actor, data.projectId);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$getProjectCommits',
                reasonCode: 'PROJECT_VIEW_FORBIDDEN',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        return getProjectCommits(data.projectId);
    });

export const $createBranchHead = createServerFn({ method: 'POST' })
    .validator(z.object({ projectId: z.string(), sourceCommitId: z.string() }))
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$createBranchHead',
                reasonCode: 'MISSING_ACTOR',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        const allowed = await canEditProject(actor, data.projectId);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$createBranchHead',
                reasonCode: 'PROJECT_EDIT_FORBIDDEN',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        return createBranchHead(
            data.projectId,
            data.sourceCommitId,
            context.user.email,
            buildProjectFnAuditContext(context, '$createBranchHead')
        );
    });

export const $promoteBranchHead = createServerFn({ method: 'POST' })
    .validator(z.object({ projectId: z.string(), branchCommitId: z.string() }))
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$promoteBranchHead',
                reasonCode: 'MISSING_ACTOR',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        const allowed = await canEditProject(actor, data.projectId);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$promoteBranchHead',
                reasonCode: 'PROJECT_EDIT_FORBIDDEN',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        return promoteBranchHead(
            data.projectId,
            data.branchCommitId,
            context.user.email,
            buildProjectFnAuditContext(context, '$promoteBranchHead')
        );
    });

// ── Slide operations ─────────────────────────────────────────────────────────

export const $copySlideInCommit = createServerFn({ method: 'POST' })
    .validator(
        z.object({
            commitId: z.string(),
            sourceSlideId: z.string(),
            newSlideId: z.string(),
            newSlideName: z.string()
        })
    )
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const projectId = await resolveProjectIdForCommit(data.commitId);
        if (!projectId) throw new Error('Commit not found');
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$copySlideInCommit',
                reasonCode: 'MISSING_ACTOR',
                projectId,
                resourceType: 'commit',
                resourceId: data.commitId
            });
            throw new Error('Access denied');
        }
        const allowed = await canEditProject(actor, projectId);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$copySlideInCommit',
                reasonCode: 'PROJECT_EDIT_FORBIDDEN',
                projectId,
                resourceType: 'commit',
                resourceId: data.commitId
            });
            throw new Error('Access denied');
        }
        return copySlideInCommit(
            data.commitId,
            data.sourceSlideId,
            data.newSlideId,
            data.newSlideName,
            context.user.email,
            buildProjectFnAuditContext(context, '$copySlideInCommit')
        );
    });

export const $deleteSlideFromCommit = createServerFn({ method: 'POST' })
    .validator(z.object({ commitId: z.string(), slideId: z.string() }))
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const projectId = await resolveProjectIdForCommit(data.commitId);
        if (!projectId) throw new Error('Commit not found');
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$deleteSlideFromCommit',
                reasonCode: 'MISSING_ACTOR',
                projectId,
                resourceType: 'commit',
                resourceId: data.commitId
            });
            throw new Error('Access denied');
        }
        const allowed = await canEditProject(actor, projectId);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$deleteSlideFromCommit',
                reasonCode: 'PROJECT_EDIT_FORBIDDEN',
                projectId,
                resourceType: 'commit',
                resourceId: data.commitId
            });
            throw new Error('Access denied');
        }
        return deleteSlideFromCommit(
            data.commitId,
            data.slideId,
            context.user.email,
            buildProjectFnAuditContext(context, '$deleteSlideFromCommit')
        );
    });

// ── Upload tokens ─────────────────────────────────────────────────────────────

export const $createUploadToken = createServerFn({ method: 'POST' })
    .validator(z.object({ projectId: z.string() }))
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$createUploadToken',
                reasonCode: 'MISSING_ACTOR',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        const allowed = await canEditProject(actor, data.projectId);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$createUploadToken',
                reasonCode: 'PROJECT_EDIT_FORBIDDEN',
                projectId: data.projectId,
                resourceType: 'project',
                resourceId: data.projectId
            });
            throw new Error('Access denied');
        }
        const token = createUploadToken(data.projectId, context.user.email);
        await logAuditSuccess({
            action: 'UPLOAD_TOKEN_CREATED',
            actorId: context.user.email,
            projectId: data.projectId,
            resourceType: 'upload_token',
            resourceId: `project:${data.projectId}`,
            ...buildProjectFnAuditContext(context, '$createUploadToken')
        });
        return token;
    });

export const $revokeUploadToken = createServerFn({ method: 'POST' })
    .validator(z.object({ token: z.string() }))
    .middleware([authMiddleware])
    .handler(async ({ context, data }) => {
        const projectId = resolveProjectIdForUploadToken(data.token);
        if (!projectId) return;
        const actor = actorFromAuthContext(context);
        if (!actor) {
            await denyProjectFn({
                context,
                operation: '$revokeUploadToken',
                reasonCode: 'MISSING_ACTOR',
                projectId,
                resourceType: 'upload_token'
            });
            throw new Error('Access denied');
        }
        const allowed = await canEditProject(actor, projectId);
        if (!allowed) {
            await denyProjectFn({
                context,
                operation: '$revokeUploadToken',
                reasonCode: 'PROJECT_EDIT_FORBIDDEN',
                projectId,
                resourceType: 'upload_token'
            });
            throw new Error('Access denied');
        }
        await revokeUploadTokenForActor(
            data.token,
            context.user.email,
            buildProjectFnAuditContext(context, '$revokeUploadToken')
        );
    });

export const $validateUploadToken = createServerFn({ method: 'POST' })
    .validator(z.object({ token: z.string() }))
    .handler(async ({ data }) => {
        return validateUploadToken(data.token);
    });
