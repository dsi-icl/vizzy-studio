import { describe, expect, test } from 'bun:test';

import {
    applyKeyboardArrowTransform,
    broadcastKeyboardLayerTransform,
    isEditorArrowKey,
    type KeyboardMoveBroadcaster
} from './editorKeyboardMovement';
import type { GSMessage, LayerWithEditorState } from './types';

const layer: LayerWithEditorState = {
    numericId: 42,
    type: 'shape',
    shape: 'rectangle',
    fill: '#fff',
    strokeColor: '#000',
    strokeDash: [],
    strokeWidth: 1,
    config: {
        cx: 100,
        cy: 200,
        width: 300,
        height: 150,
        rotation: 5,
        scaleX: 1.25,
        scaleY: 0.75,
        zIndex: 4,
        visible: true
    }
};

describe('keyboard layer movement', () => {
    test('recognizes only arrow keys', () => {
        expect(isEditorArrowKey('ArrowLeft')).toBe(true);
        expect(isEditorArrowKey('ArrowDown')).toBe(true);
        expect(isEditorArrowKey('Escape')).toBe(false);
    });

    test('moves and rotates without mutating the source layer', () => {
        const moved = applyKeyboardArrowTransform(layer, 'ArrowRight', false, 120);
        const rotated = applyKeyboardArrowTransform(layer, 'ArrowLeft', true, 120);

        expect(moved.config.cx).toBe(220);
        expect(moved.config.cy).toBe(200);
        expect(rotated.config.rotation).toBe(4);
        expect(layer.config.cx).toBe(100);
        expect(layer.config.rotation).toBe(5);
    });

    test('broadcasts the same authoritative transform over binary and JSON', () => {
        const binaryCalls: unknown[][] = [];
        const jsonCalls: GSMessage[] = [];
        const broadcaster: KeyboardMoveBroadcaster = {
            broadcastBinaryMove: (...args) => binaryCalls.push(args),
            sendJSON: (message) => jsonCalls.push(message)
        };
        const moved = applyKeyboardArrowTransform(layer, 'ArrowUp', false, 10);

        broadcastKeyboardLayerTransform(broadcaster, moved);

        expect(binaryCalls).toEqual([[42, 100, 190, 300, 150, 1.25, 0.75, 5]]);
        expect(jsonCalls).toEqual([
            {
                type: 'upsert_layer',
                origin: 'editor:keyboard_arrow',
                layer: moved
            }
        ]);
    });
});
