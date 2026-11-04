import { LngLat, Point, type Map as MapLibreMap } from 'maplibre-gl';

export const MAP_ZOOM_MIN = 0;
export const MAP_ZOOM_MAX = 20;
export const MAP_PITCH_MIN = 0;
export const MAP_PITCH_MAX = 90;

export type MapTouchGestureKind = 'zoom' | 'pitch';

export function clampMapView(zoom: number, pitch: number) {
    return {
        zoom: Math.max(MAP_ZOOM_MIN, Math.min(MAP_ZOOM_MAX, zoom)),
        pitch: Math.max(MAP_PITCH_MIN, Math.min(MAP_PITCH_MAX, pitch))
    };
}

export function classifyMapTouchGesture(
    startDistance: number,
    distance: number,
    startCenterY: number,
    centerY: number
): MapTouchGestureKind | null {
    if (startDistance <= 0 || distance <= 0) return null;
    const zoomMotion = Math.abs(Math.log2(distance / startDistance)) * 120;
    const pitchMotion = Math.abs(centerY - startCenterY);
    if (zoomMotion < 6 && pitchMotion < 8) return null;
    return zoomMotion > pitchMotion ? 'zoom' : 'pitch';
}

export function mapPinchZoomDelta(previousDistance: number, distance: number) {
    return previousDistance > 0 && distance > 0 ? Math.log2(distance / previousDistance) * 1.5 : 0;
}

export function mapPitchDelta(previousCenterY: number, centerY: number) {
    return (previousCenterY - centerY) * 0.15;
}

export function mapScrollPitchDelta(pixels: number) {
    return pixels * 0.12;
}

type MapCameraView = {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch: number;
    bearing: number;
};

/** Calculate the center that leaves the cursor's geographic point in place. */
export function mapZoomCenterAtLocalPoint(
    map: Pick<MapLibreMap, 'getContainer' | 'transform'>,
    view: MapCameraView,
    nextZoom: number,
    point: { x: number; y: number },
    displaySize: { width: number; height: number }
): { longitude: number; latitude: number } | null {
    const container = map.getContainer();
    if (
        displaySize.width <= 0 ||
        displaySize.height <= 0 ||
        container.clientWidth <= 0 ||
        container.clientHeight <= 0
    )
        return null;

    // The editor stretches a smaller MapLibre viewport to the layer's bounds.
    // Its camera transform uses that smaller viewport's CSS pixel space.
    const mapPoint = new Point(
        (point.x / displaySize.width) * container.clientWidth,
        (point.y / displaySize.height) * container.clientHeight
    );
    // Work on a clone: react-map-gl owns the visible camera and resets direct
    // MapLibre camera moves until its controlled props have been updated.
    const camera = map.transform.clone();
    camera.setZoom(view.zoom);
    camera.setPitch(view.pitch);
    camera.setBearing(view.bearing);
    camera.setCenter(new LngLat(view.longitude, view.latitude));
    const location = camera.screenPointToLocation(mapPoint);
    if (!Number.isFinite(location.lng) || !Number.isFinite(location.lat)) return null;
    camera.setZoom(nextZoom);
    camera.setLocationAtPoint(location, mapPoint);
    const center = camera.center;
    return Number.isFinite(center.lng) && Number.isFinite(center.lat)
        ? { longitude: center.lng, latitude: center.lat }
        : null;
}
