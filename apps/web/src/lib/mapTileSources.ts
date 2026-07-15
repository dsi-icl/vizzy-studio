import type { Layer } from '~/lib/types';

export const DEFAULT_MAP_TILE_SOURCE = {
    kind: 'vector',
    tileUrl: '/api/tiles/london/{z}/{x}/{y}',
    dataMaxZoom: 14,
    viewMaxZoom: 14,
    sourceLayers: [
        'land',
        'water_polygons',
        'water_lines',
        'boundaries',
        'streets',
        'street_labels',
        'buildings',
        'place_labels',
        'pois'
    ]
} as const;

export type MapTileSource = NonNullable<Extract<Layer, { type: 'map' }>['tile']>;

export function getMapTileSource(layer: Extract<Layer, { type: 'map' }>): MapTileSource {
    return {
        ...DEFAULT_MAP_TILE_SOURCE,
        ...(layer.tile ?? {})
    };
}
