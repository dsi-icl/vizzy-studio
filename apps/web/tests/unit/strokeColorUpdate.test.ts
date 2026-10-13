import { describe, expect, mock, test } from 'bun:test';

import type { EditorState, SliceHelpers } from '../../src/lib/editorStore.types';
import type { LayerWithEditorState } from '../../src/lib/types';

mock.module('../../src/lib/editorEngine', () => ({
    EditorEngine: {
        getInstance: () => ({
            sendDirty: () => {},
            requestSave: () => {},
            getServerTime: () => 1000
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
const LINE: LayerWithEditorState = {
    numericId: 2,
    type: 'line',
    config: SHAPE.config,
    line: [0, 0, 100, 100],
    strokeColor: '#bfdbfe',
    strokeDash: [8, 4],
    strokeWidth: 8
};

function createHarness(initialLayer: LayerWithEditorState = SHAPE) {
    const sentLayers: LayerWithEditorState[] = [];
    let state = {
        layers: new Map([[initialLayer.numericId, initialLayer]]),
        selectedLayerIds: [initialLayer.numericId.toString()],
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
    return { getState: () => state, sentLayers };
}

describe('shape appearance updates', () => {
    test('broadcasts a stroke colour update to the memory bus', () => {
        const { getState, sentLayers } = createHarness();
        getState().setStrokeColor('#ff0000');

        expect(getState().layers.get(SHAPE.numericId)?.strokeColor).toBe('#ff0000');
        expect(sentLayers).toHaveLength(1);
        expect(sentLayers[0]?.strokeColor).toBe('#ff0000');
    });

    test('broadcasts the focus choice and can turn it off again', () => {
        const { getState, sentLayers } = createHarness();
        getState().setShapeEffect('focus');
        expect(getState().layers.get(SHAPE.numericId)?.effect).toBe('focus');
        expect(sentLayers[0]?.effect).toBe('focus');
        expect(sentLayers[0]?.effectSettings).toMatchObject({
            speed: 1,
            intensity: 100,
            direction: 'forward',
            playMode: 'loop'
        });

        getState().setShapeEffect('none');
        expect(getState().layers.get(SHAPE.numericId)?.effect).toBe('none');
        expect(sentLayers[1]?.effect).toBe('none');
    });

    test('saves and broadcasts shape effect tuning', () => {
        const { getState, sentLayers } = createHarness();
        getState().setShapeEffect('travel');
        getState().setShapeEffectSettings({ speed: 1.5, intensity: 140 });
        getState().setShapeEffectSettings({ direction: 'reverse' });

        const layer = getState().layers.get(SHAPE.numericId);
        expect(layer?.effect).toBe('travel');
        expect(layer?.effectSettings).toMatchObject({
            speed: 1.5,
            intensity: 140,
            direction: 'reverse'
        });
        expect(sentLayers.at(-1)?.effectSettings).toEqual(layer?.effectSettings);

        getState().setShapeEffectSettings({ direction: 'reverse' });
        expect(sentLayers).toHaveLength(3);
    });

    test('travel works on a line and replay sends its shared start time', () => {
        const { getState, sentLayers } = createHarness(LINE);
        getState().setShapeEffect('travel');
        getState().setShapeEffectSettings({ playMode: 'once', startAtMs: 2000 });
        expect(getState().layers.get(LINE.numericId)?.effect).toBe('travel');
        expect(getState().layers.get(LINE.numericId)?.effectSettings?.startAtMs).toBe(2000);
        expect(sentLayers.at(-1)?.effectSettings?.startAtMs).toBe(2000);

        getState().setShapeEffectSettings({ playMode: 'loop' });
        expect(getState().layers.get(LINE.numericId)?.effectSettings?.startAtMs).toBeUndefined();

        getState().setShapeEffect('ping');
        expect(getState().layers.get(LINE.numericId)?.effect).toBe('travel');
    });
});
