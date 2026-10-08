import type { Map as MapLibreMap } from 'maplibre-gl';

// MapLibre has no public off-axis viewport API. Padding clamps the vanishing
// point to the canvas, so wall crops need an explicit perspective offset.
export type WallMapTransform = MapLibreMap['transform'] & {
    _helper: {
        readonly centerPoint: MapLibreMap['transform']['centerPoint'];
        readonly fovInRadians: number;
        readonly fov: number;
    };
};

// MapLibre allocates two collision grids with one cell per ~25 CSS pixels.
// A full-map viewport beyond this budget would allocate many small arrays on
// every wall screen during symbol placement.
const MAX_SHARED_PLACEMENT_DIMENSION = 8192;
const MAX_SHARED_PLACEMENT_AREA = 16_000_000;

function canShareFullMapPlacement(full: MapLibreMap['transform']) {
    return (
        full.width <= MAX_SHARED_PLACEMENT_DIMENSION &&
        full.height <= MAX_SHARED_PLACEMENT_DIMENSION &&
        full.width * full.height <= MAX_SHARED_PLACEMENT_AREA
    );
}

export function configureWallMapTransform(
    transform: WallMapTransform,
    full: MapLibreMap['transform'],
    getCrop: () => { x: number; y: number; height: number }
) {
    const previousClone = Object.getOwnPropertyDescriptor(transform, 'clone');
    const originalClone = transform.clone.bind(transform);

    Object.defineProperties(transform._helper, {
        centerPoint: {
            configurable: true,
            get: () => {
                const { x, y } = getCrop();
                const point = full.centerPoint;
                point.x -= x;
                point.y -= y;
                return point;
            }
        },
        fovInRadians: {
            configurable: true,
            get: () =>
                2 * Math.atan((getCrop().height / full.height) * Math.tan(full.fovInRadians / 2))
        },
        fov: {
            configurable: true,
            get: () => (transform._helper.fovInRadians * 180) / Math.PI
        }
    });

    // MapLibre clones the transform for symbol placement. Full-map coordinates
    // and bounds prevent a wall crop's edge from changing label placement as
    // the layer moves. Tile availability can still differ between screens.
    // Fall back to the corrected local camera for very large maps to bound memory.
    transform.clone = () => {
        if (canShareFullMapPlacement(full)) return full.clone();

        const clone = originalClone() as WallMapTransform;
        const center = transform.centerPoint;
        Object.defineProperty(clone._helper, 'centerPoint', {
            configurable: true,
            get: () => center.clone()
        });
        clone.resize(clone.width, clone.height, false);
        return clone;
    };

    return () => {
        for (const property of ['centerPoint', 'fovInRadians', 'fov']) {
            Reflect.deleteProperty(transform._helper, property);
        }
        if (previousClone) Object.defineProperty(transform, 'clone', previousClone);
        else Reflect.deleteProperty(transform, 'clone');
    };
}
