import { describe, expect, test } from 'bun:test';

import { GSMessageSchema, getLinePaths } from '../../src/lib/types';

const BASE_LINE = {
    numericId: 1,
    type: 'line' as const,
    config: {
        cx: 50,
        cy: 0,
        width: 100,
        height: 1,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        visible: true
    },
    line: [0, 0, 100, 0],
    strokeColor: '#000000',
    strokeDash: [],
    strokeWidth: 10
};

function parseLine(linePaths?: number[][]) {
    const layer = linePaths === undefined ? BASE_LINE : { ...BASE_LINE, linePaths };
    const message = GSMessageSchema.parse({ type: 'hydrate', layers: [layer] });
    if (message.type !== 'hydrate' || message.layers[0]?.type !== 'line') {
        throw new Error('Expected a hydrated line layer');
    }
    return message.layers[0];
}

describe('line paths schema', () => {
    test('reads an existing flat line as one path', () => {
        expect(getLinePaths(parseLine())).toEqual([[0, 0, 100, 0]]);
    });

    test('uses split paths when present', () => {
        const paths = [
            [0, 0, 40, 0],
            [60, 0, 100, 0]
        ];

        expect(getLinePaths(parseLine(paths))).toEqual(paths);
    });
});
