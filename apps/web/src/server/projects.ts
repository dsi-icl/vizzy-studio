import '@tanstack/react-start/server-only';
import { getConfigValue } from '@repo/db/config';
import type {
    AuthContext,
    AuditResourceType,
    CommitDocument,
    ProjectStage
} from '@repo/db/documents';
import {
    DEFAULT_STAGE_LAYOUT,
    StageLayout,
    stageLayoutsEqual,
    type Collaborator,
    type CollaboratorRole,
    type ProjectVisibility
} from '@repo/db/schema';

import type { AuditExecutionContextInput } from '~/server/audit';

interface CreateProjectInput {
    name: string;
    authorOrganisation: string;
    description: string;
    tags: string[];
    visibility: ProjectVisibility;
    heroImages: string[];
    customControlUrl?: string | null;
    customRenderUrl?: string | null;
    customRenderCompat: boolean;
    customRenderProxy: boolean;
    collaborators: Collaborator[];
}

interface UpdateProjectInput {
    id: string;
    name?: string;
    authorOrganisation?: string;
    description?: string;
    tags?: string[];
    visibility?: ProjectVisibility;
    heroImages?: string[];
    customControlUrl?: string;
    customRenderUrl?: string;
    customRenderCompat?: boolean;
    customRenderProxy?: boolean;
    collaborators?: Array<{ email: string; role: CollaboratorRole }>;
}

export interface StageLayoutLimits {
    maxColumns: number;
    maxRows: number;
}

export type AuditOutcome = 'success' | 'denied' | 'failure' | 'error';

export interface ProjectAuditCursor {
    createdAt: number;
    id: string;
}

export interface ProjectAuditListInput {
    limit?: number;
    cursor?: ProjectAuditCursor | null;
    outcomes?: AuditOutcome[];
    actions?: string[];
    actorIds?: string[];
    resourceTypes?: AuditResourceType[];
    reasonCodes?: string[];
    operation?: string;
    surface?: 'http' | 'serverfn' | 'ws' | 'yjs' | 'job' | 'system' | 'unknown' | null;
    fromCreatedAt?: number;
    toCreatedAt?: number;
}

import {
    runCommitPersistenceTask,
    scopedState,
    updateProjectCustomRenderSettings,
    updateRuntimeStageLayout
} from '~/lib/busState';
import { revokeUploadToken, validateUploadToken } from '~/lib/uploadTokens';
import { logAuditSuccess } from '~/server/audit';
import { dbCol, collections } from '~/server/collections';

export interface ProjectAuditContext {
    authContext?: AuthContext | null;
    executionContext?: AuditExecutionContextInput | null;
}

function withProjectAuditContext(auditContext?: ProjectAuditContext) {
    return {
        authContext: auditContext?.authContext ?? null,
        executionContext: auditContext?.executionContext ?? null
    };
}

function tokenHint(token: string): string {
    const trimmed = token.trim();
    if (!trimmed) return 'token:unknown';
    return `token:...${trimmed.slice(-8)}`;
}

function normalizeAssetFilename(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const noQuery = trimmed.split('?')[0]?.split('#')[0] ?? trimmed;
    if (noQuery.startsWith('/api/assets/')) {
        const filename = noQuery.slice('/api/assets/'.length);
        return filename || null;
    }
    return noQuery;
}

export function getDefaultStage(project: { defaultStageId: string; stages: ProjectStage[] }) {
    return project.stages.find((stage) => stage.id === project.defaultStageId) ?? null;
}

export function getProjectStage(
    project: { stages: ProjectStage[] },
    stageId: string
): ProjectStage {
    const stage = project.stages.find(({ id }) => id === stageId);
    if (!stage) throw new Error('Stage not found');
    return stage;
}

export async function getStageLayoutLimits(): Promise<StageLayoutLimits> {
    const [configuredColumns, configuredRows] = await Promise.all([
        getConfigValue<number>('stage.maxColumns'),
        getConfigValue<number>('stage.maxRows')
    ]);
    return {
        maxColumns:
            typeof configuredColumns === 'number' &&
            Number.isInteger(configuredColumns) &&
            configuredColumns > 0
                ? configuredColumns
                : 16,
        maxRows:
            typeof configuredRows === 'number' &&
            Number.isInteger(configuredRows) &&
            configuredRows > 0
                ? configuredRows
                : 4
    };
}

