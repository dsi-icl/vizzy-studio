import { describe, expect, test } from 'bun:test';

import { makeLayerPatch } from './editorLayerChange';
import type { EditorState } from './editorStore.types';
import type { LayerWithEditorState } from './types';

const globals = globalThis as Record<string, unknown>;
globals.__APP_COMMIT_SHA__ ??= 'test';
globals.__APP_BUILD_TIMESTAMP__ ??= 0;

const { createHistorySlice } = await import('./editorStore.history');

function shape(numericId: number, cx: number): LayerWithEditorState {
    return {
        numericId,
        type: 'shape',
        shape: 'rectangle',
        fill: '#fff',
        strokeColor: '#000',
        strokeDash: [],
        strokeWidth: 1,
        cornerRadius: 0,
        config: {
            cx,
            cy: 0,
            width: 100,
            height: 100,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            zIndex: 1,
            visible: true
        }
    };
}

/** A slice wired to a mutable plain-object store. */
function harness(overrides: Partial<EditorState> = {}) {
    let state = {
        layers: new Map([[1, shape(1, 0)]]),
        selectedLayerIds: ['1'],
        undoStack: [],
        redoStack: [],
        projectId: 'p',
        commitId: 'c',
        activeSlideId: 's',
        ...overrides
    } as unknown as EditorState;

    const set = (partial: unknown) => {
        const patch = typeof partial === 'function' ? partial(state) : partial;
        state = { ...state, ...(patch as Partial<EditorState>) };
    };
    const slice = createHistorySlice(set, () => state, {} as never);

    return { slice, read: () => state };
}

describe('recordLayerChange', () => {
    test('a new edit clears the redo stack', () => {
        const { slice, read } = harness({
            redoStack: [
                {
                    scopeKey: 'p_c_s',
                    patches: [{ numericId: 9, before: shape(9, 0), after: shape(9, 5) }],
                    selectionBefore: [],
                    selectionAfter: [],
                    mergeKey: null,
                    at: 1
                }
            ]
        });

        slice.recordLayerChange({
            patches: [makeLayerPatch(1, shape(1, 0), shape(1, 50))]
        });

        // Editing after an undo forks the timeline, so the abandoned branch goes.
        expect(read().redoStack).toHaveLength(0);
        expect(read().undoStack).toHaveLength(1);
    });

    test('records nothing when no value actually changed', () => {
        const { slice, read } = harness();

        // makeLayerPatch returns null for identical sides, which is what lets a
        // control fire on every keystroke for free.
        slice.recordLayerChange({ patches: [makeLayerPatch(1, shape(1, 0), shape(1, 0))] });

        expect(read().undoStack).toHaveLength(0);
    });

    test('selectionAfter drops a layer the change deletes', () => {
        const { slice, read } = harness();

        slice.recordLayerChange({ patches: [makeLayerPatch(1, shape(1, 0), null)] });

        // Layer 1 was selected and is now gone, so redo must not try to
        // re-select it.
        expect(read().undoStack[0].selectionBefore).toEqual(['1']);
        expect(read().undoStack[0].selectionAfter).toEqual([]);
    });
});
