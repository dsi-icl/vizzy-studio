import { describe, expect, test } from 'bun:test';

import {
    DEFAULT_SHAPE_EFFECT_SETTINGS,
    getPolylineLength,
    getShapeEffectFrame,
    getShapeEffectMaxScale,
    getShapeOutline,
    partialShapeOutline
} from './shapeEffects';
import { getLayerCullingRadii } from './stageGeometry';
import { GSMessageSchema, migrateLegacyLayers, type LayerWithWallComponentState } from './types';

const BASE_SHAPE: LayerWithWallComponentState = {
    numericId: 7,
    type: 'shape',
    shape: 'oval',
    config: {
        cx: 100,
        cy: 100,
        width: 100,
        height: 100,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        visible: true
    },
    fill: 'transparent',
    strokeColor: '#fff',
    strokeDash: [8, 4],
    strokeWidth: 10,
    cornerRadius: 0
};

describe('layer effects', () => {
    test('pulse breathes without a halo and keeps synchronized timing', () => {
        const settings = { ...DEFAULT_SHAPE_EFFECT_SETTINGS };
        const resting = getShapeEffectFrame('pulse', 0, settings);
        const expanded = getShapeEffectFrame('pulse', 1200, settings);
        expect(resting.scale).toBeCloseTo(1);
        expect(expanded.scale).toBeGreaterThan(1.1);
        expect(expanded.focusOpacity).toBe(0);
        expect(expanded).toEqual(getShapeEffectFrame('pulse', 3600, settings));
        expect(getShapeEffectMaxScale('pulse')).toBeGreaterThan(1.1);
    });

    test('focus has a synchronized phase and reserves its footprint at wall tile edges', () => {
        const settings = { ...DEFAULT_SHAPE_EFFECT_SETTINGS, phaseOffsetMs: 400 };
        const first = getShapeEffectFrame('focus', 1000, settings);
        expect(first).toEqual(getShapeEffectFrame('focus', 3600, settings));
        expect(first.focusOpacity).toBeGreaterThan(0);
        expect(getShapeEffectMaxScale('focus')).toBeGreaterThan(1);
        expect(
            getLayerCullingRadii({ ...BASE_SHAPE, effect: 'focus' }, BASE_SHAPE.config).x
        ).toBeGreaterThan(getLayerCullingRadii(BASE_SHAPE, BASE_SHAPE.config).x);
    });

    test('ping emits the selected number of rings with a fading edge', () => {
        const settings = { ...DEFAULT_SHAPE_EFFECT_SETTINGS, ringCount: 3 };
        const frame = getShapeEffectFrame('ping', 1100, settings);
        expect(frame.rings).toHaveLength(3);
        expect(frame.rings[0].scale).toBeGreaterThan(1);
        expect(frame.rings[0].opacity).toBeLessThan(1);
        expect(
            getLayerCullingRadii({ ...BASE_SHAPE, effect: 'ping' }, BASE_SHAPE.config).x
        ).toBeGreaterThan(getLayerCullingRadii(BASE_SHAPE, BASE_SHAPE.config).x);
    });

    test('travel respects direction, phase offset and one-shot completion', () => {
        const settings = { ...DEFAULT_SHAPE_EFFECT_SETTINGS, direction: 'reverse' as const };
        expect(getShapeEffectFrame('travel', 450, settings).travelProgress).toBeCloseTo(0.75);
        expect(getShapeEffectFrame('travel', 450, settings)).toEqual(
            getShapeEffectFrame('travel', 2250, settings)
        );
        expect(
            getShapeEffectFrame('travel', 2500, {
                ...settings,
                playMode: 'once',
                startAtMs: 0
            }).travelOpacity
        ).toBe(0);
        expect(getPolylineLength([0, 0, 3, 4, 6, 4])).toBe(8);
    });

    test('reveal draws once and then holds the original outline', () => {
        const settings = {
            ...DEFAULT_SHAPE_EFFECT_SETTINGS,
            playMode: 'once' as const,
            startAtMs: 1000
        };
        expect(getShapeEffectFrame('reveal', 1000, settings).revealProgress).toBe(0);
        expect(getShapeEffectFrame('reveal', 1900, settings).revealProgress).toBeGreaterThan(0.8);
        expect(getShapeEffectFrame('reveal', 3000, settings).revealProgress).toBe(1);
    });

    test('outline sampling follows both shape boundaries and supports a partial trace', () => {
        const rectangle = getShapeOutline('rectangle', 100, 60, 12);
        const oval = getShapeOutline('oval', 100, 60);
        expect(rectangle.points[0]).toEqual({ x: 12, y: 0 });
        expect(oval.points[0].y).toBeCloseTo(0);
        const half = partialShapeOutline(rectangle, 0.5);
        const whole = partialShapeOutline(rectangle, 1);
        expect(half.length).toBeGreaterThan(4);
        expect(half.length).toBeLessThan(whole.length);
        expect(whole.at(-2)).toBeCloseTo(whole[0]);
        expect(whole.at(-1)).toBeCloseTo(whole[1]);
        const reverse = partialShapeOutline(rectangle, 0.1, true);
        expect(reverse[0]).toBeCloseTo(whole[whole.length - 2]);
        expect(reverse[1]).toBeCloseTo(whole[whole.length - 1]);
    });

    test('new shape and line effects survive the editor-to-wall message schema', () => {
        for (const effect of ['pulse', 'focus', 'ping', 'travel', 'reveal'] as const) {
            const parsed = GSMessageSchema.parse({
                type: 'upsert_layer',
                origin: 'editor:set_shape_effect',
                layer: { ...BASE_SHAPE, effect, effectSettings: DEFAULT_SHAPE_EFFECT_SETTINGS }
            });
            expect(
                parsed.type === 'upsert_layer' &&
                    parsed.layer.type === 'shape' &&
                    parsed.layer.effect
            ).toBe(effect);
        }
        const line = GSMessageSchema.parse({
            type: 'upsert_layer',
            origin: 'editor:set_shape_effect',
            layer: {
                numericId: 8,
                type: 'line',
                config: BASE_SHAPE.config,
                line: [0, 0, 100, 0],
                strokeColor: '#fff',
                strokeWidth: 4,
                strokeDash: [],
                effect: 'travel',
                effectSettings: DEFAULT_SHAPE_EFFECT_SETTINGS
            }
        });
        expect(
            line.type === 'upsert_layer' && line.layer.type === 'line' && line.layer.effect
        ).toBe('travel');
    });

    test('old saved effects map to the closest new effect', () => {
        const expected = {
            glow: 'focus',
            blink: 'focus',
            outline: 'focus',
            ripple: 'ping',
            flow: 'travel',
            orbit: 'travel',
            scan: 'travel',
            draw: 'reveal'
        } as const;
        for (const [oldEffect, newEffect] of Object.entries(expected)) {
            expect(migrateLegacyLayers([{ ...BASE_SHAPE, effect: oldEffect }])[0].effect).toBe(
                newEffect
            );
        }
    });
});