export async function listWallLayoutTemplates() {
    const walls = await dbCol.walls.find({ layoutTemplate: { $ne: null } }, { sort: { name: 1 } });
    return walls
        .filter((wall) => wall.layoutTemplate)
        .map((wall) => ({
            wallId: wall.wallId,
            name: wall.name,
            layout: wall.layoutTemplate!
        }));
}

async function validateStageLayout(
    layoutInput: StageLayout,
    existingLayout?: StageLayout
): Promise<StageLayout> {
    const layout = StageLayout.parse(layoutInput);
    const limits = await getStageLayoutLimits();
    const unchangedGrandfathered =
        existingLayout !== undefined && stageLayoutsEqual(existingLayout, layout);
    if (!unchangedGrandfathered && layout.columns > limits.maxColumns) {
        throw new Error(`Stage columns cannot exceed ${limits.maxColumns}`);
    }
    if (!unchangedGrandfathered && layout.rows > limits.maxRows) {
        throw new Error(`Stage rows cannot exceed ${limits.maxRows}`);
    }
    return layout;
}

export async function listProjects(userEmail: string, includeArchived = false) {
    const filter: Record<string, unknown> = {
        $or: [{ createdBy: userEmail }, { 'collaborators.email': userEmail }]
    };
    if (!includeArchived) {
        filter.deletedAt = { $exists: false };
    }
    const projects = await dbCol.projects.find(filter, { sort: { updatedAt: -1 } });
    return projects;
}

export async function listPublishedProjects() {
    const projectDocs = await dbCol.projects.find(
        { deletedAt: { $exists: false } },
        { sort: { updatedAt: -1 } }
    );

    const visibleProjects = projectDocs.filter((project) => {
        return (
            project.visibility === 'public' &&
            project.stages.some((stage) => !stage.archivedAt && Boolean(stage.publishedCommitId))
        );
    });

    const heroFilenames = Array.from(
        new Set(
            visibleProjects
                .map((project) => normalizeAssetFilename(project.heroImages?.[0]))
                .filter((value): value is string => Boolean(value))
        )
    );

    if (heroFilenames.length === 0) return visibleProjects;

    const heroAssets = await dbCol.assets.findBlurhashMetaByUrls(heroFilenames);

    const heroMetaByFilename = new Map<string, { blurhash?: string; sizes?: number[] }>();
    for (const asset of heroAssets) {
        const filename = normalizeAssetFilename(asset.url);
        if (!filename) continue;
        heroMetaByFilename.set(filename, {
            blurhash: typeof asset.blurhash === 'string' ? asset.blurhash : undefined,
            sizes: Array.isArray(asset.sizes)
                ? asset.sizes.filter((size): size is number => typeof size === 'number')
                : undefined
        });
    }

    return visibleProjects.map((project) => {
        const heroImageMeta = (Array.isArray(project.heroImages) ? project.heroImages : [])
            .map((src) => {
                const filename = normalizeAssetFilename(src);
                const meta = filename ? heroMetaByFilename.get(filename) : undefined;
                return { src, blurhash: meta?.blurhash, sizes: meta?.sizes };
            })
            .filter((entry) => Boolean(entry.src));
        const firstHeroMeta = heroImageMeta[0];
        return {
            ...project,
            heroImageBlurhash: firstHeroMeta?.blurhash,
            heroImageSizes: firstHeroMeta?.sizes,
            heroImageMeta
        };
    });
}

export async function listKnownTags(userEmail: string): Promise<string[]> {
    const tagArrays = await dbCol.projects.findTagsByUser(userEmail);

    const usage = new Map<string, number>();
    for (const tags of tagArrays) {
        const tagList = Array.isArray(tags) ? tags : [];
        for (const raw of tagList) {
            if (typeof raw !== 'string') continue;
            const tag = raw.trim().toLowerCase();
            if (!tag) continue;
            usage.set(tag, (usage.get(tag) ?? 0) + 1);
        }
    }

    return Array.from(usage.entries())
        .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]))
        .map(([tag]) => tag);
}

export async function listAssets(projectId: string) {
    const project = await getProject(projectId);
    if (!project) throw new Error('Project not found');

    const [projectDocs, publicDocs] = await Promise.all([
        dbCol.assets.findByProject(projectId, false, { sort: { createdAt: -1 } }),
        dbCol.assets.findPublic(false, { sort: { createdAt: -1 } })
    ]);

    const projectIds = new Set(projectDocs.map((a) => a.id));
    const publicAssets = publicDocs.filter((d) => !projectIds.has(d.id));

    return [...projectDocs, ...publicAssets];
}

