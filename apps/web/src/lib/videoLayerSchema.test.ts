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

describe('legacy video layer wire schema', () => {
    test.each([{ status: 'paused', anchorMediaTime: 0, anchorServerTime: 0 }, {}])(
        'opens a slide saved by the old direct upload path with playback %p',
        (playback) => {
            const oldVideo = {
                numericId: 12,
                type: 'video',
                name: 'old.mp4',
                url: '/api/assets/old.mp4',
                config,
                playback
            };

            const hydrate = GSMessageSchema.parse({ type: 'hydrate', layers: [oldVideo] });
            expect(hydrate.type).toBe('hydrate');
            if (hydrate.type === 'hydrate') {
                expect(hydrate.layers[0]).toMatchObject({
                    type: 'video',
                    duration: 0,
                    loop: true,
                    rvfcActive: false,
                    playback: Object.keys(playback).length
                        ? playback
                        : { status: 'paused', anchorMediaTime: 0, anchorServerTime: 0 }
                });
            }
            const migrated = migrateLegacyLayer(oldVideo);
            expect(migrateLegacyLayer(migrated)).toEqual(migrated);
        }
    );
});
