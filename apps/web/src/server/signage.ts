import '@tanstack/react-start/server-only';
import type { PublicDoc } from '@repo/db/collections';
import type { AuthContext, SignageSlideEntry, SignageSlideshowDocument } from '@repo/db/documents';
import { stageLayoutsEqual, type StageLayout } from '@repo/db/schema';

import { canEditSlideshow, isGlobalManager } from '~/lib/signageAccess';
import { logAuditSuccess } from '~/server/audit';
import { dbCol } from '~/server/collections';
import { getStageLayoutLimits } from '~/server/projects';

type Slideshow = PublicDoc<SignageSlideshowDocument>;
type SignageActor = NonNullable<AuthContext['user']>;

export interface ResolvedSignageEntry {
    entry: SignageSlideEntry;
    valid: boolean;
    reason?: string;
    projectName?: string;
    stageName?: string;
    slideName?: string;
    commitId?: string;
}

function canViewSlideshow(actor: SignageActor, slideshow: Slideshow): boolean {
    if (isGlobalManager(actor)) return true;
    if (slideshow.createdBy === actor.email) return true;
    return slideshow.collaborators.some(({ email }) => email === actor.email);
}

function sanitizeCollaborators(
    collaborators: Slideshow['collaborators'],
    actorEmail: string
): Slideshow['collaborators'] {
    const byEmail = new Map<string, 'viewer' | 'editor'>();
    for (const collaborator of collaborators) {
        const email = collaborator.email.trim().toLowerCase();
        if (!email || email === actorEmail) continue;
        byEmail.set(email, collaborator.role);
    }
    return Array.from(byEmail, ([email, role]) => ({ email, role }));
}

function slideReference({ projectId, slideId }: SignageSlideEntry): string {
    return `${projectId}\0${slideId}`;
}

async function assertAddedEntryProjectsPermitted(
    actor: SignageActor,
    currentEntries: SignageSlideEntry[],
    nextEntries: SignageSlideEntry[]
) {
    if (isGlobalManager(actor)) return;
    const alreadyReferenced = new Set(currentEntries.map(slideReference));
    const addedProjectIds = new Set(
        nextEntries
            .filter((entry) => !alreadyReferenced.has(slideReference(entry)))
            .map(({ projectId }) => projectId)
    );
    if (addedProjectIds.size === 0) return;
    const permitted = new Set(
        (await dbCol.projects.findManageableByUser(actor.email)).map(({ id }) => id)
    );
    const denied = Array.from(addedProjectIds).filter((projectId) => !permitted.has(projectId));
    if (denied.length > 0) {
        throw new Error(
            `Cannot add slides from project(s) you cannot manage: ${denied.join(', ')}`
        );
    }
}

async function assertLayoutWithinConfiguredGrid(layout: StageLayout) {
    const limits = await getStageLayoutLimits();
    if (layout.columns > limits.maxColumns || layout.rows > limits.maxRows) {
        throw new Error(`Slideshow grid cannot exceed ${limits.maxColumns}×${limits.maxRows}`);
    }
}

async function assertTargetsAvailable(slideshowId: string | null, wallIds: string[]) {
    await dbCol.signageSlideshows.ensureIndexes();
    const uniqueWallIds = Array.from(new Set(wallIds.map((id) => id.trim()).filter(Boolean)));
    if (uniqueWallIds.length !== wallIds.length) {
        throw new Error('Target walls must be unique and non-empty');
    }
    const walls = await Promise.all(
        uniqueWallIds.map((wallId) => dbCol.walls.findByWallId(wallId))
    );
    const missingIndex = walls.findIndex((wall) => !wall);
    if (missingIndex >= 0) throw new Error(`Wall ${uniqueWallIds[missingIndex]} was not found`);

    const active = await dbCol.signageSlideshows.findActive();
    const conflicting = active.find(
        (candidate) =>
            candidate.id !== slideshowId &&
            candidate.targetWallIds.some((wallId) => uniqueWallIds.includes(wallId))
    );
    if (conflicting) {
        const wallId = conflicting.targetWallIds.find((id) => uniqueWallIds.includes(id));
        throw new Error(`Wall ${wallId} is already targeted by ${conflicting.name}`);
    }
    return uniqueWallIds;
}