export async function listAssetsByUrlsForPicker(projectId: string, urls: string[]) {
    const project = await getProject(projectId);
    if (!project) throw new Error('Project not found');

    const normalizedUrls = Array.from(
        new Set(
            urls
                .map((value) => normalizeAssetFilename(value))
                .filter((value): value is string => Boolean(value))
        )
    );

    if (normalizedUrls.length === 0) return [];

    return dbCol.assets.findByProjectOrPublicUrls(projectId, normalizedUrls, true);
}

export async function getProject(id: string) {
    const project = await dbCol.projects.findById(id);
    if (!project) return null;
    return project;
}

export async function getCommit(id: string) {
    const commit = await dbCol.commits.findById(id);
    if (!commit) return null;
    return commit;
}

export async function createProject(
    input: CreateProjectInput,
    userEmail: string,
    auditContext?: ProjectAuditContext
) {
    const created = await dbCol.projects.insert({
        ...input,
        collaborators: [{ email: userEmail, role: 'owner' as const }, ...input.collaborators],
        visibility: input.visibility ?? 'private',
        defaultStageId: 'main',
        stages: [
            {
                id: 'main',
                name: 'Main',
                order: 0,
                layout: { ...DEFAULT_STAGE_LAYOUT },
                headCommitId: null,
                publishedCommitId: null
            }
        ],
        createdBy: userEmail
    });

    await logAuditSuccess({
        action: 'PROJECT_CREATED',
        actorId: userEmail,
        projectId: created.id,
        resourceType: 'project',
        resourceId: created.id,
        changes: { name: input.name },
        ...withProjectAuditContext(auditContext)
    });

    process.__BROADCAST_PROJECTS_CHANGED__?.(created.id);
    return created;
}

export async function updateProject(
    input: UpdateProjectInput,
    userEmail: string,
    auditContext?: ProjectAuditContext
) {
    const { id: projectId, ...updates } = input;
    const existing = await dbCol.projects.findById(projectId);
    if (!existing) throw new Error('Project not found');

    // Apply general field updates
    const result = await dbCol.projects.update(projectId, updates as any);
    if (!result) throw new Error('Update failed');

    await logAuditSuccess({
        action: 'PROJECT_UPDATED',
        actorId: userEmail,
        projectId,
        resourceType: 'project',
        resourceId: projectId,
        changes: updates,
        ...withProjectAuditContext(auditContext)
    });

    // Live-push custom render settings changes to any bound walls
    if (
        'customRenderUrl' in updates ||
        'customRenderCompat' in updates ||
        'customRenderProxy' in updates
    ) {
        updateProjectCustomRenderSettings(
            projectId,
            updates.customRenderUrl ?? existing.customRenderUrl ?? undefined,
            updates.customRenderCompat,
            updates.customRenderProxy
        );
    }

    process.__BROADCAST_PROJECTS_CHANGED__?.(projectId);
    // Re-fetch to get the latest state after both updates
    const updated = await dbCol.projects.findById(projectId);
    if (!updated) throw new Error('Project not found after update');
    return updated;
}

export async function createStage(
    projectId: string,
    input: { name: string; layout: StageLayout },
    userEmail: string,
    auditContext?: ProjectAuditContext
) {
    const project = await dbCol.projects.findById(projectId);
    if (!project) throw new Error('Project not found');
    const layout = await validateStageLayout(input.layout);
    const duplicate = project.stages.some(
        (stage) => !stage.archivedAt && stageLayoutsEqual(stage.layout, layout)
    );
    if (duplicate) throw new Error('An active stage already uses this layout');

    const stage: ProjectStage = {
        id: crypto.randomUUID(),
        name: input.name.trim(),
        order: Math.max(-1, ...project.stages.map(({ order }) => order)) + 1,
        layout,
        headCommitId: null,
        publishedCommitId: null
    };
    if (!stage.name) throw new Error('Stage name is required');

    const updated = await dbCol.projects.replaceStages(
        projectId,
        [...project.stages, stage],
        project.defaultStageId
    );
    if (!updated) throw new Error('Project not found');

    await logAuditSuccess({
        action: 'STAGE_CREATED',
        actorId: userEmail,
        projectId,
        resourceType: 'project',
        resourceId: projectId,
        changes: { stageId: stage.id, name: stage.name, layout },
        ...withProjectAuditContext(auditContext)
    });
    process.__BROADCAST_PROJECTS_CHANGED__?.(projectId);
    return stage;
}

