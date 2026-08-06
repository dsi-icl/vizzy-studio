import { describe, expect, mock, test } from 'bun:test';

import type { EditorState, SliceHelpers } from '../../src/lib/editorStore.types';
import type { LayerWithEditorState } from '../../src/lib/types';

mock.module('../../src/lib/editorEngine', () => ({
    EditorEngine: {
        getInstance: () => ({
            sendDirty: () => {},
            requestSave: () => {}
        })
    }
}));

const { createUiSlice } = await import('../../src/lib/editorStore.ui');

const SHAPE: LayerWithEditorState = {
    numericId: 1,
    type: 'shape',
    shape: 'rectangle',
    config: {
        cx: 100,
        cy: 100,
        width: 200,
        height: 200,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        visible: true
    },
    fill: '#2563eb',
    strokeColor: '#bfdbfe',
    strokeDash: [],
    strokeWidth: 8,
    cornerRadius: 0
};

describe('stroke colour updates', () => {
    test('broadcasts the updated layer to the memory bus', () => {
        const sentLayers: LayerWithEditorState[] = [];
        let state = {
            layers: new Map([[SHAPE.numericId, SHAPE]]),
            selectedLayerIds: [SHAPE.numericId.toString()],
            saveStatus: 'saving'
        } as unknown as EditorState;

        const helpers = {
            sendLayerUpdate: (layer: LayerWithEditorState) => {
                sentLayers.push(layer);
            },
            broadcastSlides: () => {},
            allocateId: () => 2,
            allocateZIndex: () => 2,
            setNextId: () => {},
            setNextZIndex: () => {},
            peekNextId: () => 2,
            peekNextZIndex: () => 2
        } satisfies SliceHelpers;
        const set = (
            partial: Partial<EditorState> | ((current: EditorState) => Partial<EditorState>)
        ) => {
            const update = typeof partial === 'function' ? partial(state) : partial;
            state = { ...state, ...update };
        };
        const actions = createUiSlice(set, () => state, helpers);
        state = { ...state, ...actions };

        state.setStrokeColor('#ff0000');

        expect(state.layers.get(SHAPE.numericId)?.strokeColor).toBe('#ff0000');
        expect(sentLayers).toHaveLength(1);
        expect(sentLayers[0]?.strokeColor).toBe('#ff0000');
    });
});
