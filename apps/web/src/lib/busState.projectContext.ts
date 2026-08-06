/**
 * Project-scoped state shared by every editor on a project.
 *
 * Mirrors how scopes work, one level up: held in memory, mutated by any peer,
 * broadcast to the rest, and written back on the autosave tick rather than on
 * each change. Only durable settings live here — anything ephemeral would drag
 * the dirty flag along with it.
 */
import {
    captureScopeRevision,
    KeyedSerialQueue,
    markScopeDirty,
    markScopePersisted
} from '~/lib/scopePersistence';
import { dbCol } from '~/server/collections';

import { allEditors, projectContexts, type ProjectContextState } from './busState.state';
import { sanitiseRecentColours, withRecentColour } from './recentColours';

/** Serialises writes per project so concurrent flushes cannot interleave. */
const projectWriteQueue = new KeyedSerialQueue<string>();

/** In-flight loads, so simultaneous joins do not each hit the database. */
const loading = new Map<string, Promise<ProjectContextState>>();

function emptyContext(projectId: string): ProjectContextState {
    return { projectId, recentColours: [], dirty: false };
}

/**
 * Return the project's context, seeding it from the database on first use.
 * Single-flighted: concurrent joins share one read.
 */
export async function getOrLoadProjectContext(projectId: string): Promise<ProjectContextState> {
    const existing = projectContexts.get(projectId);
    if (existing) return existing;

    const pending = loading.get(projectId);
    if (pending) return pending;

    const load = (async () => {
        const context = emptyContext(projectId);
        try {
            const project = await dbCol.projects.findById(projectId);
            context.recentColours = sanitiseRecentColours(project?.recentColours);
        } catch (err) {
            console.error(`[Bus] Failed to load project context for ${projectId}:`, err);
        }
        // Anything recorded while the read was in flight wins over the snapshot.
        const raced = projectContexts.get(projectId);
        if (raced) return raced;
        projectContexts.set(projectId, context);
        return context;
    })();

    loading.set(projectId, load);
    try {
        return await load;
    } finally {
        loading.delete(projectId);
    }
}

/** Record a colour. Returns the context when it changed, null when it did not. */
export function recordProjectColour(projectId: string, colour: string): ProjectContextState | null {
    const context = projectContexts.get(projectId);
    if (!context) return null;

    const next = withRecentColour(context.recentColours, colour);
    if (next === context.recentColours) return null;

    context.recentColours = next;
    markScopeDirty(context);
    return context;
}

/** Serialise the context for the wire. */
export function projectContextPayload(context: ProjectContextState) {
    return {
        type: 'project_context' as const,
        projectId: context.projectId,
        recentColours: context.recentColours
    };
}

/** Send a project's context to every editor working on it. */
export function broadcastProjectContext(context: ProjectContextState): number {
    const payload = JSON.stringify(projectContextPayload(context));
    let sent = 0;
    for (const entry of allEditors) {
        if (entry.meta.specimen !== 'editor') continue;
        if (entry.meta.scope?.projectId !== context.projectId) continue;
        entry.peer.send(payload);
        sent += 1;
    }
    return sent;
}

/**
 * Write a dirty context back. Uses `updateRaw` so `updatedAt` is untouched:
 * stamping it would reorder the project dashboard, which sorts on it, every
 * time somebody picked a colour.
 */
export async function persistProjectContext(projectId: string): Promise<void> {
    const context = projectContexts.get(projectId);
    if (!context || !context.dirty) return;

    await projectWriteQueue.run(projectId, async () => {
        const current = projectContexts.get(projectId);
        if (!current || !current.dirty) return;

        const revision = captureScopeRevision(current);
        const colours = [...current.recentColours];
        try {
            await dbCol.projects.updateRaw(projectId, { $set: { recentColours: colours } });
            markScopePersisted(current, revision);
        } catch (err) {
            console.error(`[Bus] Failed to persist project context for ${projectId}:`, err);
        }
    });
}

/** Flush every dirty project context. Called from the autosave tick. */
export async function persistDirtyProjectContexts(): Promise<number> {
    const dirty = [...projectContexts.values()].filter((context) => context.dirty);
    await Promise.all(dirty.map((context) => persistProjectContext(context.projectId)));
    return dirty.length;
}

/**
 * Drop a project's context once no editor remains on it, flushing first so a
 * colour picked just before the last peer left is not lost.
 */
export async function releaseProjectContextIfUnused(projectId: string): Promise<void> {
    for (const entry of allEditors) {
        if (entry.meta.specimen === 'editor' && entry.meta.scope?.projectId === projectId) return;
    }
    await persistProjectContext(projectId);
    projectContexts.delete(projectId);
}