export async function updateStage(
    projectId: string,
    stageId: string,
    input: { name?: string; layout?: StageLayout },
    userEmail: string,
    auditContext?: ProjectAuditContext
) {
    const project = await dbCol.projects.findById(projectId);
    if (!project) throw new Error('Project not found');
    const existingStage = getProjectStage(project, stageId);
    if (existingStage.archivedAt) throw new Error('Archived stages cannot be edited');

    const layout = input.layout
        ? await validateStageLayout(input.layout, existingStage.layout)
        : existingStage.layout;
    const duplicate = project.stages.some(
        (stage) =>
            stage.id !== stageId && !stage.archivedAt && stageLayoutsEqual(stage.layout, layout)
    );
    if (duplicate) throw new Error('An active stage already uses this layout');

    const name = input.name === undefined ? existingStage.name : input.name.trim();
    if (!name) throw new Error('Stage name is required');
    const stages = project.stages.map((stage) =>
        stage.id === stageId ? { ...stage, name, layout } : stage
    );
    const updated = await dbCol.projects.replaceStages(projectId, stages, project.defaultStageId);
    if (!updated) throw new Error('Project not found');
    if (!stageLayoutsEqual(existingStage.layout, layout)) {
        updateRuntimeStageLayout(projectId, stageId, layout);
    }

    await logAuditSuccess({
        action: 'STAGE_UPDATED',
        actorId: userEmail,
        projectId,
        resourceType: 'project',
        resourceId: projectId,
        changes: { stageId, name, layout },
        ...withProjectAuditContext(auditContext)
    });
    process.__BROADCAST_PROJECTS_CHANGED__?.(projectId);
    return getProjectStage(updated, stageId);
}

export async function setDefaultStage(
    projectId: string,
    stageId: string,
    userEmail: string,
    auditContext?: ProjectAuditContext
) {
    const project = await dbCol.projects.findById(projectId);
    if (!project) throw new Error('Project not found');
    const stage = getProjectStage(project, stageId);
    if (stage.archivedAt) throw new Error('Archived stages cannot be the default');
    const updated = await dbCol.projects.replaceStages(projectId, project.stages, stageId);
    if (!updated) throw new Error('Project not found');

    await logAuditSuccess({
        action: 'PROJECT_DEFAULT_STAGE_CHANGED',
        actorId: userEmail,
        projectId,
        resourceType: 'project',
        resourceId: projectId,
        changes: { defaultStageId: stageId },
        ...withProjectAuditContext(auditContext)
    });
    process.__BROADCAST_PROJECTS_CHANGED__?.(projectId);
    return updated;
}

export async function archiveStage(
    projectId: string,
    stageId: string,
    userEmail: string,
    auditContext?: ProjectAuditContext
) {
    const project = await dbCol.projects.findById(projectId);
    if (!project) throw new Error('Project not found');
    const stage = getProjectStage(project, stageId);
    if (stage.archivedAt) return stage;
    if (project.defaultStageId === stageId) {
        throw new Error('Choose another default stage before archiving this stage');
    }
    if (stage.publishedCommitId) throw new Error('Unpublish the stage before archiving it');
    if (project.stages.filter((candidate) => !candidate.archivedAt).length <= 1) {
        throw new Error('A project must retain at least one active stage');
    }

    const archivedAt = Date.now();
    const stages = project.stages.map((candidate) =>
        candidate.id === stageId ? { ...candidate, archivedAt } : candidate
    );
    const updated = await dbCol.projects.replaceStages(projectId, stages, project.defaultStageId);
    if (!updated) throw new Error('Project not found');

    await logAuditSuccess({
        action: 'STAGE_ARCHIVED',
        actorId: userEmail,
        projectId,
        resourceType: 'project',
        resourceId: projectId,
        changes: { stageId, archivedAt },
        ...withProjectAuditContext(auditContext)
    });
    process.__BROADCAST_PROJECTS_CHANGED__?.(projectId);
    return getProjectStage(updated, stageId);
}

