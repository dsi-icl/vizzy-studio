import type { Layer } from '~/lib/types';

// Temporary Martin sample source until map layers have source selection UI.
export const DEFAULT_LONDON_TILE_SOURCE = {
    kind: 'vector',
    tileUrl: '/api/tiles/london/{z}/{x}/{y}',
    dataMaxZoom: 14,
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
        ...DEFAULT_LONDON_TILE_SOURCE,
        ...(layer.tile ?? {})
    };
}
