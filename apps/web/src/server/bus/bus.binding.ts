import { stageLayoutsEqual } from '@repo/db/schema';
import type { Peer } from 'crossws';

import {
    allEditors,
    allGalleries,
    bindWall,
    broadcastToControllersByWallRaw,
    cancelWallUnbindGrace,
    galleriesByWallId,
    getOrCreateScope,
    getWallHydratePayload,
    getWallNodeCount,
    hydrateWallNodes,
    internScope,
    notifyControllers,
    peers,
    scopedState,
    seedScopeFromDb,
    sendJSON,
    wallBindings,
    wallBindingSources,
    wallsByWallId
} from '~/lib/busState';
import { makeScopeLabel, type GSMessage } from '~/lib/types';
import { dbCol } from '~/server/collections';

export const BIND_OVERRIDE_TIMEOUT_MS = 20_000;
const wallBindQueues = new Map<string, Promise<unknown>>();

export interface PendingBindOverride {
    requestId: string;
    requesterPeerId: string;
    wallId: string;
    projectId: string;
    commitId: string;
    slideId: string;
    timer: ReturnType<typeof setTimeout>;
}

export const pendingBindOverrides = new Map<string, PendingBindOverride>();
export const pendingBindOverrideByWall = new Map<string, string>();

export function clearPendingBindOverride(requestId: string): PendingBindOverride | null {
    const pending = pendingBindOverrides.get(requestId);
    if (!pending) return null;
    clearTimeout(pending.timer);
    pendingBindOverrides.delete(requestId);
    if (pendingBindOverrideByWall.get(pending.wallId) === requestId) {
        pendingBindOverrideByWall.delete(pending.wallId);
    }
    return pending;
}

export function sendBindOverrideResult(
    requesterPeerId: string,
    payload: Extract<GSMessage, { type: 'bind_override_result' }>
) {
    const requester = peers.get(requesterPeerId);
    if (requester) {
        sendJSON(requester.peer, payload);
    }
    const galleries = galleriesByWallId.get(payload.wallId);
    if (galleries) {
        const raw = JSON.stringify(payload);
        for (const gallery of galleries) {
            gallery.peer.send(raw);
        }
    }
}

export function broadcastWallNodeCountToEditors(wallId: string) {
    const payload = JSON.stringify({
        type: 'wall_node_count',
        wallId,
        connectedNodes: getWallNodeCount(wallId)
    } satisfies GSMessage);
    for (const entry of allEditors) {
        entry.peer.send(payload);
    }
}

export async function resolveBoundSlideId(
    projectId: string,
    commitId: string,
    requestedSlideId: string
): Promise<string | null> {
    let commit: Awaited<ReturnType<typeof dbCol.commits.findById>> = null;
    try {
        commit = await dbCol.commits.findById(commitId);
    } catch {
        return null;
    }
    if (!commit || String(commit.projectId) !== projectId) return null;
    const slides = (commit.content?.slides as Array<{ id?: string }>) ?? [];
    if (slides.some((s) => s.id === requestedSlideId)) return requestedSlideId;
    return slides[0]?.id ?? null;
}

export async function getSlidesMetadata(
    commitId: string
): Promise<Array<{ id: string; order: number; name: string }>> {
    try {
        const commit = await dbCol.commits.findById(commitId);
        const slides =
            (commit?.content?.slides as Array<{
                id?: string;
                order?: number;
                name?: string;
            }>) ?? [];
        return slides
            .filter(
                (slide): slide is { id: string; order?: number; name?: string } =>
                    typeof slide?.id === 'string'
            )
            .map((slide, index) => ({
                id: slide.id,
                order: typeof slide.order === 'number' ? slide.order : index,
                name:
                    typeof slide.name === 'string' && slide.name.length > 0
                        ? slide.name
                        : String(index + 1)
            }));
    } catch (error) {
        console.warn(`[WS] Failed to read slides metadata for commit ${commitId}:`, error);
        return [];
    }
}

export async function sendSlidesSnapshotToControllerPeer(peer: Peer, commitId: string) {
    const slides = await getSlidesMetadata(commitId);
    sendJSON(peer, { type: 'slides_updated', commitId, slides });
}

export async function broadcastSlidesSnapshotToControllersByWall(wallId: string, commitId: string) {
    const slides = await getSlidesMetadata(commitId);
    broadcastToControllersByWallRaw(
        wallId,
        JSON.stringify({ type: 'slides_updated', commitId, slides } satisfies GSMessage)
    );
}