export async function archiveProject(
    id: string,
    userEmail: string,
    auditContext?: ProjectAuditContext
) {
    const existing = await dbCol.projects.findById(id);
    if (!existing) throw new Error('Project not found');

    await dbCol.projects.softDelete(id, userEmail);

    await logAuditSuccess({
        action: 'PROJECT_ARCHIVED',
        actorId: userEmail,
        projectId: id,
        resourceType: 'project',
        resourceId: id,
        changes: { deletedAt: true },
        ...withProjectAuditContext(auditContext)
    });

    process.__BROADCAST_PROJECTS_CHANGED__?.(id);
}

export async function deleteAsset(
    assetId: string,
    userEmail: string,
    auditContext?: ProjectAuditContext
) {
    const asset = await dbCol.assets.findById(assetId);
    if (!asset || asset.deletedAt) throw new Error('Asset not found');

    const project = await getProject(asset.projectId.toString());
    if (!project) throw new Error('Project not found');

    await dbCol.assets.softDelete(assetId, userEmail);
    await logAuditSuccess({
        action: 'ASSET_DELETED',
        actorId: userEmail,
        projectId: asset.projectId,
        resourceType: 'asset',
        resourceId: assetId,
        ...withProjectAuditContext(auditContext)
    });
}

export async function restoreProject(
    id: string,
    userEmail: string,
    auditContext?: ProjectAuditContext
) {
    const existing = await dbCol.projects.findById(id);
    if (!existing) throw new Error('Project not found');

    await dbCol.projects.updateRaw(id, {
        $set: { updatedAt: Date.now(), _version: dbCol.projects.currentVersion },
        $unset: { deletedAt: '', deletedBy: '' }
    });

    await logAuditSuccess({
        action: 'PROJECT_RESTORED',
        actorId: userEmail,
        projectId: id,
        resourceType: 'project',
        resourceId: id,
        changes: { deletedAt: false },
        ...withProjectAuditContext(auditContext)
    });

    process.__BROADCAST_PROJECTS_CHANGED__?.(id);
}

export async function publishCommit(
    projectId: string,
    stageId: string,
    commitId: string | null,
    userEmail: string,
    auditContext?: ProjectAuditContext
) {
    const existing = await dbCol.projects.findById(projectId);
    if (!existing) throw new Error('Project not found');
    const stage = getProjectStage(existing, stageId);
    if (stage.archivedAt) throw new Error('Archived stages cannot be published');

    if (commitId) {
        const commit = await dbCol.commits.findById(commitId);
        if (!commit) throw new Error('Commit not found');
        if (commit.projectId !== projectId || commit.stageId !== stageId) {
            throw new Error('Commit does not belong to this stage');
        }
    }

    const isPublishing = commitId !== null;

    await dbCol.projects.setStagePublishedCommit(projectId, stageId, commitId);

    await logAuditSuccess({
        action: commitId ? 'STAGE_PUBLISHED' : 'STAGE_UNPUBLISHED',
        actorId: userEmail,
        projectId,
        resourceType: 'project',
        resourceId: projectId,
        changes: { stageId, publishedCommitId: commitId },
        ...withProjectAuditContext(auditContext)
    });

    process.__BROADCAST_PROJECTS_CHANGED__?.(projectId);

    return isPublishing;
}

/**
 * Publish a custom-render project by creating a sentinel commit (one empty slide, no layers)
 * and marking it as the published commit. If already published, this is a no-op.
 */
export async function publishCustomRenderProject(
    projectId: string,
    userEmail: string,
    auditContext?: ProjectAuditContext
) {
    const existing = await dbCol.projects.findById(projectId);
    if (!existing) throw new Error('Project not found');
    if (!existing.customRenderUrl) throw new Error('Project has no custom render URL');
    const stage = getDefaultStage(existing);
    if (!stage) throw new Error('Default stage not found');

    // If already published, no-op
    if (stage.publishedCommitId) return true;

    const sentinel = await dbCol.commits.insert({
        projectId,
        stageId: stage.id,
        parentId: null,
        authorEmail: userEmail,
        message: 'Published (custom render)',
        content: { slides: [{ id: crypto.randomUUID(), order: 0, name: 'Slide 1', layers: [] }] },
        isAutoSave: false,
        isMutableHead: false
    });

    return publishCommit(projectId, stage.id, sentinel.id, userEmail, auditContext);
}

