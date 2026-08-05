import type { CommitDocument } from '@repo/db/documents';

import { captureScopeRevision, KeyedSerialQueue, markScopePersisted } from '~/lib/scopePersistence';
import type { Layer, ScopeState } from '~/lib/types';
import { dbCol } from '~/server/collections';

import {
    clearActiveVideosForScope,
    clearControllerTransientForScope,
    commitToScopeIds,
    editorsByScope,
    invalidateHydrateCache,
    lastPingSeen,
    peerCounts,
    peers,
    purgeScopeInterning,
    scopeCleanupTimers,
    scopedState,
    scopeLabel,
    scopeWatchers,
    wallPeersByScope,
    type ScopeId
} from './busState.state';
import { revokePortalTokensForScope } from './portalTokens';

const SCOPE_CLEANUP_GRACE_MS = 5 * 60 * 1000; // 5 minutes
const PING_TIMEOUT_MS = 60_000; // Force-close peers with no ping for 60s

// ── Scope GC scheduling ───────────────────────────────────────────────────────

// Garbage collection if no editors or walls are watching a scope
export function scheduleScopeCleanup(scopeId: ScopeId) {
    // Don't schedule if there are still editors or walls in this scope
    const editors = editorsByScope.get(scopeId);
    if (editors && editors.size > 0) return;
    const watchers = scopeWatchers.get(scopeId);
    if (watchers && watchers.size > 0) return;

    // Transient controller layers should not outlive active viewers.
    // Clear immediately when a scope becomes unobserved, even before full scope GC.
    clearControllerTransientForScope(scopeId);

    // Don't double-schedule
    if (scopeCleanupTimers.has(scopeId)) return;

    console.log(
        `[Bus] Scheduling scope cleanup for ${scopeLabel(scopeId)} in ${SCOPE_CLEANUP_GRACE_MS / 1000}s`
    );
    const timer = setTimeout(() => {
        scopeCleanupTimers.delete(scopeId);
        void executeScopeCleanup(scopeId);
    }, SCOPE_CLEANUP_GRACE_MS);
    scopeCleanupTimers.set(scopeId, timer);
}

/** Cancel a pending scope cleanup (called when an editor joins or a wall binds). */
export function cancelScopeCleanup(scopeId: ScopeId) {
    const timer = scopeCleanupTimers.get(scopeId);
    if (timer) {
        clearTimeout(timer);
        scopeCleanupTimers.delete(scopeId);
        console.log(`[Bus] Cancelled scope cleanup for ${scopeLabel(scopeId)}`);
    }
}

/** Execute scope garbage collection: auto-save if dirty, then purge all state. */
async function executeScopeCleanup(scopeId: ScopeId) {
    // Re-check: someone may have reconnected during the grace period
    const editors = editorsByScope.get(scopeId);
    if (editors && editors.size > 0) return;
    const watchers = scopeWatchers.get(scopeId);
    if (watchers && watchers.size > 0) return;

    const scope = scopedState.get(scopeId);
    if (!scope) {
        // Defensive cleanup for orphaned scope IDs (e.g. partial state after HMR).
        clearActiveVideosForScope(scopeId);
        clearControllerTransientForScope(scopeId);
        revokePortalTokensForScope(scopeId);

        editorsByScope.delete(scopeId);
        wallPeersByScope.delete(scopeId);
        scopeWatchers.delete(scopeId);

        purgeScopeInterning(scopeId);
        return;
    }

    console.log(`[Bus] Cleaning up scope ${scopeLabel(scopeId)}`);

    // Auto-save if dirty
    if (scope.dirty) {
        await saveScope(scopeId, 'Auto-save before scope cleanup', true);
    }

    // Purge active videos
    clearActiveVideosForScope(scopeId);
    clearControllerTransientForScope(scopeId);
    revokePortalTokensForScope(scopeId);

    // Purge scope state
    scopedState.delete(scopeId);

    const scopeIds = commitToScopeIds.get(scope.commitId);
    if (scopeIds) {
        scopeIds.delete(scopeId);
        if (scopeIds.size === 0) commitToScopeIds.delete(scope.commitId);
    }

    purgeScopeInterning(scopeId);

    // Purge broadcast indexes (should already be empty, but ensure)
    editorsByScope.delete(scopeId);
    wallPeersByScope.delete(scopeId);
    scopeWatchers.delete(scopeId);
}

