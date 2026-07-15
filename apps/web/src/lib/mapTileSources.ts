import type { Layer } from '~/lib/types';

const DEFAULT_WORLD_CITIES_TILE_URL = '/api/tiles/world_cities/{z}/{x}/{y}';

export const DEFAULT_MAP_TILE_SOURCE = {
    kind: 'vector',
    tileUrl: DEFAULT_WORLD_CITIES_TILE_URL,
    dataMaxZoom: 0,
    viewMaxZoom: 6,
    sourceLayers: ['cities']
} as const;

export type MapTileSource = NonNullable<Extract<Layer, { type: 'map' }>['tile']>;

export function getMapTileSource(layer: Extract<Layer, { type: 'map' }>): MapTileSource {
    const tileSource = {
        ...DEFAULT_MAP_TILE_SOURCE,
        ...(layer.tile ?? {})
    };

    if (tileSource.kind === 'vector' && tileSource.tileUrl === DEFAULT_WORLD_CITIES_TILE_URL) {
        return {
            ...tileSource,
            dataMaxZoom: DEFAULT_MAP_TILE_SOURCE.dataMaxZoom
        };
    }

    return tileSource;
}
