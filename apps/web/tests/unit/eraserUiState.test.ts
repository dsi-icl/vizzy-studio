import { describe, expect, mock, test } from 'bun:test';

import type { EditorState, SliceHelpers } from '../../src/lib/editorStore.types';
import { ERASER_MAX_WIDTH, ERASER_MIN_WIDTH } from '../../src/lib/eraser';

mock.module('../../src/lib/editorEngine', () => ({
    EditorEngine: { getInstance: () => ({}) }
}));

const { createUiSlice } = await import('../../src/lib/editorStore.ui');

function createTestStore(initial: Partial<EditorState> = {}) {
    let state = {
        isDrawing: false,
        isErasing: false,
        eraserWidth: 70,
        selectedLayerIds: [],
        ...initial
    } as EditorState;
    const set = (
        partial: Partial<EditorState> | ((current: EditorState) => Partial<EditorState>)
    ) => {
        const update = typeof partial === 'function' ? partial(state) : partial;
        state = { ...state, ...update };
    };
    const actions = createUiSlice(set, () => state, {} as SliceHelpers);
    state = { ...state, ...actions };
    return () => state;
}

describe('eraser UI state', () => {
    test('keeps drawing and erasing mutually exclusive', () => {
        const getState = createTestStore({ isDrawing: true });

        getState().setErasing(true);
        expect(getState().isErasing).toBe(true);
        expect(getState().isDrawing).toBe(false);

        getState().toggleDrawing();
        expect(getState().isDrawing).toBe(true);
        expect(getState().isErasing).toBe(false);
    });

    test('keeps the eraser size within the slider range', () => {
        const getState = createTestStore();

        getState().setEraserWidth(ERASER_MAX_WIDTH + 1);
        expect(getState().eraserWidth).toBe(ERASER_MAX_WIDTH);

        getState().setEraserWidth(ERASER_MIN_WIDTH - 1);
        expect(getState().eraserWidth).toBe(ERASER_MIN_WIDTH);
    });
});
