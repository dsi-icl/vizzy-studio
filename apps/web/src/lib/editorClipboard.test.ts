import { describe, expect, test } from 'bun:test';

import { createPastedLayers, LAYER_PASTE_OFFSET, snapshotCopyableLayers } from './editorClipboard';
import type { LayerWithEditorState } from './types';

function shapeLayer(
    numericId: number,
    cx: number,
    cy: number,
    zIndex: number
): LayerWithEditorState {
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
            cy,
            width: 100,
            height: 50,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            zIndex,
            visible: true
        }
    };
}

describe('editor layer clipboard', () => {
    test('snapshots copyable layers in visual stacking order', () => {
        const lower = shapeLayer(1, 100, 200, 2);
        const upper = shapeLayer(2, 160, 260, 8);
        const uploading = { ...shapeLayer(3, 0, 0, 4), isUploading: true };
        const background: LayerWithEditorState = {
            numericId: 4,
            type: 'background',
            backgroundType: 'solid',
            backgroundColor: '#000',
            atmosphereColor: '#000',
            motifColor1: '#000',
            motifColor2: '#000',
            noiseSeed: 0,
            speedFactor: 1,
            config: { ...shapeLayer(4, 0, 0, 0).config }
        };

        const snapshot = snapshotCopyableLayers([upper, uploading, background, lower]);

        expect(snapshot.map((layer) => layer.numericId)).toEqual([1, 2]);
        snapshot[0]!.config.cx = 999;
        expect(lower.config.cx).toBe(100);
    });

    test('allocates fresh IDs, offsets the group, and selects new stacking positions', () => {
        const source = [shapeLayer(1, 100, 200, 2), shapeLayer(2, 160, 260, 8)];
        let nextId = 50;
        let nextZIndex = 20;

        const pasted = createPastedLayers(
            source,
            1,
            () => nextId++,
            () => nextZIndex++
        );

        expect(pasted.map((layer) => layer.numericId)).toEqual([50, 51]);
        expect(pasted.map((layer) => layer.config.zIndex)).toEqual([20, 21]);
        expect(pasted.map((layer) => [layer.config.cx, layer.config.cy])).toEqual([
            [100 + LAYER_PASTE_OFFSET, 200 + LAYER_PASTE_OFFSET],
            [160 + LAYER_PASTE_OFFSET, 260 + LAYER_PASTE_OFFSET]
        ]);
        expect(source[0]!.config.cx).toBe(100);
    });

    test('increments repeated-paste offsets and resets transient layer state', () => {
        const text: LayerWithEditorState = {
            numericId: 1,
            type: 'text',
            textHtml: '<p>Copy me</p>',
            textRevision: 8,
            textStateHash: 'hash',
            textBindingVersion: 'binding',
            progress: 100,
            config: {
                cx: 10,
                cy: 20,
                width: 100,
                height: 50,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                zIndex: 1,
                visible: true
            }
        };
        const line: LayerWithEditorState = {
            numericId: 2,
            type: 'line',
            line: [0, 0, 10, 10],
            strokeColor: '#fff',
            strokeDash: [],
            strokeWidth: 1,
            config: { ...text.config, cx: 5, cy: 5, zIndex: 2 }
        };

        const pasted = createPastedLayers(
            [text, line],
            2,
            () => 20,
            () => 30
        );
        const pastedText = pasted[0];
        const pastedLine = pasted[1];

        expect(pastedText?.config.cx).toBe(10 + LAYER_PASTE_OFFSET * 2);
        expect(pastedText?.progress).toBeUndefined();
        expect(pastedText?.type === 'text' && pastedText.textRevision).toBeUndefined();
        expect(pastedText?.type === 'text' && pastedText.textStateHash).toBeUndefined();
        expect(pastedLine?.type === 'line' && pastedLine.line).toEqual([40, 40, 50, 50]);
    });
});