/**
 * Ensure a project has a mutable HEAD commit. Creates one if missing or migrates
 * legacy immutable heads. Returns the stable HEAD commit ID.
 */
export async function ensureMutableHead(
    projectId: string,
    requestedStageId: string | undefined,
    userEmail: string,
    auditContext?: ProjectAuditContext
): Promise<string> {
    const project = await dbCol.projects.findById(projectId);
    if (!project) throw new Error('Project not found');
    const stageId = requestedStageId ?? project.defaultStageId;
    const stage = getProjectStage(project, stageId);
    if (stage.archivedAt) throw new Error('Archived stages cannot be edited');

    // Case 1: HEAD exists and is already mutable
    if (stage.headCommitId) {
        const head = await dbCol.commits.findById(stage.headCommitId);
        if (head?.isMutableHead && head.stageId === stageId) {
            return stage.headCommitId;
        }

        // Case 2: HEAD exists but is immutable (legacy) — create mutable HEAD on top
        const newHead = await dbCol.commits.insert({
            projectId,
            stageId,
            parentId: stage.headCommitId,
            authorEmail: userEmail,
            message: 'HEAD',
            content: head?.content ?? { slides: [] },
            isAutoSave: false,
            isMutableHead: true
        });
        await dbCol.projects.setStageHeadCommit(projectId, stageId, newHead.id);
        await logAuditSuccess({
            action: 'MUTABLE_HEAD_ENSURED',
            actorId: userEmail,
            projectId,
            resourceType: 'commit',
            resourceId: newHead.id,
            changes: { source: 'legacy-head-migration', stageId },
            ...withProjectAuditContext(auditContext)
        });
        return newHead.id;
    }

    // Case 3: No HEAD at all — create fresh mutable HEAD with a default slide
    const newHead = await dbCol.commits.insert({
        projectId,
        stageId,
        parentId: null,
        authorEmail: userEmail,
        message: 'HEAD',
        content: { slides: [{ id: crypto.randomUUID(), order: 0, name: 'Slide 1', layers: [] }] },
        isAutoSave: false,
        isMutableHead: true
    });
    await dbCol.projects.setStageHeadCommit(projectId, stageId, newHead.id);
    await logAuditSuccess({
        action: 'MUTABLE_HEAD_ENSURED',
        actorId: userEmail,
        projectId,
        resourceType: 'commit',
        resourceId: newHead.id,
        changes: { source: 'head-created', stageId },
        ...withProjectAuditContext(auditContext)
    });
    return newHead.id;
}

/**
 * Create a new mutable branch head from any existing commit.
 * Does not change the owning stage's head pointer; it is an independent branch.
 * Returns the new branch head's commit ID.
 */
export async function createBranchHead(
    projectId: string,
    sourceCommitId: string,
    userEmail: string,
    auditContext?: ProjectAuditContext
): Promise<string> {
    const project = await dbCol.projects.findById(projectId);
    if (!project) throw new Error('Project not found');

    const source = await dbCol.commits.findById(sourceCommitId);
    if (!source) throw new Error('Source commit not found');
    if (source.projectId !== projectId) throw new Error('Commit does not belong to project');

    const branchHead = await dbCol.commits.insert({
        projectId,
        stageId: source.stageId,
        parentId: sourceCommitId,
        authorEmail: userEmail,
        message: 'HEAD',
        content: source.content ?? { slides: [] },
        isAutoSave: false,
        isMutableHead: true
    });
    await logAuditSuccess({
        action: 'BRANCH_HEAD_CREATED',
        actorId: userEmail,
        projectId,
        resourceType: 'commit',
        resourceId: branchHead.id,
        changes: { sourceCommitId, stageId: source.stageId },
        ...withProjectAuditContext(auditContext)
    });
    return branchHead.id;
}

/**
 * Promote a branch head to be the project's main HEAD.
 * The old HEAD remains as a branch (isMutableHead stays true).
 */
