import { describe, expect, test } from 'bun:test';

import { computeSendToBackUpdates } from '../../src/lib/editorLayerOrder';
import type { LayerWithEditorState } from '../../src/lib/types';

function shape(numericId: number, zIndex: number): LayerWithEditorState {
    return {
        numericId,
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
            zIndex,
            visible: true
        },
        fill: 'transparent',
        strokeColor: '#ffffff',
        strokeDash: [],
        strokeWidth: 2,
        cornerRadius: 0
    };
}

function background(numericId: number, zIndex: number): LayerWithEditorState {
    return {
        numericId,
        type: 'background',
        config: {
            cx: 100,
            cy: 100,
            width: 200,
            height: 200,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            zIndex,
            visible: true
        },
        backgroundType: 'i-pattern',
        backgroundColor: '#0a0a14',
        atmosphereColor: '#1a1a3a',
        motifColor1: '#2a1a4a',
        motifColor2: '#0a2a3a',
        noiseSeed: 0,
        speedFactor: 1
    };
}

function zIndexById(updates: LayerWithEditorState[]) {
    return Object.fromEntries(updates.map((l) => [l.numericId, l.config.zIndex]));
}

describe('send to back ordering', () => {
    test('stops just above the background instead of slipping underneath it', () => {
        const updates = computeSendToBackUpdates(
            [background(1, 0), shape(2, 1), shape(3, 2), shape(4, 3)],
            4
        );

        expect(zIndexById(updates)).toEqual({ 4: 1, 2: 2, 3: 3 });
    });

    test('keeps the single-layer update when there is room below the stack', () => {
        const updates = computeSendToBackUpdates(
            [background(1, 0), shape(2, 5), shape(3, 10), shape(4, 15)],
            4
        );

        expect(zIndexById(updates)).toEqual({ 4: 4 });
    });

    test('drops below every other layer when there is no background', () => {
        const updates = computeSendToBackUpdates([shape(2, 1), shape(3, 2), shape(4, 3)], 4);

        expect(zIndexById(updates)).toEqual({ 4: 0 });
    });

    test('does nothing when the layer is already at the back', () => {
        expect(
            computeSendToBackUpdates([background(1, 0), shape(2, 1), shape(3, 2)], 2)
        ).toHaveLength(0);
        expect(computeSendToBackUpdates([shape(2, 1), shape(3, 2)], 2)).toHaveLength(0);
    });

    test('lifts a layer already stranded under the background', () => {
        const updates = computeSendToBackUpdates(
            [background(1, 0), shape(2, -1), shape(3, 1), shape(4, 2)],
            2
        );

        expect(zIndexById(updates)).toEqual({ 2: 1, 3: 2, 4: 3 });
    });

    test('breaks a tie for the lowest z-index', () => {
        const updates = computeSendToBackUpdates(
            [background(1, 0), shape(2, 1), shape(3, 1), shape(4, 2)],
            3
        );

        // Layer 3 already sits on the floor, so only the layers above it move.
        expect(zIndexById(updates)).toEqual({ 2: 2, 4: 3 });
    });

    test('ignores a request to send the background itself to the back', () => {
        expect(computeSendToBackUpdates([background(1, 0), shape(2, 1)], 1)).toHaveLength(0);
    });
});
