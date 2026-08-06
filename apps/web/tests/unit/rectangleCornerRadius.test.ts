import { describe, expect, test } from 'bun:test';

import { GSMessageSchema } from '../../src/lib/types';

const BASE_RECTANGLE = {
    numericId: 1,
    type: 'shape' as const,
    shape: 'rectangle' as const,
    config: {
        cx: 200,
        cy: 150,
        width: 300,
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
    strokeWidth: 8
};

function parseRectangle(layer: typeof BASE_RECTANGLE & { cornerRadius?: number }) {
    const message = GSMessageSchema.parse({ type: 'hydrate', layers: [layer] });
    if (message.type !== 'hydrate' || message.layers[0]?.type !== 'shape') {
        throw new Error('Expected a hydrated shape layer');
    }
    return message.layers[0];
}

describe('rectangle corner radius schema', () => {
    test('defaults legacy rectangle layers to square corners', () => {
        expect(parseRectangle(BASE_RECTANGLE).cornerRadius).toBe(0);
    });

    test('preserves a configured non-negative corner radius', () => {
        expect(parseRectangle({ ...BASE_RECTANGLE, cornerRadius: 48 }).cornerRadius).toBe(48);
    });

    test('rejects negative corner radii', () => {
        expect(() => parseRectangle({ ...BASE_RECTANGLE, cornerRadius: -1 })).toThrow();
    });
});