export function broadcastWallBindingToEditors(wallId: string) {
    const boundScope = wallBindings.get(wallId);
    const scope = boundScope !== undefined ? scopedState.get(boundScope) : null;
    const boundSource = wallBindingSources.get(wallId);
    const payload = JSON.stringify({
        type: 'wall_binding_status',
        wallId,
        bound: boundScope !== undefined,
        ...(scope
            ? {
                  projectId: scope.projectId,
                  commitId: scope.commitId,
                  slideId: scope.slideId,
                  customRenderUrl: scope.customRenderUrl,
                  boundSource
              }
            : {})
    } satisfies GSMessage);
    for (const entry of allEditors) {
        entry.peer.send(payload);
    }
}

export function broadcastWallBindingToGalleries(wallId: string) {
    const boundScope = wallBindings.get(wallId);
    const scope = boundScope !== undefined ? scopedState.get(boundScope) : null;
    const payload = JSON.stringify({
        type: 'wall_binding_changed',
        wallId,
        bound: boundScope !== undefined,
        ...(scope
            ? { projectId: scope.projectId, commitId: scope.commitId, slideId: scope.slideId }
            : {}),
        source: wallBindingSources.get(wallId)
    } satisfies GSMessage);
    for (const entry of allGalleries) {
        entry.peer.send(payload);
    }
    if (boundScope === undefined) {
        const unboundPayload = JSON.stringify({ type: 'wall_unbound', wallId } satisfies GSMessage);
        for (const entry of allGalleries) {
            entry.peer.send(unboundPayload);
        }
    }
}

export function broadcastProjectsChanged(projectId?: string) {
    const payload = JSON.stringify({
        type: 'projects_changed',
        ...(projectId ? { projectId } : {})
    } satisfies GSMessage);
    for (const entry of allGalleries) {
        entry.peer.send(payload);
    }
}

export async function sendGalleryStateSnapshot(
    peer: Peer,
    wallId?: string,
    includeWallLayout = false
) {
    const candidateWallIds = new Set<string>();
    if (wallId) {
        candidateWallIds.add(wallId);
    } else {
        for (const known of wallsByWallId.keys()) candidateWallIds.add(known);
        for (const known of wallBindings.keys()) candidateWallIds.add(known);
    }

    const walls = Array.from(candidateWallIds).map((id) => {
        const boundScope = wallBindings.get(id);
        const scope = boundScope !== undefined ? scopedState.get(boundScope) : null;
        return {
            wallId: id,
            connectedNodes: getWallNodeCount(id),
            bound: boundScope !== undefined,
            ...(scope
                ? {
                      projectId: scope.projectId,
                      commitId: scope.commitId,
                      slideId: scope.slideId,
                      source: wallBindingSources.get(id)
                  }
                : {})
        };
    });

    let publishedProjects: Array<{ projectId: string; publishedCommitId: string | null }> = [];
    let layout:
        | { columns: number; rows: number; screenWidth: number; screenHeight: number }
        | undefined;
    try {
        publishedProjects = await dbCol.projects.findPublishedCommitRefs();
        if (wallId && includeWallLayout) {
            const wall = await dbCol.walls.findByWallId(wallId);
            if (wall?.layoutTemplate) {
                layout = {
                    columns: wall.layoutTemplate.columns,
                    rows: wall.layoutTemplate.rows,
                    screenWidth: wall.layoutTemplate.screenWidth,
                    screenHeight: wall.layoutTemplate.screenHeight
                };
            }
        }
    } catch (error) {
        console.warn('[WS] gallery_state: failed to read published projects snapshot', error);
    }

    sendJSON(peer, {
        type: 'gallery_state',
        ...(wallId ? { wallId } : {}),
        ...(layout ? { layout } : {}),
        walls,
        publishedProjects
    });
}

export function broadcastGalleryStateSnapshot(wallId: string) {
    for (const entry of galleriesByWallId.get(wallId) ?? []) {
        const role = entry.meta.authContext?.user?.role;
        const isAssignedGallery =
            entry.meta.authContext?.device?.kind === 'gallery' &&
            entry.meta.authContext.device.wallId === wallId;
        const canReceiveWallLayout = isAssignedGallery || role === 'admin' || role === 'operator';
        void sendGalleryStateSnapshot(entry.peer, wallId, canReceiveWallLayout);
    }
}

export async function isWallTargetedBySignage(wallId: string): Promise<boolean> {
    if (process.__SIGNAGE_IS_TARGET_WALL__?.(wallId)) return true;
    return Boolean(await dbCol.signageSlideshows.findEnabledByTargetWall(wallId));
}

