import { describe, expect, test } from 'bun:test';

import { GSMessageSchema, migrateLegacyLayer } from './types';

const config = {
    cx: 500,
    cy: 300,
    width: 200,
    height: 100,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    visible: true
};

const shapeLayer = (layer: Record<string, unknown>) => ({
    numericId: 1,
    type: 'shape',
    fill: 'transparent',
    strokeColor: '#fff',
    strokeDash: [],
    strokeWidth: 2,
    config,
    ...layer
});

function upsert(layer: Record<string, unknown>) {
    return GSMessageSchema.safeParse({
        type: 'upsert_layer',
        origin: 'yjs:sync',
        layer: shapeLayer(layer)
    });
}

describe('oval layer wire schema', () => {
    test('accepts an oval', () => {
        expect(upsert({ shape: 'oval' }).success).toBe(true);
    });

    test('rewrites a legacy circle into an oval', () => {
        const parsed = upsert({ shape: 'circle' });
        if (!parsed.success) throw new Error('expected parse to succeed');
        const layer = (parsed.data as { layer: Record<string, unknown> }).layer;
        expect(layer.shape).toBe('oval');
    });

    test('a migrated circle keeps the position it was drawn at', () => {
        // Legacy circles drew their centre on the top-left corner of the box.
        const parsed = upsert({ shape: 'circle' });
        if (!parsed.success) throw new Error('expected parse to succeed');
        const layer = (parsed.data as { layer: { config: { cx: number; cy: number } } }).layer;
        expect(layer.config.cx).toBe(config.cx - config.width / 2);
        expect(layer.config.cy).toBe(config.cy - config.height / 2);
    });

    test('carries every styling field across the rename', () => {
        const parsed = upsert({
            shape: 'circle',
            fill: '#ff0000',
            strokeColor: '#00ff00',
            strokeDash: [4, 4],
            strokeWidth: 3
        });
        if (!parsed.success) throw new Error('expected parse to succeed');
        const layer = (parsed.data as { layer: Record<string, unknown> }).layer;
        expect(layer.fill).toBe('#ff0000');
        expect(layer.strokeColor).toBe('#00ff00');
        expect(layer.strokeDash).toEqual([4, 4]);
        expect(layer.strokeWidth).toBe(3);
    });

    test('migration is idempotent', () => {
        const once = migrateLegacyLayer(shapeLayer({ shape: 'circle' }));
        expect(migrateLegacyLayer(once)).toEqual(once);
    });

    test('leaves rectangles untouched', () => {
        const rectangle = shapeLayer({ shape: 'rectangle', cornerRadius: 4 });
        expect(migrateLegacyLayer(rectangle)).toEqual(rectangle);
    });

    test('rejects an unknown shape', () => {
        expect(upsert({ shape: 'triangle' }).success).toBe(false);
    });
});