export async function promoteBranchHead(
    projectId: string,
    branchCommitId: string,
    userEmail: string,
    auditContext?: ProjectAuditContext
): Promise<void> {
    const project = await dbCol.projects.findById(projectId);
    if (!project) throw new Error('Project not found');

    const branch = await dbCol.commits.findById(branchCommitId);
    if (!branch) throw new Error('Branch commit not found');
    if (!branch.isMutableHead) throw new Error('Can only promote a mutable branch head');
    if (branch.projectId !== projectId) throw new Error('Commit does not belong to project');

    const stage = getProjectStage(project, branch.stageId);
    if (stage.archivedAt) throw new Error('Archived stages cannot be promoted');

    await dbCol.projects.setStageHeadCommit(projectId, branch.stageId, branchCommitId);

    await logAuditSuccess({
        action: 'BRANCH_PROMOTED',
        actorId: userEmail,
        projectId,
        resourceType: 'project',
        resourceId: projectId,
        changes: { stageId: branch.stageId, headCommitId: branchCommitId },
        ...withProjectAuditContext(auditContext)
    });
}

export async function getAudits(projectId: string) {
    const project = await dbCol.projects.findById(projectId);
    if (!project) throw new Error('Project not found');

    const audits = await dbCol.audits.findByProject(projectId, { sort: { createdAt: -1 } });
    return audits;
}

export async function getAuditsPage(projectId: string, input: ProjectAuditListInput = {}) {
    const project = await dbCol.projects.findById(projectId);
    if (!project) throw new Error('Project not found');

    return dbCol.audits.queryByProject({
        projectId,
        limit: input.limit,
        cursor: input.cursor ?? null,
        outcomes: input.outcomes,
        actions: input.actions,
        actorIds: input.actorIds,
        resourceTypes: input.resourceTypes,
        reasonCodes: input.reasonCodes,
        operation: input.operation,
        surface: input.surface ?? undefined,
        fromCreatedAt: input.fromCreatedAt,
        toCreatedAt: input.toCreatedAt
    });
}

export async function getProjectCommits(projectId: string, stageId: string) {
    const project = await dbCol.projects.findById(projectId);
    if (!project) throw new Error('Project not found');
    getProjectStage(project, stageId);
    return dbCol.commits.findByProjectStage(projectId, stageId, { sort: { createdAt: -1 } });
}

/**
 * Copy a slide's layers within a commit, assigning fresh numericIds to all copied layers.
 * Returns the new slide's id.
 */
export async function copySlideInCommit(
    commitId: string,
    sourceSlideId: string,
    newSlideId: string,
    newSlideName: string,
    actorEmail: string,
    auditContext?: ProjectAuditContext
): Promise<void> {
    // Read-modify-write of the whole slides array, so it must serialize against
    // scope saves and other slide mutations on the same commit.
    return runCommitPersistenceTask(commitId, async () => {
        const commit = await dbCol.commits.findById(commitId);
        if (!commit?.content?.slides) throw new Error('Commit not found');

        const slides = commit.content.slides as Array<{
            id: string;
            order: number;
            name?: string;
            layers: Array<Record<string, unknown>>;
        }>;
        const source = slides.find((s) => s.id === sourceSlideId);
        if (!source) throw new Error('Source slide not found');

        // Prefer live bus scope layers (may have unsaved changes) over commit data
        let sourceLayers: Array<Record<string, unknown>> = source.layers ?? [];
        for (const scope of scopedState.values()) {
            if (
                scope.commitId === commitId &&
                scope.slideId === sourceSlideId &&
                scope.layers.size > 0
            ) {
                sourceLayers = Array.from(scope.layers.values()) as Array<Record<string, unknown>>;
                break;
            }
        }

        // Find the highest numericId across ALL slides + live scopes to avoid conflicts
        let maxId = 0;
        for (const slide of slides) {
            for (const layer of slide.layers ?? []) {
                if (typeof layer.numericId === 'number' && layer.numericId > maxId) {
                    maxId = layer.numericId;
                }
            }
        }
        // Also check all live scopes for the same commit (other slides may have unsaved layers)
        for (const scope of scopedState.values()) {
            if (scope.commitId === commitId) {
                for (const [numericId] of scope.layers) {
                    if (numericId > maxId) maxId = numericId;
                }
            }
        }

        // Deep-copy layers with new numericIds
        const copiedLayers = sourceLayers.map((layer, i) => ({
            ...JSON.parse(JSON.stringify(layer)),
            numericId: maxId + i + 1
        }));

        const newSlide = {
            id: newSlideId,
            order: source.order + 0.5,
            name: newSlideName,
            layers: copiedLayers
        };

        const updatedSlides = [...slides, newSlide]
            .sort((a, b) => a.order - b.order)
            .map((s, i) => ({ ...s, order: i }));

        await dbCol.commits.updateSlides(
            commitId,
            updatedSlides as CommitDocument['content']['slides']
        );

        await logAuditSuccess({
            action: 'COMMIT_SLIDE_COPIED',
            actorId: actorEmail,
            projectId: commit.projectId,
            resourceType: 'commit',
            resourceId: commitId,
            changes: {
                sourceSlideId,
                newSlideId,
                newSlideName
            },
            ...withProjectAuditContext(auditContext)
        });
    });
}

