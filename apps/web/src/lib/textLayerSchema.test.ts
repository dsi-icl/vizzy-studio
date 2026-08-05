import { describe, expect, test } from 'bun:test';

import { GSMessageSchema, TEXT_FORMAT_VERSION } from './types';

const config = {
    cx: 0,
    cy: 0,
    width: 100,
    height: 50,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    visible: true
};

function upsert(layer: Record<string, unknown>) {
    return GSMessageSchema.safeParse({
        type: 'upsert_layer',
        origin: 'yjs:sync',
        layer: { numericId: 1, type: 'text', config, ...layer }
    });
}

describe('text layer wire schema', () => {
    test('accepts a legacy layer with neither textState nor textFormat', () => {
        const parsed = upsert({ textHtml: '<p>Legacy</p>' });
        expect(parsed.success).toBe(true);
    });

    test('accepts a layer carrying structured state', () => {
        const parsed = upsert({
            textHtml: '<p>New</p>',
            textState: '{"root":{}}',
            textFormat: TEXT_FORMAT_VERSION
        });
        expect(parsed.success).toBe(true);
    });

    test('a legacy layer round-trips without gaining the new fields', () => {
        const parsed = upsert({ textHtml: '<p>Legacy</p>' });
        if (!parsed.success) throw new Error('expected parse to succeed');
        const layer = (parsed.data as { layer: Record<string, unknown> }).layer;
        expect(layer.textState).toBeUndefined();
        expect(layer.textFormat).toBeUndefined();
    });

    test('rejects a non-string textState', () => {
        expect(upsert({ textHtml: '<p>x</p>', textState: { root: {} } }).success).toBe(false);
    });

    test('rejects a non-integer or negative textFormat', () => {
        expect(upsert({ textHtml: '<p>x</p>', textFormat: 1.5 }).success).toBe(false);
        expect(upsert({ textHtml: '<p>x</p>', textFormat: -1 }).success).toBe(false);
    });

    test('still requires textHtml, which every renderer depends on', () => {
        expect(upsert({ textState: '{"root":{}}', textFormat: 1 }).success).toBe(false);
    });
});
