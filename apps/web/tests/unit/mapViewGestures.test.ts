import { describe, expect, test } from 'bun:test';

import { LngLat, Point, type Map as MapLibreMap } from 'maplibre-gl';
import { MercatorTransform } from 'maplibre-gl/src/geo/projection/mercator_transform';

import {
    clampMapView,
    classifyMapTouchGesture,
    mapPinchZoomDelta,
    mapPitchDelta,
    mapScrollPitchDelta,
    mapZoomCenterAtLocalPoint
} from '../../src/lib/mapViewGestures';

describe('selected map gestures', () => {
    test('parallel two-finger movement changes pitch despite slight pinch jitter', () => {
        expect(classifyMapTouchGesture(100, 102, 250, 230)).toBe('pitch');
        expect(mapPitchDelta(250, 230)).toBeGreaterThan(0);
        expect(mapPitchDelta(230, 250)).toBeLessThan(0);
        expect(mapScrollPitchDelta(-20)).toBeLessThan(0);
        expect(mapScrollPitchDelta(20)).toBeGreaterThan(0);
    });

    test('pinching changes zoom despite slight center drift', () => {
        expect(classifyMapTouchGesture(100, 130, 250, 253)).toBe('zoom');
        expect(mapPinchZoomDelta(100, 130)).toBeGreaterThan(0);
        expect(mapPinchZoomDelta(130, 100)).toBeLessThan(0);
    });

    test('small movement stays undecided and camera limits match the parameter fields', () => {
        expect(classifyMapTouchGesture(100, 101, 250, 253)).toBeNull();
        expect(clampMapView(-1, 95)).toEqual({ zoom: 0, pitch: 90 });
        expect(clampMapView(21, -2)).toEqual({ zoom: 20, pitch: 0 });
    });

    test.each([
        { pitch: 0, bearing: 0 },
        { pitch: 50, bearing: 30 }
    ])(
        'keeps the cursor location fixed with pitch $pitch and bearing $bearing',
        ({ pitch, bearing }) => {
            const transform = new MercatorTransform({
                minZoom: 0,
                maxZoom: 22,
                minPitch: 0,
                maxPitch: 90,
                renderWorldCopies: true
            });
            transform.resize(160, 60);
            transform.setCenter(new LngLat(10, 50));
            transform.setZoom(4);
            transform.setPitch(pitch);
            transform.setBearing(bearing);
            const map = {
                getContainer: () => ({ clientWidth: 160, clientHeight: 60 }),
                transform
            } as unknown as Pick<MapLibreMap, 'getContainer' | 'transform'>;
            const cursor = new Point(120, 30);
            const originalLocation = transform.screenPointToLocation(cursor);

            const center = mapZoomCenterAtLocalPoint(
                map,
                { longitude: 10, latitude: 50, zoom: 4, pitch, bearing },
                5,
                { x: 600, y: 150 },
                { width: 800, height: 300 }
            );
            expect(center).not.toBeNull();
            if (!center) throw new Error('Expected a zoom center');
            expect(center.longitude).not.toBeCloseTo(originalLocation.lng);
            expect(transform.center.lng).toBe(10);
            expect(transform.zoom).toBe(4);

            const result = transform.clone();
            result.setZoom(5);
            result.setCenter(new LngLat(center.longitude, center.latitude));
            const afterLocation = result.screenPointToLocation(cursor);
            expect(afterLocation.lng).toBeCloseTo(originalLocation.lng, 6);
            expect(afterLocation.lat).toBeCloseTo(originalLocation.lat, 6);

            // The controlled preview can lag the editor store by a frame. A second
            // wheel event must use the latest authored view, not the stale preview.
            const nextCenter = mapZoomCenterAtLocalPoint(
                map,
                { ...center, zoom: 5, pitch, bearing },
                5.5,
                { x: 600, y: 150 },
                { width: 800, height: 300 }
            );
            expect(nextCenter).not.toBeNull();
            if (!nextCenter) throw new Error('Expected a second zoom center');
            result.setZoom(5.5);
            result.setCenter(new LngLat(nextCenter.longitude, nextCenter.latitude));
            const secondLocation = result.screenPointToLocation(cursor);
            expect(secondLocation.lng).toBeCloseTo(originalLocation.lng, 6);
            expect(secondLocation.lat).toBeCloseTo(originalLocation.lat, 6);
        }
    );
});