export async function listSignageSlideshows(actor: SignageActor): Promise<Slideshow[]> {
    return dbCol.signageSlideshows.findAccessible(actor.email, isGlobalManager(actor));
}

export async function getSignageSlideshow(actor: SignageActor, id: string): Promise<Slideshow> {
    const slideshow = await dbCol.signageSlideshows.findById(id);
    if (!slideshow || slideshow.deletedAt) throw new Error('Slideshow not found');
    if (!canViewSlideshow(actor, slideshow)) throw new Error('Forbidden');
    return slideshow;
}

export async function createSignageSlideshow(
    actor: SignageActor,
    input: {
        name: string;
        layout: StageLayout;
        defaultDisplayDurationMs: number;
        defaultGapDurationMs: number;
        gapMode: 'hold' | 'blank';
    }
): Promise<Slideshow> {
    await assertLayoutWithinConfiguredGrid(input.layout);
    const slideshow = await dbCol.signageSlideshows.insert({
        name: input.name.trim(),
        layout: input.layout,
        defaultDisplayDurationMs: input.defaultDisplayDurationMs,
        defaultGapDurationMs: input.defaultGapDurationMs,
        gapMode: input.gapMode,
        entries: [],
        targetWallIds: [],
        enabled: false,
        createdBy: actor.email,
        collaborators: []
    });
    await logAuditSuccess({
        action: 'SIGNAGE_SLIDESHOW_CREATED',
        actorId: actor.email,
        resourceType: 'signage_slideshow',
        resourceId: slideshow.id,
        changes: { name: slideshow.name, layout: slideshow.layout }
    });
    return slideshow;
}

export async function updateSignageSlideshow(
    actor: SignageActor,
    id: string,
    input: {
        name: string;
        layout: StageLayout;
        defaultDisplayDurationMs: number;
        defaultGapDurationMs: number;
        gapMode: 'hold' | 'blank';
        entries: SignageSlideEntry[];
        targetWallIds: string[];
        enabled: boolean;
        collaborators: Slideshow['collaborators'];
    }
): Promise<Slideshow> {
    const current = await getSignageSlideshow(actor, id);
    if (!canEditSlideshow(actor, current)) throw new Error('Forbidden');
    const changesTargets =
        current.enabled !== input.enabled ||
        current.targetWallIds.join('\0') !== input.targetWallIds.join('\0');
    if (changesTargets && !isGlobalManager(actor)) {
        throw new Error('Only admins and operators can change targets or activation');
    }
    await assertLayoutWithinConfiguredGrid(input.layout);
    if (new Set(input.entries.map(({ id: entryId }) => entryId)).size !== input.entries.length) {
        throw new Error('Slideshow entry IDs must be unique');
    }
    await assertAddedEntryProjectsPermitted(actor, current.entries, input.entries);

    const targetWallIds = input.enabled
        ? await assertTargetsAvailable(id, input.targetWallIds)
        : Array.from(new Set(input.targetWallIds.map((wallId) => wallId.trim()).filter(Boolean)));
    let updated;
    try {
        updated = await dbCol.signageSlideshows.update(id, {
            name: input.name.trim(),
            layout: input.layout,
            defaultDisplayDurationMs: input.defaultDisplayDurationMs,
            defaultGapDurationMs: input.defaultGapDurationMs,
            gapMode: input.gapMode,
            entries: input.entries,
            targetWallIds,
            enabled: input.enabled,
            collaborators: sanitizeCollaborators(input.collaborators, actor.email)
        });
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 11_000) {
            throw new Error('A target wall is already assigned to another enabled slideshow');
        }
        throw error;
    }
    if (!updated) throw new Error('Slideshow not found');
    process.__SIGNAGE_CONFIG_CHANGED__?.(updated.id);
    await logAuditSuccess({
        action: 'SIGNAGE_SLIDESHOW_UPDATED',
        actorId: actor.email,
        resourceType: 'signage_slideshow',
        resourceId: updated.id,
        changes: {
            enabled: updated.enabled,
            entries: updated.entries.length,
            targetWallIds: updated.targetWallIds
        }
    });
    return updated;
}

