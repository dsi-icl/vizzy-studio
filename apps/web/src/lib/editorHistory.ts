import { layersEqual, withTextContentOf, type LayerPatch } from './editorLayerChange';
import type { LayerWithEditorState } from './types';

export const HISTORY_LIMIT = 50;
export const MERGE_WINDOW_MS = 600;

export interface HistoryEntry {
    scopeKey: string;
    patches: LayerPatch[];
    selectionBefore: string[];
    selectionAfter: string[];
    mergeKey: string | null;
    at: number;
}

export type HistoryDirection = 'undo' | 'redo';
export type PatchAction =
    | { kind: 'restore'; numericId: number; layer: LayerWithEditorState }
    | { kind: 'remove'; numericId: number }
    | { kind: 'skip'; numericId: number; reason: 'missing' | 'noop' };

export function resolvePatch(
    patch: LayerPatch,
    direction: HistoryDirection,
    currentLayer: LayerWithEditorState | undefined
): PatchAction {
    const isUndo = direction === 'undo';
    const target = isUndo ? patch.before : patch.after;
    const expected = isUndo ? patch.after : patch.before;

    // Patch is a deletion. If the current layer is already gone, skip it; if not, remove it.
    if (target === null) {
        if (!currentLayer) return { kind: 'skip', numericId: patch.numericId, reason: 'noop' };
        return { kind: 'remove', numericId: patch.numericId };
    }

    // If patch is not a deletion and the current layer is missing, skip it with missing reason.
    if (expected !== null && !currentLayer) {
        return { kind: 'skip', numericId: patch.numericId, reason: 'missing' };
    }

    // Text content belongs to the layer's Yjs document, not to this patch.
    const restored = currentLayer ? withTextContentOf(target, currentLayer) : target;

    // If the current layer is already identical to the target, skip it with noop reason.
    if (currentLayer && layersEqual(currentLayer, restored)) {
        return { kind: 'skip', numericId: patch.numericId, reason: 'noop' };
    }

    return { kind: 'restore', numericId: patch.numericId, layer: restored };
}

export function resolveHistoryEntry(
    entry: HistoryEntry,
    direction: HistoryDirection,
    layers: Map<number, LayerWithEditorState>
): PatchAction[] {
    return entry.patches.map((patch) =>
        resolvePatch(patch, direction, layers.get(patch.numericId))
    );
}

export function isDeadEntry(actions: PatchAction[]): boolean {
    return actions.every((action) => action.kind === 'skip');
}

export function isNoopEntry(entry: HistoryEntry): boolean {
    return entry.patches.every((patch) => layersEqual(patch.before, patch.after));
}

function canMerge(top: HistoryEntry, next: HistoryEntry, mergeWindowMs: number): boolean {
    if (next.mergeKey === null) return false;
    if (top.mergeKey !== next.mergeKey) return false;
    if (top.scopeKey !== next.scopeKey) return false;
    return next.at - top.at <= mergeWindowMs;
}

function mergeEntries(top: HistoryEntry, next: HistoryEntry): HistoryEntry {
    const patches = top.patches.map((patch) => ({ ...patch }));
    for (const incoming of next.patches) {
        const existing = patches.find((patch) => patch.numericId === incoming.numericId);
        if (existing) existing.after = incoming.after;
        else patches.push({ ...incoming });
    }
    return { ...top, patches, selectionAfter: next.selectionAfter, at: next.at };
}

export function pushHistoryEntry(
    stack: HistoryEntry[],
    entry: HistoryEntry,
    limit: number = HISTORY_LIMIT,
    mergeWindowMs: number = MERGE_WINDOW_MS
): HistoryEntry[] {
    if (entry.patches.length === 0) return stack;

    const top = stack.at(-1);
    if (top && canMerge(top, entry, mergeWindowMs)) {
        const merged = mergeEntries(top, entry);
        const head = stack.slice(0, -1);
        return isNoopEntry(merged) ? head : [...head, merged];
    }

    if (isNoopEntry(entry)) return stack;

    const next = [...stack, entry];
    return next.length > limit ? next.slice(next.length - limit) : next;
}
