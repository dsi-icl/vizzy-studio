import { afterEach, describe, expect, mock, test } from 'bun:test';

import type { EditorState, SliceHelpers } from '../../src/lib/editorStore.types';
import type { LayerWithEditorState } from '../../src/lib/types';

const sendJSON = mock();

mock.module('../../src/lib/editorEngine', () => ({
    EditorEngine: { getInstance: () => ({ sendJSON }) }
}));

const { createLayerSlice } = await import('../../src/lib/editorStore.layers');

const LINE: LayerWithEditorState = {
    numericId: 7,
    type: 'line',
    config: {
        cx: 50,
        cy: 0,
        width: 100,
        height: 20,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        visible: true
    },
    line: [0, 0, 100, 0],
    strokeColor: '#ff0000',
    strokeWidth: 10,
    strokeDash: []
};

function createTestStore(layer: LayerWithEditorState = LINE) {
    const markDirty = mock();
    let state = {
        layers: new Map([[layer.numericId, layer]]),
        selectedLayerIds: [layer.numericId.toString()],
        hoveredLayerId: layer.numericId.toString(),
        markDirty
    } as unknown as EditorState;
    const set = (
        partial: Partial<EditorState> | ((current: EditorState) => Partial<EditorState>)
    ) => {
        const update = typeof partial === 'function' ? partial(state) : partial;
        state = { ...state, ...update };
    };
    const helpers = {
        sendLayerUpdate: () => {},
        broadcastSlides: () => {},
        allocateId: () => 8,
        allocateZIndex: () => 2,
        setNextId: () => {},
        setNextZIndex: () => {},
        peekNextId: () => 8,
        peekNextZIndex: () => 2
    } satisfies SliceHelpers;
    const actions = createLayerSlice(set, () => state, helpers);
    state = { ...state, ...actions };

    return { getState: () => state, markDirty };
}

afterEach(() => sendJSON.mockClear());

describe('line erase store commit', () => {
    test('updates the line through the existing upsert path', () => {
        const paths = [
            [20, 0, 40, 0],
            [60, 0, 80, 0, 100, 0]
        ];
        const { getState, markDirty } = createTestStore();

        getState().commitLineErase(LINE.numericId, paths);

        const updated = getState().layers.get(LINE.numericId);
        expect(updated?.type).toBe('line');
        if (updated?.type !== 'line') throw new Error('Expected a line layer');
        expect(updated.line).toEqual(paths[1]);
        expect(updated.linePaths).toEqual(paths);
        expect(updated.config).toEqual({ ...LINE.config, cx: 60, width: 80 });
        expect(sendJSON).toHaveBeenCalledWith({
            type: 'upsert_layer',
            origin: 'editor:erase_line_layer',
            layer: updated
        });
        expect(markDirty).toHaveBeenCalledTimes(1);
    });

    test('uses the existing removal path when the whole line is erased', () => {
        const { getState, markDirty } = createTestStore();

        getState().commitLineErase(LINE.numericId, []);

        expect(getState().layers.has(LINE.numericId)).toBe(false);
        expect(getState().selectedLayerIds).toEqual([]);
        expect(getState().hoveredLayerId).toBeNull();
        expect(sendJSON).toHaveBeenCalledWith({ type: 'delete_layer', numericId: LINE.numericId });
        expect(markDirty).toHaveBeenCalledTimes(1);
    });

    test('does not edit a locked line', () => {
        const lockedLine = { ...LINE, config: { ...LINE.config, locked: true } };
        const { getState, markDirty } = createTestStore(lockedLine);

        getState().commitLineErase(LINE.numericId, [[0, 0, 40, 0]]);

        expect(getState().layers.get(LINE.numericId)).toBe(lockedLine);
        expect(sendJSON).not.toHaveBeenCalled();
        expect(markDirty).not.toHaveBeenCalled();
    });
});
