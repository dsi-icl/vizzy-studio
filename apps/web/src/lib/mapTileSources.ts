import type { Layer } from '~/lib/types';

export const DEFAULT_MAP_TILE_SOURCE = {
    kind: 'vector',
    tileUrl: '/api/tiles/world_cities/{z}/{x}/{y}',
    dataMaxZoom: 6,
    viewMaxZoom: 6,
    sourceLayers: ['cities']
} as const;

export type MapTileSource = NonNullable<Extract<Layer, { type: 'map' }>['tile']>;

export function getMapTileSource(layer: Extract<Layer, { type: 'map' }>): MapTileSource {
    return {
        ...DEFAULT_MAP_TILE_SOURCE,
        ...(layer.tile ?? {})
    };
}
