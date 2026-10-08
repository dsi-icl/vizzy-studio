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

    // Symbol placement clones the transform. MapLibre's clone copies padding,
    // but loses our off-axis center, so its collision boxes used a different
    // camera from the cropped map image (most visible at pitch and seams).
    transform.clone = () => {
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