async function performLiveBindNow(
    wallId: string,
    projectId: string,
    commitId: string,
    requestedSlideId: string,
    source: 'live' | 'gallery' | 'signage' = 'live',
    signageLease = false
): Promise<{ ok: boolean; resolvedSlideId?: string; error?: string }> {
    try {
        cancelWallUnbindGrace(wallId);
        if (source !== 'signage' && (await isWallTargetedBySignage(wallId))) {
            const editorLease =
                source === 'live' &&
                signageLease &&
                process.__SIGNAGE_IS_WALL_SUPPRESSED__?.(wallId) === true;
            if (!editorLease) return { ok: false, error: 'signage_owned' };
        }
        const [resolvedSlideId, project, commit, wallExists] = await Promise.all([
            resolveBoundSlideId(projectId, commitId, requestedSlideId),
            dbCol.projects.findById(projectId),
            dbCol.commits.findById(commitId),
            dbCol.walls.findOne({ wallId })
        ]);
        if (!wallExists) {
            return { ok: false, error: 'unknown_wall' };
        }
        if (!resolvedSlideId) {
            return { ok: false, error: 'invalid_slide' };
        }
        if (!project || !commit || commit.projectId !== projectId) {
            return { ok: false, error: 'invalid_commit' };
        }
        const stage = project.stages.find(({ id }) => id === commit.stageId);
        if (!stage) return { ok: false, error: 'invalid_stage' };
        const wallLayout = wallExists.layoutTemplate;
        if (source === 'live' && wallLayout && !stageLayoutsEqual(stage.layout, wallLayout)) {
            return { ok: false, error: 'layout_mismatch' };
        }

        const scopeId = internScope(projectId, commitId, resolvedSlideId);
        const scope = getOrCreateScope(
            scopeId,
            projectId,
            commitId,
            resolvedSlideId,
            project?.customRenderUrl ?? undefined,
            project?.customRenderCompat,
            project?.customRenderProxy,
            stage.layout,
            stage.id
        );

        if (scope.layers.size === 0) {
            await seedScopeFromDb(scopeId);
        }

        // Persist authorization metadata before telling wall clients to request
        // the newly bound project's assets.
        await dbCol.walls.updateByWallId(wallId, {
            boundProjectId: projectId,
            boundCommitId: commitId,
            boundSlideId: resolvedSlideId,
            boundSource: source
        });
        bindWall(wallId, scopeId, source);

        notifyControllers(
            wallId,
            true,
            projectId,
            commitId,
            resolvedSlideId,
            scope.customRenderUrl
        );
        try {
            hydrateWallNodes(wallId);
            broadcastToControllersByWallRaw(wallId, getWallHydratePayload(scopeId, wallId));
            void broadcastSlidesSnapshotToControllersByWall(wallId, commitId);
        } catch (err) {
            console.error(
                `[WS] bind_wall hydrate failed for ${wallId} (${makeScopeLabel(projectId, commitId, resolvedSlideId)}):`,
                err
            );
        }

        broadcastWallBindingToEditors(wallId);
        broadcastWallBindingToGalleries(wallId);
        broadcastWallNodeCountToEditors(wallId);

        console.log(
            `[WS] Wall ${wallId} bound to scope=${makeScopeLabel(projectId, commitId, resolvedSlideId)}`
        );
        return { ok: true, resolvedSlideId };
    } catch (err) {
        console.error(
            `[WS] bind_wall failed for ${wallId} (${makeScopeLabel(projectId, commitId, requestedSlideId)}):`,
            err
        );
        return { ok: false, error: 'bind_failed' };
    }
}

/** Serialize all binds for one wall so an older async bind cannot win a race. */
export async function performLiveBind(
    wallId: string,
    projectId: string,
    commitId: string,
    requestedSlideId: string,
    source: 'live' | 'gallery' | 'signage' = 'live',
    signageLease = false
): Promise<{ ok: boolean; resolvedSlideId?: string; error?: string }> {
    const previous = wallBindQueues.get(wallId) ?? Promise.resolve();
    const next = previous
        .catch(() => undefined)
        .then(() =>
            performLiveBindNow(wallId, projectId, commitId, requestedSlideId, source, signageLease)
        );
    wallBindQueues.set(wallId, next);
    try {
        return await next;
    } finally {
        if (wallBindQueues.get(wallId) === next) wallBindQueues.delete(wallId);
    }
}
