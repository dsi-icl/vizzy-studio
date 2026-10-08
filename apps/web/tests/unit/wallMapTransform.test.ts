import { expect, test } from 'bun:test';

import { LngLat } from 'maplibre-gl';
import { MercatorTransform } from 'maplibre-gl/src/geo/projection/mercator_transform';

import { configureWallMapTransform, type WallMapTransform } from '../../src/lib/wallMapTransform';

test('pitched wall crops keep the full map camera when MapLibre clones them for labels', () => {
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

        for (const location of locations) {
            const expected = full.locationToScreenPoint(location);
            const drawn = wall.locationToScreenPoint(location);
            const labels = placement.locationToScreenPoint(location);
            expect(drawn.x + crop.x).toBeCloseTo(expected.x, 5);
            expect(drawn.y + crop.y).toBeCloseTo(expected.y, 5);
            expect(labels.x).toBeCloseTo(drawn.x, 5);
            expect(labels.y).toBeCloseTo(drawn.y, 5);
        }

        restore();
    }
});