/**
 * Delete a slide from a commit document.
 * Returns false if it's the last slide (must keep at least one).
 */
export async function deleteSlideFromCommit(
    commitId: string,
    slideId: string,
    actorEmail: string,
    auditContext?: ProjectAuditContext
): Promise<boolean> {
    // Read-modify-write of the whole slides array, so it must serialize against
    // scope saves and other slide mutations on the same commit.
    return runCommitPersistenceTask(commitId, async () => {
        const commit = await dbCol.commits.findById(commitId);
        if (!commit?.content?.slides) throw new Error('Commit not found');

        const slides = commit.content.slides as Array<{
            id: string;
            order: number;
            name?: string;
            layers: unknown[];
        }>;

        if (slides.length <= 1) {
            await logAuditSuccess({
                action: 'COMMIT_SLIDE_DELETE_BLOCKED',
                actorId: actorEmail,
                projectId: commit.projectId,
                resourceType: 'commit',
                resourceId: commitId,
                reasonCode: 'LAST_SLIDE',
                changes: { slideId },
                ...withProjectAuditContext(auditContext)
            });
            return false;
        }

        const updatedSlides = slides
            .filter((s) => s.id !== slideId)
            .sort((a, b) => a.order - b.order)
            .map((s, i) => ({ ...s, order: i }));

        await dbCol.commits.updateSlides(
            commitId,
            updatedSlides as CommitDocument['content']['slides']
        );

        await logAuditSuccess({
            action: 'COMMIT_SLIDE_DELETED',
            actorId: actorEmail,
            projectId: commit.projectId,
            resourceType: 'commit',
            resourceId: commitId,
            changes: { slideId },
            ...withProjectAuditContext(auditContext)
        });

        return true;
    });
}

export async function revokeUploadTokenForActor(
    token: string,
    actorEmail: string,
    auditContext?: ProjectAuditContext
): Promise<void> {
    const tokenData = validateUploadToken(token);
    if (!tokenData) return;

    if (tokenData.userEmail === actorEmail) {
        revokeUploadToken(token);
        await logAuditSuccess({
            action: 'UPLOAD_TOKEN_REVOKED',
            actorId: actorEmail,
            projectId: tokenData.projectId,
            resourceType: 'upload_token',
            resourceId: tokenHint(token),
            changes: { revokedBy: 'token_owner' },
            ...withProjectAuditContext(auditContext)
        });
        return;
    }

    const project = await getProject(tokenData.projectId);
    if (project) {
        const collaborators = Array.isArray(project.collaborators)
            ? (project.collaborators as Array<{ email?: string; role?: string }>)
            : [];
        const isOwner = collaborators.some(
            (collaborator) => collaborator.email === actorEmail && collaborator.role === 'owner'
        );
        if (isOwner) {
            revokeUploadToken(token);
            await logAuditSuccess({
                action: 'UPLOAD_TOKEN_REVOKED',
                actorId: actorEmail,
                projectId: tokenData.projectId,
                resourceType: 'upload_token',
                resourceId: tokenHint(token),
                changes: { revokedBy: 'project_owner' },
                ...withProjectAuditContext(auditContext)
            });
            return;
        }
    }

    const admin = await collections.users.findOne(
        { email: actorEmail, role: 'admin' },
        { projection: { _id: 1 } }
    );
    if (admin) {
        revokeUploadToken(token);
        await logAuditSuccess({
            action: 'UPLOAD_TOKEN_REVOKED',
            actorId: actorEmail,
            projectId: tokenData.projectId,
            resourceType: 'upload_token',
            resourceId: tokenHint(token),
            changes: { revokedBy: 'admin' },
            ...withProjectAuditContext(auditContext)
        });
        return;
    }

    throw new Error('You do not have permission to revoke this upload token');
}