export async function deleteSignageSlideshow(actor: SignageActor, id: string): Promise<void> {
    const slideshow = await getSignageSlideshow(actor, id);
    if (!canEditSlideshow(actor, slideshow)) throw new Error('Forbidden');
    if (slideshow.enabled && !isGlobalManager(actor)) {
        throw new Error('Only admins and operators can disable an active slideshow');
    }
    await dbCol.signageSlideshows.update(id, { enabled: false });
    await dbCol.signageSlideshows.softDelete(id, actor.email);
    process.__SIGNAGE_CONFIG_CHANGED__?.(id);
    await logAuditSuccess({
        action: 'SIGNAGE_SLIDESHOW_DELETED',
        actorId: actor.email,
        resourceType: 'signage_slideshow',
        resourceId: id
    });
}

export async function resolveSignageEntries(
    actor: SignageActor,
    slideshowId: string
): Promise<ResolvedSignageEntry[]> {
    const slideshow = await getSignageSlideshow(actor, slideshowId);
    return Promise.all(
        slideshow.entries.map(async (entry): Promise<ResolvedSignageEntry> => {
            const project = await dbCol.projects.findById(entry.projectId);
            if (!project || project.deletedAt)
                return { entry, valid: false, reason: 'Project missing' };
            const stages = project.stages.filter(
                (stage) => !stage.archivedAt && stageLayoutsEqual(stage.layout, slideshow.layout)
            );
            if (stages.length !== 1) {
                return {
                    entry,
                    valid: false,
                    projectName: project.name,
                    reason: stages.length === 0 ? 'No matching stage' : 'Layout is ambiguous'
                };
            }
            const stage = stages[0];
            if (!stage.headCommitId) {
                return {
                    entry,
                    valid: false,
                    projectName: project.name,
                    stageName: stage.name,
                    reason: 'Stage has no content'
                };
            }
            const commit = await dbCol.commits.findById(stage.headCommitId);
            const slide = commit?.content.slides.find(({ id }) => id === entry.slideId);
            if (
                !commit ||
                commit.projectId !== project.id ||
                commit.stageId !== stage.id ||
                !slide
            ) {
                return {
                    entry,
                    valid: false,
                    projectName: project.name,
                    stageName: stage.name,
                    reason: 'Slide missing from stage'
                };
            }
            return {
                entry,
                valid: true,
                projectName: project.name,
                stageName: stage.name,
                slideName: slide.name,
                commitId: commit.id
            };
        })
    );
}

export async function listSignageSources(actor: SignageActor, layout: StageLayout) {
    const projects = isGlobalManager(actor)
        ? await dbCol.projects.find({ deletedAt: { $exists: false } }, { sort: { name: 1 } })
        : await dbCol.projects.findManageableByUser(actor.email);
    const sources = [];
    for (const project of projects) {
        const stages = project.stages.filter(
            (stage) => !stage.archivedAt && stageLayoutsEqual(stage.layout, layout)
        );
        if (stages.length !== 1) continue;
        const stage = stages[0];
        const headCommitId = stage.headCommitId;
        if (!headCommitId) continue;
        const commit = await dbCol.commits.findById(headCommitId);
        if (!commit || commit.projectId !== project.id || commit.stageId !== stage.id) continue;
        sources.push({
            projectId: project.id,
            projectName: project.name,
            stageName: stage.name,
            slides: commit.content.slides
                .slice()
                .sort((left, right) => left.order - right.order)
                .map(({ id, name, order }) => ({ id, name, order }))
        });
    }
    return sources;
}