// ── Ping tracking & peer reaping ─────────────────────────────────────────────

// Mark a peer as having pinged
export function touchPing(peerId: string) {
    lastPingSeen.set(peerId, Date.now());
}

// Reap zombie peers: force-close any peer that hasn't pinged in PING_TIMEOUT_MS.
// Controllers are exempt (they don't run clock sync)
export function reapStalePeers(): number {
    const now = Date.now();
    let reaped = 0;
    for (const [peerId, lastSeen] of lastPingSeen) {
        if (now - lastSeen > PING_TIMEOUT_MS) {
            const entry = peers.get(peerId);
            if (entry) {
                console.log(
                    `[Bus] Reaping stale peer ${peerId} (${entry.meta.specimen}, last ping ${Math.round((now - lastSeen) / 1000)}s ago)`
                );
                try {
                    entry.peer.close();
                } catch {
                    // Already closed
                }
                // unregisterPeer will be called by the close handler
            }
            lastPingSeen.delete(peerId);
            reaped++;
        }
    }
    return reaped;
}

export function logPeerCounts() {
    console.log(
        `[WS] Peers: ${peerCounts.editor} editors, ${peerCounts.wall} walls, ${peerCounts.controller} controllers, ${peerCounts.gallery} galleries`
    );
}

// ── DB seeding & persistence ──────────────────────────────────────────────────

/**
 * Auto-seed a scope from the DB commit when the scope is freshly created (empty).
 * Fetches the commit, finds the matching slide, and populates scope.layers.
 */
export async function seedScopeFromDb(scopeId: ScopeId): Promise<boolean> {
    const scope = scopedState.get(scopeId);
    if (!scope || scope.layers.size > 0) return false;

    try {
        const commit = await dbCol.commits.findById(scope.commitId);
        if (!commit?.content?.slides) return false;

        const slide = (commit.content.slides as Array<{ id: string; layers: any[] }>).find(
            (s) => s.id === scope.slideId
        );
        if (!slide?.layers?.length) return false;

        for (const layer of slide.layers) {
            if (typeof layer?.numericId === 'number') {
                scope.layers.set(layer.numericId, layer);
            }
        }
        scope.dirty = false;
        invalidateHydrateCache(scopeId);
        return true;
    } catch (err) {
        console.error(`[Bus] seedScopeFromDb failed for ${scopeLabel(scopeId)}:`, err);
        return false;
    }
}

// DB snapshotting
export async function buildSlidesSnapshot(
    scope: ScopeState,
    headCommitId: string | null
): Promise<Array<{ id: string; order: number; name: string; layers: Layer[] }>> {
    let existingSlides: Array<{ id: string; order: number; name: string; layers: Layer[] }> = [];

    if (headCommitId) {
        const headCommit = await dbCol.commits.findById(headCommitId);
        if (headCommit?.content?.slides) {
            existingSlides = headCommit.content.slides.map((s, i) => ({
                ...s,
                name: s.name ?? `Slide ${i + 1}`,
                layers: s.layers as Layer[]
            }));
        }
    }

    const currentLayers = Array.from(scope.layers.values());
    let slideFound = false;
    const updatedSlides = existingSlides.map((slide) => {
        if (slide.id === scope.slideId) {
            slideFound = true;
            return { ...slide, layers: currentLayers };
        }
        return slide;
    });

    if (!slideFound) {
        updatedSlides.push({
            id: scope.slideId,
            order: updatedSlides.length,
            name: `Slide ${updatedSlides.length + 1}`,
            layers: currentLayers
        });
    }

    return updatedSlides;
}

/** Serializes saves per scope so concurrent writes cannot interleave. */
const scopeSaveQueue = new KeyedSerialQueue<ScopeId>();

export async function saveScope(
    scopeId: ScopeId,
    message: string,
    isAutoSave: boolean,
    authorEmail?: string | null
): Promise<{ success: boolean; commitId?: string; error?: string }> {
    const scope = scopedState.get(scopeId);
    if (!scope) return { success: false, error: 'Scope not found' };

    return scopeSaveQueue.run(scopeId, () =>
        writeScope(scopeId, scope, message, isAutoSave, authorEmail)
    );
}

