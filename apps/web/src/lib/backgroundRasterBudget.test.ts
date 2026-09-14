import { describe, expect, test } from 'bun:test';

import {
    BACKGROUND_PREVIEW_MAX_EDGE,
    BACKGROUND_PREVIEW_MAX_PIXELS,
    resolveBackgroundRasterSize
} from './backgroundRasterBudget';

describe('resolveBackgroundRasterSize', () => {
    test.each([
        ['default 16x4 wall', 16 * 1_920, 4 * 1_080],
        ['portrait wall', 1_920, 4 * 1_080],
        ['square wall', 2_000, 2_000],
        ['extreme portrait wall', 320, 16 * 2_160],
        ['extreme landscape wall', 16 * 3_840, 320]
    ])('%s stays within the raster budget', (_name, width, height) => {
        const raster = resolveBackgroundRasterSize(width, height, 1, 2);

        expect(raster.width).toBeGreaterThan(0);
        expect(raster.height).toBeGreaterThan(0);
        expect(raster.width).toBeLessThanOrEqual(BACKGROUND_PREVIEW_MAX_EDGE);
        expect(raster.height).toBeLessThanOrEqual(BACKGROUND_PREVIEW_MAX_EDGE);
        expect(raster.width * raster.height).toBeLessThanOrEqual(BACKGROUND_PREVIEW_MAX_PIXELS);
        const expectedAspect = width / height;
        expect(
            Math.abs(raster.width / raster.height - expectedAspect) / expectedAspect
        ).toBeLessThan(0.02);
    });
});
