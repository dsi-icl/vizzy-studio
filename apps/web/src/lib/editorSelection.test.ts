import { describe, expect, test } from 'bun:test';

import { getCanvasSelectionModifiers, resolveSelectedLayers } from './editorSelection';
import type { LayerWithEditorState } from './types';

const baseConfig = {
    cx: 0,
    cy: 0,
    width: 100,
    height: 100,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    visible: true
};

const makeLayer = (
    numericId: number,
    overrides: Partial<LayerWithEditorState> & { locked?: boolean } = {}
): LayerWithEditorState => {
    const { locked, ...rest } = overrides;
    return {
        numericId,
        type: 'shape',
        shape: 'rectangle',
        fill: '#fff',
        strokeColor: '#000',
        strokeDash: [],
        strokeWidth: 1,
        cornerRadius: 0,
        ...rest,
        config: { ...baseConfig, locked, ...rest.config }
    } as LayerWithEditorState;
};

const makeLayers = (layers: LayerWithEditorState[]) =>
    new Map(layers.map((layer) => [layer.numericId, layer]));

describe('resolveSelectedLayers', () => {
    const layers = makeLayers([
        makeLayer(1),
        makeLayer(2, {
            locked: true,
            type: 'image',
            src: 'a.png'
        } as Partial<LayerWithEditorState>),
        makeLayer(3, { type: 'text', textHtml: '<p>hi</p>' } as Partial<LayerWithEditorState>),
        makeLayer(4, {
            type: 'line',
            line: [0, 0, 10, 10],
            strokeColor: '#000',
            strokeDash: [],
            strokeWidth: 1
        } as Partial<LayerWithEditorState>)
    ]);

    test('resolves ids to layers in selection order, dropping missing ids', () => {
        const result = resolveSelectedLayers(layers, ['3', '999', '1']);
        expect(result.map((l) => l.numericId)).toEqual([3, 1]);
    });

    test('drops locked layers by default', () => {
        const result = resolveSelectedLayers(layers, ['1', '2', '3']);
        expect(result.map((l) => l.numericId)).toEqual([1, 3]);
    });

    test('excludeLocked: false keeps locked layers', () => {
        const result = resolveSelectedLayers(layers, ['1', '2', '3'], { excludeLocked: false });
        expect(result.map((l) => l.numericId)).toEqual([1, 2, 3]);
    });

    test('excludeLines drops line layers', () => {
        const result = resolveSelectedLayers(layers, ['1', '4'], { excludeLines: true });
        expect(result.map((l) => l.numericId)).toEqual([1]);
    });

    test('combines exclusions and preserves the rest of a mixed selection', () => {
        const result = resolveSelectedLayers(layers, ['1', '2', '3', '4', '42'], {
            excludeLines: true
        });
        expect(result.map((l) => l.numericId)).toEqual([1, 3]);
    });

    test('returns an empty array for an empty selection', () => {
        expect(resolveSelectedLayers(layers, [])).toEqual([]);
    });
});

describe('canvas layer selection', () => {
    test('maps Shift to a single-hit additive selection instead of a list range', () => {
        expect(
            getCanvasSelectionModifiers({ shiftKey: true, ctrlKey: false, metaKey: false })
        ).toEqual({ isShiftClick: false, isCtrlClick: true });
    });

    test('preserves plain and Ctrl/Command selection gestures', () => {
        expect(
            getCanvasSelectionModifiers({ shiftKey: false, ctrlKey: false, metaKey: false })
        ).toEqual({ isShiftClick: false, isCtrlClick: false });
        expect(
            getCanvasSelectionModifiers({ shiftKey: false, ctrlKey: true, metaKey: false })
        ).toEqual({ isShiftClick: false, isCtrlClick: true });
        expect(
            getCanvasSelectionModifiers({ shiftKey: false, ctrlKey: false, metaKey: true })
        ).toEqual({ isShiftClick: false, isCtrlClick: true });
    });

    test('only permits a locked layer to be selected without a modifier', () => {
        expect(
            getCanvasSelectionModifiers({ shiftKey: false, ctrlKey: false, metaKey: false }, true)
        ).toEqual({ isShiftClick: false, isCtrlClick: false });
        expect(
            getCanvasSelectionModifiers({ shiftKey: true, ctrlKey: false, metaKey: false }, true)
        ).toBeNull();
        expect(
            getCanvasSelectionModifiers({ shiftKey: false, ctrlKey: true, metaKey: false }, true)
        ).toBeNull();
    });
});
