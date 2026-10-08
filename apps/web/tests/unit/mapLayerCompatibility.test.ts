import { describe, expect, test } from 'bun:test';

import { createPastedLayers, snapshotCopyableLayers } from '../../src/lib/editorClipboard';
import { GSMessageSchema } from '../../src/lib/types';

const LEGACY_MAP = {
    numericId: 3,
    type: 'map' as const,
    config: {
        cx: 640,
        cy: 360,
        width: 800,
        height: 450,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 10,
        visible: true,
        locked: true
    },
    view: {
        longitude: -0.017,
        latitude: 51.4904999,
        zoom: 14,
        pitch: 45,
        bearing: 90
    }
};

describe('map layers with current main features', () => {
    test('hydrates existing maps together with stage layout, signage source and layer locks', () => {
        const layout = { columns: 2, rows: 1, screenWidth: 1280, screenHeight: 720 };
        const message = GSMessageSchema.parse({
            type: 'hydrate',
            layers: [LEGACY_MAP],
            layout,
            boundSource: 'signage'
        });
        if (message.type !== 'hydrate') throw new Error('Expected hydrate');

        expect(message.layout).toEqual(layout);
        expect(message.boundSource).toBe('signage');
        expect(message.layers[0]).toEqual({ ...LEGACY_MAP, style: 'protomaps-light' });
    });

    test('copy and paste preserves the map style, camera and lock through a bus round trip', () => {
        const source = structuredClone({ ...LEGACY_MAP, style: 'protomaps-dark' as const });
        const copied = snapshotCopyableLayers([source]);
        source.view.pitch = 0;
        const [pasted] = createPastedLayers(
            copied,
            1,
            () => 4,
            () => 20
        );
        const message = GSMessageSchema.parse({
            type: 'upsert_layer',
            origin: 'editor:paste',
            layer: pasted
        });
        if (message.type !== 'upsert_layer' || message.layer.type !== 'map') {
            throw new Error('Expected a map layer update');
        }

        expect(message.layer.numericId).toBe(4);
        expect(message.layer.style).toBe('protomaps-dark');
        expect(message.layer.view).toEqual(LEGACY_MAP.view);
        expect(message.layer.config).toEqual({
            ...LEGACY_MAP.config,
            cx: 660,
            cy: 380,
            zIndex: 20
        });
    });
});
