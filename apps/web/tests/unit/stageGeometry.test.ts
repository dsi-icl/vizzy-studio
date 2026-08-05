import { describe, expect, test } from 'bun:test';

import {
    getKonvaRectTransform,
    getTransformedRectBounds,
    getVisualAnchorEdges,
    hasSameSpatialTransform
} from '../../src/lib/stageGeometry';

const scaledVideoConfig = {
    cx: 720,
    cy: 360,
    width: 160,
    height: 80,
    rotation: 0,
    scaleX: 1.5,
    scaleY: 0.75
};

describe('scaled layer geometry', () => {
    test('keeps layer scale separate from minimap coordinate scaling', () => {
        expect(getKonvaRectTransform(scaledVideoConfig, 0.15)).toEqual({
            x: 108,
            y: 54,
            width: 24,
            height: 12,
            offsetX: 12,
            offsetY: 6,
            scaleX: 1.5,
            scaleY: 0.75,
            rotation: 0
        });
    });

    test('calculates the visible bounds of non-uniformly scaled and rotated layers', () => {
        expect(getTransformedRectBounds(scaledVideoConfig)).toEqual({
            left: 600,
            top: 330,
            right: 840,
            bottom: 390,
            width: 240,
            height: 60
        });

        const rotated = getTransformedRectBounds({ ...scaledVideoConfig, rotation: 90 });
        expect(rotated.left).toBeCloseTo(690);
        expect(rotated.top).toBeCloseTo(240);
        expect(rotated.right).toBeCloseTo(750);
        expect(rotated.bottom).toBeCloseTo(480);
    });

    test('maps local transformer handles to their visual edges at cardinal rotations', () => {
        expect(getVisualAnchorEdges('top-left', 0)).toEqual({
            horizontal: 'left',
            vertical: 'top'
        });
        expect(getVisualAnchorEdges('top-left', 90)).toEqual({
            horizontal: 'right',
            vertical: 'top'
        });
        expect(getVisualAnchorEdges('bottom-right', 180)).toEqual({
            horizontal: 'left',
            vertical: 'top'
        });
        expect(getVisualAnchorEdges('middle-left', 270)).toEqual({
            horizontal: undefined,
            vertical: 'bottom'
        });
    });

    test('distinguishes spatial updates from harmless layer re-registration', () => {
        expect(hasSameSpatialTransform(scaledVideoConfig, { ...scaledVideoConfig })).toBe(true);
        expect(
            hasSameSpatialTransform(scaledVideoConfig, { ...scaledVideoConfig, scaleX: 1.25 })
        ).toBe(false);
        expect(hasSameSpatialTransform(scaledVideoConfig, { ...scaledVideoConfig, cx: 840 })).toBe(
            false
        );
    });
});
