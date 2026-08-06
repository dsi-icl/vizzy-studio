import { describe, expect, test } from 'bun:test';

import { resizeHeightFromTopEdge } from './textLayerGeometry';
import type { LayerPositionState } from './types';

const base: LayerPositionState = {
    cx: 500,
    cy: 400,
    width: 640,
    height: 200,
    rotation: 0,
    scaleX: 1,
    scaleY: 1
};

/** Where the box's top-left corner lands once the centre offset and rotation apply. */
function topLeftOf(config: LayerPositionState) {
    const radians = (config.rotation * Math.PI) / 180;
    const localX = (-config.width * config.scaleX) / 2;
    const localY = (-config.height * config.scaleY) / 2;
    return {
        x: config.cx + localX * Math.cos(radians) - localY * Math.sin(radians),
        y: config.cy + localX * Math.sin(radians) + localY * Math.cos(radians)
    };
}

describe('text layer height re-anchoring', () => {
    test('grows downwards instead of around the centre', () => {
        const resized = resizeHeightFromTopEdge(base, 300);

        expect(resized.height).toBe(300);
        // Half of the 100px growth, so the top edge does not climb.
        expect(resized.cy).toBe(450);
        expect(resized.cx).toBe(500);
    });

    test('shrinks upwards by the same rule', () => {
        const resized = resizeHeightFromTopEdge(base, 120);

        expect(resized.height).toBe(120);
        expect(resized.cy).toBe(360);
    });

    test('keeps the top edge fixed under scale', () => {
        const scaled = { ...base, scaleY: 2 };
        const resized = resizeHeightFromTopEdge(scaled, 300);

        expect(topLeftOf(resized).y).toBeCloseTo(topLeftOf(scaled).y, 6);
    });

    test('keeps the top edge fixed under rotation', () => {
        const rotated = { ...base, rotation: 30, scaleY: 1.5 };
        const resized = resizeHeightFromTopEdge(rotated, 355);
        const before = topLeftOf(rotated);
        const after = topLeftOf(resized);

        // Rounded to whole pixels on the way out, so allow half a pixel each way.
        expect(after.x).toBeCloseTo(before.x, 0);
        expect(after.y).toBeCloseTo(before.y, 0);
    });

    test('returns the config untouched when the height is unchanged', () => {
        expect(resizeHeightFromTopEdge(base, 200)).toBe(base);
        expect(resizeHeightFromTopEdge(base, 200.4)).toBe(base);
    });

    test('clamps to the minimum layer dimension', () => {
        expect(resizeHeightFromTopEdge(base, 2).height).toBe(20);
    });

    test('carries unrelated config fields through', () => {
        const withExtras = { ...base, zIndex: 7, visible: true };
        const resized = resizeHeightFromTopEdge(withExtras, 300);

        expect(resized.zIndex).toBe(7);
        expect(resized.visible).toBe(true);
        expect(resized.width).toBe(640);
    });
});
