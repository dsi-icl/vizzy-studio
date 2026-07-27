'use client';

import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox';
import type { StyleSpecification } from 'maplibre-gl';
import { useCallback, useMemo, type FC, type HTMLAttributes, type RefAttributes } from 'react';
import Map, { useControl } from 'react-map-gl/maplibre';

import { setRefs } from '~/lib/setRefs';
import { DEFAULT_MAP_STYLE_ID, type Layer, type MapStyleId } from '~/lib/types';
import protomapsDarkStyle from '~/map-styles/protomaps-dark.json';
import protomapsDarkVizGrayStyle from '~/map-styles/protomaps-darkvizgray.json';
import protomapsDarkVizWhiteStyle from '~/map-styles/protomaps-darkvizwhite.json';
import protomapsLightStyle from '~/map-styles/protomaps-light.json';

type MapLayer = Extract<Layer, { type: 'map' }>;

const MAP_STYLES: Record<MapStyleId, StyleSpecification> = {
    'protomaps-light': protomapsLightStyle as StyleSpecification,
    'protomaps-dark': protomapsDarkStyle as StyleSpecification,
    'protomaps-darkvizgray': protomapsDarkVizGrayStyle as StyleSpecification,
    'protomaps-darkvizwhite': protomapsDarkVizWhiteStyle as StyleSpecification
};

type MapWrapperProps = {
    layer: MapLayer;
    projectId: string;
} & RefAttributes<HTMLDivElement> &
    Partial<HTMLAttributes<HTMLDivElement>>;

function DeckGLOverlay(props: MapboxOverlayProps) {
    const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
    overlay.setProps(props);
    return null;
}

export const MapWrapper: FC<MapWrapperProps> = ({ ref, layer, projectId, style, ...props }) => {
    const styleId = layer.style ?? DEFAULT_MAP_STYLE_ID;
    const tileUrl = useMemo(() => {
        const path = `/api/projects/${encodeURIComponent(projectId)}/tiles/protomaps/{z}/{x}/{y}`;
        return typeof window === 'undefined' ? path : `${window.location.origin}${path}`;
    }, [projectId]);

    const mapStyle = useMemo(() => {
        const baseStyle = MAP_STYLES[styleId];

        return {
            ...baseStyle,
            sources: {
                ...baseStyle.sources,
                protomaps: {
                    ...baseStyle.sources.protomaps,
                    tiles: [tileUrl]
                }
            },
            layers: baseStyle.layers.map((styleLayer) => {
                return styleLayer.id === 'building-3d'
                    ? {
                          ...styleLayer,
                          layout: {
                              ...styleLayer.layout,
                              visibility: layer.view.pitch > 0 ? 'visible' : 'none'
                          }
                      }
                    : styleLayer;
            })
        } as StyleSpecification;
    }, [styleId, tileUrl, layer.view.pitch]);
    const deckLayers = useMemo<MapboxOverlayProps['layers']>(() => [], []);
    const transformRequest = useCallback((url: string) => {
        if (url.includes('/api/projects/') && url.includes('/tiles/')) {
            return { url, credentials: 'include' as const };
        }
        return { url };
    }, []);

    return (
        <div
            ref={(node) => setRefs(node, ref)}
            {...props}
            style={{
                ...style,
                position: style?.position ?? 'relative',
                background: '#f4f1ea',
                overflow: 'hidden'
            }}
        >
            <Map
                key={`${styleId}:${tileUrl}`}
                mapStyle={mapStyle}
                interactive={false}
                longitude={layer.view.longitude}
                latitude={layer.view.latitude}
                zoom={layer.view.zoom}
                maxPitch={90}
                pitch={layer.view.pitch}
                bearing={layer.view.bearing}
                attributionControl={false}
                transformRequest={transformRequest}
                onLoad={(event) => {
                    event.target.setVerticalFieldOfView(10);
                }}
                onError={(event) => {
                    if (process.env.NODE_ENV === 'development') {
                        console.warn('[MapWrapper]', event.error);
                    }
                }}
                style={{ position: 'absolute', inset: '0px' }}
            >
                <DeckGLOverlay layers={deckLayers} interleaved />
            </Map>
        </div>
    );
};

export default MapWrapper;
