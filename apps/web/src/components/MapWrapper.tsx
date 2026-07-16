'use client';

import { MVTLayer } from '@deck.gl/geo-layers';
import DeckGL from '@deck.gl/react';
import { useMemo, type FC, type HTMLAttributes, type RefAttributes } from 'react';

import { getMapTileSource } from '~/lib/mapTileSources';
import { setRefs } from '~/lib/setRefs';
import type { Layer } from '~/lib/types';

type MapLayer = Extract<Layer, { type: 'map' }>;
type MapWrapperProps = {
    layer: MapLayer;
    projectId?: string | null;
} & RefAttributes<HTMLDivElement> &
    Partial<HTMLAttributes<HTMLDivElement>>;

const FILL_COLOR: [number, number, number, number] = [60, 95, 120, 150];
const LINE_COLOR: [number, number, number, number] = [220, 218, 205, 200];
const POINT_COLOR: [number, number, number, number] = [245, 210, 110, 220];

export const MapWrapper: FC<MapWrapperProps> = ({ ref, layer, projectId, style, ...props }) => {
    const tileSource = useMemo(() => getMapTileSource(layer, projectId), [layer.tile, projectId]);
    const layers = useMemo(
        () => [
            new MVTLayer<Record<string, unknown>>({
                id: `map-vector-${layer.numericId}`,
                data: tileSource.tileUrl,
                minZoom: 0,
                maxZoom: tileSource.dataMaxZoom,
                binary: false,
                pickable: false,
                stroked: true,
                filled: true,
                pointType: 'circle',
                getFillColor: (feature) =>
                    feature.geometry?.type.includes('Point') ? POINT_COLOR : FILL_COLOR,
                getLineColor: LINE_COLOR,
                getLineWidth: 1,
                lineWidthUnits: 'pixels',
                getPointRadius: 3,
                pointRadiusUnits: 'pixels',
                refinementStrategy: 'best-available',
                loadOptions: {
                    mvt: {
                        coordinates: 'wgs84',
                        ...(tileSource.sourceLayers ? { layers: tileSource.sourceLayers } : {})
                    }
                }
            })
        ],
        [layer.numericId, tileSource]
    );

    return (
        <div
            ref={(node) => setRefs(node, ref)}
            {...props}
            style={{
                ...style,
                background: '#111317',
                overflow: 'hidden'
            }}
        >
            <DeckGL
                layers={layers}
                viewState={{
                    longitude: layer.view.longitude,
                    latitude: layer.view.latitude,
                    zoom: layer.view.zoom,
                    pitch: layer.view.pitch,
                    bearing: layer.view.bearing
                }}
                controller={false}
                width="100%"
                height="100%"
                style={{ position: 'absolute', inset: '0px' }}
            />
        </div>
    );
};

export default MapWrapper;
