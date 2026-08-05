import { describe, expect, test } from 'bun:test';

import { GSMessageSchema } from '../../src/lib/types';

const textLayer = {
    numericId: 42,
    type: 'text' as const,
    config: {
        cx: 100,
        cy: 100,
        width: 300,
        height: 200,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        visible: true
    },
    textHtml: '<p>New Text</p>'
};

describe('durable layer creation protocol', () => {
    test('correlates a first upsert with its persistence acknowledgement', () => {
        const request = GSMessageSchema.parse({
            type: 'upsert_layer',
            origin: 'editor:add_text_layer',
            layer: textLayer,
            createRequestId: 'layer-request-1'
        });
        const response = GSMessageSchema.parse({
            type: 'layer_create_response',
            numericId: 42,
            createRequestId: 'layer-request-1',
            success: true
        });

        expect(request.type).toBe('upsert_layer');
        expect(request.createRequestId).toBe('layer-request-1');
        expect(response.type).toBe('layer_create_response');
        expect(response.createRequestId).toBe(request.createRequestId);
    });

    test('carries a persistence failure back to the originating editor', () => {
        const response = GSMessageSchema.parse({
            type: 'layer_create_response',
            numericId: 42,
            createRequestId: 'layer-request-2',
            success: false,
            error: 'Layer could not be persisted'
        });

        expect(response).toMatchObject({
            success: false,
            numericId: 42,
            error: 'Layer could not be persisted'
        });
    });
});
