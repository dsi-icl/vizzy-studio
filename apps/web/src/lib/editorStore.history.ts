import { EditorEngine } from './editorEngine';
import {
    isDeadEntry,
    pushHistoryEntry,
    resolveHistoryEntry,
    type HistoryDirection,
    type HistoryEntry,
    type PatchAction
} from './editorHistory';
import { applyPatches, pruneSelection, type LayerPatch } from './editorLayerChange';
import type { EditorState, RecordedLayerChange, SliceHelpers } from './editorStore.types';

type SliceSet = (
    partial: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)
) => void;
type SliceGet = () => EditorState;

function broadcastAction(action: PatchAction, layerExists: boolean, origin: string) {
    const engine = EditorEngine.getInstance();

    if (action.kind === 'remove') {
        engine.sendJSON({ type: 'delete_layer', numericId: action.numericId });
        return;
    }
    if (action.kind !== 'restore') return;

    if (!layerExists) {
        engine.createLayer('editor:undo_restore', action.layer);
        return;
    }
    engine.sendJSON({ type: 'upsert_layer', origin, layer: action.layer });
}

export function createHistorySlice(set: SliceSet, get: SliceGet, _helpers: SliceHelpers) {
    const currentScopeKey = () => {
        const { projectId, commitId, activeSlideId } = get();
        return `${projectId ?? ''}_${commitId ?? ''}_${activeSlideId ?? ''}`;
    };

    const applyEntry = (entry: HistoryEntry, direction: HistoryDirection): boolean => {
        const state = get();
        const actions = resolveHistoryEntry(entry, direction, state.layers);
        if (isDeadEntry(actions)) return false;

        const nextLayers = new Map(state.layers);
        for (const action of actions) {
            if (action.kind === 'restore') nextLayers.set(action.numericId, action.layer);
            else if (action.kind === 'remove') nextLayers.delete(action.numericId);
        }

        const isUndo = direction === 'undo';
        const selection = isUndo ? entry.selectionBefore : entry.selectionAfter;
        const origin = isUndo ? 'editor:undo' : 'editor:redo';

        set((s) => ({
            layers: nextLayers,
            selectedLayerIds: pruneSelection(selection, nextLayers),
            hoveredLayerId: null,
            editingTextLayerId:
                s.editingTextLayerId !== null && !nextLayers.has(s.editingTextLayerId)
                    ? null
                    : s.editingTextLayerId
        }));

        for (const action of actions) {
            // Read off the pre-change map: a layer that was absent has to be
            // re-created rather than upserted.
            broadcastAction(action, state.layers.has(action.numericId), origin);
        }

        get().markDirty();
        return true;
    };

    const step = (direction: HistoryDirection) => {
        const isUndo = direction === 'undo';

        for (;;) {
            const state = get();
            const from = isUndo ? state.undoStack : state.redoStack;
            const entry = from.at(-1);
            if (!entry) return;

            const popped = from.slice(0, -1);
            const stale = entry.scopeKey !== currentScopeKey();
            const applied = stale ? false : applyEntry(entry, direction);

            set((s) => {
                const onto = applied ? [...(isUndo ? s.redoStack : s.undoStack), entry] : null;
                return isUndo
                    ? { undoStack: popped, ...(onto && { redoStack: onto }) }
                    : { redoStack: popped, ...(onto && { undoStack: onto }) };
            });

            if (applied) return;
        }
    };

    return {
        undoStack: [] as HistoryEntry[],
        redoStack: [] as HistoryEntry[],

        recordLayerChange: (change: RecordedLayerChange) => {
            const patches = change.patches.filter(
                (patch): patch is LayerPatch => patch !== null && patch !== undefined
            );
            if (patches.length === 0) return;

            const state = get();
            const selectionBefore = state.selectedLayerIds;
            const nextLayers = applyPatches(state.layers, patches);

            const entry: HistoryEntry = {
                scopeKey: currentScopeKey(),
                patches,
                selectionBefore,
                selectionAfter: pruneSelection(change.select ?? selectionBefore, nextLayers),
                mergeKey: change.mergeKey ?? null,
                at: Date.now()
            };

            set((s) => ({
                undoStack: pushHistoryEntry(s.undoStack, entry),
                redoStack: []
            }));
        },

        undo: () => step('undo'),
        redo: () => step('redo'),

        clearHistory: () => set({ undoStack: [], redoStack: [] })
    };
}
