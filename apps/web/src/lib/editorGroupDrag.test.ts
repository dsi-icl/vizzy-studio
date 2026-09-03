import { describe, expect, test } from 'bun:test';

import { computeGroupTranslation, type LayerCenter } from './editorGroupDrag';

const start = new Map<number, LayerCenter>([
    [1, { cx: 100, cy: 100 }],
    [2, { cx: 300, cy: 50 }],
    [3, { cx: 200, cy: 400 }]
]);

describe('computeGroupTranslation', () => {
    test('shifts every layer by the anchor delta and lands the anchor exactly', () => {
        // Anchor 1 started at (100,100) and was dragged to (140,90): delta (+40,-10).
        const result = computeGroupTranslation(start, 1, { x: 140, y: 90 });

        expect(result.get(1)).toEqual({ cx: 140, cy: 90 });
        expect(result.get(2)).toEqual({ cx: 340, cy: 40 });
        expect(result.get(3)).toEqual({ cx: 240, cy: 390 });
    });

    test('works when the anchor is not the first entry', () => {
        // Anchor 3 started at (200,400), dragged to (200,300): delta (0,-100).
        const result = computeGroupTranslation(start, 3, { x: 200, y: 300 });

        expect(result.get(1)).toEqual({ cx: 100, cy: 0 });
        expect(result.get(2)).toEqual({ cx: 300, cy: -50 });
        expect(result.get(3)).toEqual({ cx: 200, cy: 300 });
    });

    test('a zero-distance drag leaves every layer where it started', () => {
        const result = computeGroupTranslation(start, 2, { x: 300, y: 50 });

        expect(result.get(1)).toEqual({ cx: 100, cy: 100 });
        expect(result.get(2)).toEqual({ cx: 300, cy: 50 });
        expect(result.get(3)).toEqual({ cx: 200, cy: 400 });
    });

    test('returns an empty map when the anchor has no captured start', () => {
        const result = computeGroupTranslation(start, 999, { x: 10, y: 10 });
        expect(result.size).toBe(0);
    });

    test('preserves relative spacing between layers (group keeps its shape)', () => {
        const result = computeGroupTranslation(start, 1, { x: 1100, y: 1100 });
        const a = result.get(1)!;
        const b = result.get(2)!;
        // Original gap between 1 and 2 was (200,-50); it must be unchanged.
        expect({ dx: b.cx - a.cx, dy: b.cy - a.cy }).toEqual({ dx: 200, dy: -50 });
    });
});
