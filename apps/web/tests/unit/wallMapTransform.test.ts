import { expect, test } from 'bun:test';

import { LngLat } from 'maplibre-gl';
import { MercatorTransform } from 'maplibre-gl/src/geo/projection/mercator_transform';

import { configureWallMapTransform, type WallMapTransform } from '../../src/lib/wallMapTransform';

test('pitched wall crops place labels in the same full-map coordinates', () => {
    // The package's source and bundled declarations describe the same runtime transform.
    const full = new MercatorTransform() as unknown as WallMapTransform;
    full.resize(900, 600, false);
    full.setFov(10);
    full.setZoom(14);
    full.setCenter(new LngLat(-0.017, 51.49));
    full.setPitch(60);
    full.setBearing(25);

    const locations = [
        new LngLat(-0.017, 51.49),
        new LngLat(-0.012, 51.491),
        new LngLat(-0.024, 51.486)
    ];
    const crops = [
        { x: 0, y: 0, width: 470, height: 400 },
        { x: 430, y: 160, width: 470, height: 400 }
    ];

    for (const crop of crops) {
        const wall = full.clone() as WallMapTransform;
        const restore = configureWallMapTransform(wall, full, () => crop);
        wall.resize(crop.width, crop.height, false);
        const placement = wall.clone();
        expect(placement.width).toBe(full.width);
        expect(placement.height).toBe(full.height);

        for (const location of locations) {
            const expected = full.locationToScreenPoint(location);
            const drawn = wall.locationToScreenPoint(location);
            const labels = placement.locationToScreenPoint(location);
            expect(drawn.x + crop.x).toBeCloseTo(expected.x, 5);
            expect(drawn.y + crop.y).toBeCloseTo(expected.y, 5);
            expect(labels.x).toBeCloseTo(expected.x, 5);
            expect(labels.y).toBeCloseTo(expected.y, 5);
        }

        restore();
    }
});

test('oversized maps keep a crop-sized collision viewport', () => {
    const full = new MercatorTransform() as unknown as WallMapTransform;
    full.resize(10_000, 2_000, false);
    full.setFov(10);
    full.setZoom(14);
    full.setCenter(new LngLat(-0.017, 51.49));
    full.setPitch(60);

    const crop = { x: 4_800, y: 800, width: 600, height: 400 };
    const wall = full.clone() as WallMapTransform;
    const restore = configureWallMapTransform(wall, full, () => crop);
    wall.resize(crop.width, crop.height, false);
    const placement = wall.clone();
    const location = new LngLat(-0.017, 51.49);

    expect(placement.width).toBe(crop.width);
    expect(placement.height).toBe(crop.height);
    expect(placement.locationToScreenPoint(location).x).toBeCloseTo(
        wall.locationToScreenPoint(location).x,
        5
    );
    expect(placement.locationToScreenPoint(location).y).toBeCloseTo(
        wall.locationToScreenPoint(location).y,
        5
    );

    restore();
});