async function writeScope(
    scopeId: ScopeId,
    scope: ScopeState,
    message: string,
    isAutoSave: boolean,
    authorEmail?: string | null
): Promise<{ success: boolean; commitId?: string; error?: string }> {
    // Captured before the snapshot is read, so a mutation arriving afterwards is
    // never mistaken for one this write included.
    const persistedRevision = captureScopeRevision(scope);

    try {
        // Resolve the mutable HEAD commit ID — prefer scope.commitId, fall back to project lookup
        let headId: string;
        if (scope.commitId) {
            headId = scope.commitId;
        } else {
            const project = await dbCol.projects.findById(scope.projectId);
            if (!project?.headCommitId) return { success: false, error: 'No HEAD commit' };
            headId = project.headCommitId;
        }

        const updatedSlides = await buildSlidesSnapshot(scope, headId);

        if (isAutoSave) {
            // Update the mutable HEAD in place
            await dbCol.commits.update(headId, {
                message,
                content: { slides: updatedSlides as CommitDocument['content']['slides'] }
            });

            markScopePersisted(scope, persistedRevision);
            return { success: true };
        }

        // Manual save: create immutable snapshot, then pointer-swap HEAD's parentId
        // Preserve HEAD's current parentId chain on the snapshot
        const currentHead = await dbCol.commits.findById(headId);
        const snapshot = await dbCol.commits.insert({
            projectId: scope.projectId,
            parentId: currentHead?.parentId ?? null,
            authorEmail:
                typeof authorEmail === 'string' && authorEmail.trim().length > 0
                    ? authorEmail.trim()
                    : null,
            message,
            content: { slides: updatedSlides },
            isAutoSave: false,
            isMutableHead: false
        });

        // Pointer swap: HEAD now points at the snapshot
        await dbCol.commits.setParent(headId, snapshot.id);

        markScopePersisted(scope, persistedRevision);
        return { success: true, commitId: snapshot.id };
    } catch (err) {
        console.error(`[Bus] saveScope failed for ${scopeLabel(scopeId)}:`, err);
        return { success: false, error: String(err) };
    }
}

/**
 * Persist a scope right away rather than waiting for the autosave tick.
 *
 * A newly created layer lives only in memory until autosave runs, up to 30s
 * later. Anything that reads the layer straight from the commit — the Yjs text
 * session does — fails for that whole window. Creating a layer therefore has to
 * make it durable immediately.
 *
 * Fire-and-forget: the caller is a message handler and must not block on I/O.
 */
export function persistScopeNow(scopeId: ScopeId, reason: string): void {
    void saveScope(scopeId, reason, true).then((result) => {
        if (!result.success) {
            console.error(
                `[Bus] Immediate persist failed for ${scopeLabel(scopeId)}: ${result.error}`
            );
        }
    });
}

/**
 * Persist slide metadata (id, order, name) to the commit document.
 * Only updates metadata fields — never touches layers.
 */
export async function persistSlideMetadata(
    commitId: string,
    slides: Array<{ id: string; order: number; name: string }>
): Promise<boolean> {
    try {
        const commit = await dbCol.commits.findById(commitId);
        if (!commit?.content?.slides) return false;

        const existingSlides: Array<{
            id: string;
            order: number;
            name?: string;
            layers: unknown[];
        }> = commit.content.slides;

        // Build a lookup of new metadata by slide id
        const metaById = new Map(slides.map((s) => [s.id, s]));

        // Update existing slides' metadata, preserve layers
        const updatedSlides = existingSlides.map((s) => {
            const meta = metaById.get(s.id);
            if (meta) {
                return { ...s, order: meta.order, name: meta.name };
            }
            return s;
        });

        // Add any new slides that don't exist yet (empty layers)
        const existingSlideIds = new Set(existingSlides.map((s) => s.id));
        for (const meta of slides) {
            if (!existingSlideIds.has(meta.id)) {
                updatedSlides.push({ id: meta.id, order: meta.order, name: meta.name, layers: [] });
            }
        }

        // Sort by order
        updatedSlides.sort((a, b) => a.order - b.order);

        await dbCol.commits.updateSlides(
            commitId,
            updatedSlides as CommitDocument['content']['slides']
        );

        return true;
    } catch (err) {
        console.error(`[Bus] persistSlideMetadata failed for commit ${commitId}:`, err);
        return false;
    }
}
