import { describe, expect, test } from 'bun:test';

import {
    applyPatches,
    layersEqual,
    makeLayerPatch,
    pruneSelection,
    withTextContentOf
} from './editorLayerChange';
import type { LayerWithEditorState } from './types';

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

const layersOf = (...layers: LayerWithEditorState[]) =>
    new Map(layers.map((layer) => [layer.numericId, layer]));

describe('layersEqual', () => {
    test('compares by value, not identity', () => {
        expect(layersEqual(shape(1, 5), shape(1, 5))).toBe(true);
        expect(layersEqual(shape(1, 5), shape(1, 6))).toBe(false);
    });

    test('treats two absent layers as equal and one absent as different', () => {
        expect(layersEqual(null, null)).toBe(true);
        expect(layersEqual(shape(1, 5), null)).toBe(false);
        expect(layersEqual(null, shape(1, 5))).toBe(false);
    });
});

describe('makeLayerPatch', () => {
    test('drops a change that changes nothing, so it never reaches the wire', () => {
        expect(makeLayerPatch(1, shape(1, 5), shape(1, 5))).toBeNull();
    });

    test('records both sides of a real change', () => {
        const patch = makeLayerPatch(1, shape(1, 5), shape(1, 9));
        expect(patch?.before?.config.cx).toBe(5);
        expect(patch?.after?.config.cx).toBe(9);
    });

    test('describes a creation as a null before', () => {
        expect(makeLayerPatch(1, null, shape(1, 5))?.before).toBeNull();
    });

    test('describes a deletion as a null after', () => {
        expect(makeLayerPatch(1, shape(1, 5), null)?.after).toBeNull();
    });
});

describe('applyPatches', () => {
    test('sets, replaces and deletes in one pass without touching the input', () => {
        const layers = layersOf(shape(1, 0), shape(2, 0));
        const next = applyPatches(layers, [
            { numericId: 1, before: shape(1, 0), after: shape(1, 99) },
            { numericId: 2, before: shape(2, 0), after: null },
            { numericId: 3, before: null, after: shape(3, 7) }
        ]);

        expect(next.get(1)?.config.cx).toBe(99);
        expect(next.has(2)).toBe(false);
        expect(next.get(3)?.config.cx).toBe(7);
        // The original map is untouched — zustand needs a fresh reference.
        expect(layers.get(1)?.config.cx).toBe(0);
        expect(layers.has(2)).toBe(true);
    });
});

describe('pruneSelection', () => {
    test('drops ids with no layer behind them', () => {
        expect(pruneSelection(['1', '2'], layersOf(shape(1, 0)))).toEqual(['1']);
    });

    test('leaves a fully valid selection alone', () => {
        expect(pruneSelection(['1', '2'], layersOf(shape(1, 0), shape(2, 0)))).toEqual(['1', '2']);
    });
});

function text(numericId: number, cx: number, html: string): LayerWithEditorState {
    return {
        numericId,
        type: 'text',
        textHtml: html,
        textState: `state:${html}`,
        textFormat: 1,
        config: {
            cx,
            cy: 0,
            width: 200,
            height: 100,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            zIndex: 1,
            visible: true
        }
    };
}

describe('text content is excluded from patches', () => {
    test('a move keeps the geometry change but not the text change', () => {
        const patch = makeLayerPatch(1, text(1, 0, 'New Text'), text(1, 500, 'Hello'));

        expect(patch?.before?.config.cx).toBe(0);
        expect(patch?.after?.config.cx).toBe(500);
        // Both sides carry the newer wording, so undo cannot rewrite content.
        expect(patch?.before?.type === 'text' && patch.before.textHtml).toBe('Hello');
        expect(patch?.before?.type === 'text' && patch.before.textState).toBe('state:Hello');
    });

    test('an edit that only changed text records nothing at all', () => {
        expect(makeLayerPatch(1, text(1, 0, 'New Text'), text(1, 0, 'Hello'))).toBeNull();
    });

    test('a create still carries its text, since the layer must arrive intact', () => {
        const patch = makeLayerPatch(1, null, text(1, 0, 'New Text'));
        expect(patch?.after?.type === 'text' && patch.after.textHtml).toBe('New Text');
    });

    test('a delete still carries its text, so an undo can restore it', () => {
        const patch = makeLayerPatch(1, text(1, 0, 'Hello'), null);
        expect(patch?.before?.type === 'text' && patch.before.textHtml).toBe('Hello');
    });

    test('other layer types are untouched', () => {
        const patch = makeLayerPatch(1, shape(1, 0), shape(1, 500));
        expect(patch?.before?.config.cx).toBe(0);
    });
});

describe('withTextContentOf', () => {
    test('takes content from the source and geometry from the target', () => {
        const merged = withTextContentOf(text(1, 0, 'Old'), text(1, 999, 'New'));
        expect(merged.config.cx).toBe(0);
        expect(merged.type === 'text' && merged.textHtml).toBe('New');
    });

    test('drops fields the source does not have', () => {
        const source = { ...text(1, 0, 'New') } as Record<string, unknown>;
        delete source.textState;
        const merged = withTextContentOf(text(1, 0, 'Old'), source as LayerWithEditorState);
        expect('textState' in merged).toBe(false);
    });

    test('leaves a non-text layer alone', () => {
        expect(withTextContentOf(shape(1, 0), text(1, 0, 'New'))).toEqual(shape(1, 0));
    });
});
