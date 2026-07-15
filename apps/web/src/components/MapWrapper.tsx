'use client';

import { MVTLayer, TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import DeckGL from '@deck.gl/react';
import type { Feature, Geometry } from 'geojson';
import { useMemo, type FC, type HTMLAttributes, type RefAttributes } from 'react';

import { getMapTileSource } from '~/lib/mapTileSources';
import { setRefs } from '~/lib/setRefs';
import type { Layer } from '~/lib/types';

type MapLayer = Extract<Layer, { type: 'map' }>;
type TileFeature = Feature<Geometry, Record<string, unknown>>;

function getFeatureProperty(feature: TileFeature, keys: string[]): string {
    for (const key of keys) {
        const value = feature.properties?.[key];
        if (typeof value === 'string' && value.trim().length > 0) return value;
    }
    return '';
}

function getFeatureClass(feature: TileFeature): string {
    return getFeatureProperty(feature, [
        'class',
        'kind',
        'type',
        'layer',
        'layerName',
        'sourceLayer'
    ]).toLowerCase();
}

function getFillColor(feature: TileFeature): [number, number, number, number] {
    const geometryType = feature.geometry?.type ?? '';
    if (geometryType.includes('Point')) return [245, 210, 110, 220];

    const featureClass = getFeatureClass(feature);
    if (featureClass.includes('water')) return [64, 120, 160, 190];
    if (featureClass.includes('park') || featureClass.includes('wood')) return [78, 125, 88, 150];
    if (featureClass.includes('building')) return [180, 176, 164, 160];
    if (featureClass.includes('landuse')) return [118, 128, 104, 90];
    return [46, 52, 58, 80];
}

function getLineColor(feature: TileFeature): [number, number, number, number] {
    const featureClass = getFeatureClass(feature);
    if (featureClass.includes('motorway') || featureClass.includes('trunk')) {
        return [235, 176, 96, 230];
    }
    if (featureClass.includes('primary') || featureClass.includes('secondary')) {
        return [226, 214, 182, 220];
    }
    if (featureClass.includes('rail')) return [160, 160, 168, 170];
    if (featureClass.includes('water')) return [75, 145, 190, 200];
    return [190, 190, 184, 170];
}

function getLineWidth(feature: TileFeature): number {
    const featureClass = getFeatureClass(feature);
    if (featureClass.includes('motorway') || featureClass.includes('trunk')) return 2.4;
    if (featureClass.includes('primary')) return 1.8;
    if (featureClass.includes('secondary')) return 1.4;
    if (featureClass.includes('rail')) return 1.1;
    return 0.8;
}

function getLabel(feature: TileFeature): string {
    const geometryType = feature.geometry?.type ?? '';
    if (!geometryType.includes('Point')) return '';
    return getFeatureProperty(feature, ['name', 'name_en', 'name:en']);
}

function isTileImage(data: unknown): boolean {
    return (
        data instanceof HTMLImageElement ||
        data instanceof ImageBitmap ||
        data instanceof ImageData ||
        data instanceof HTMLCanvasElement
    );
}

export const MapWrapper: FC<
    { layer: MapLayer } & RefAttributes<HTMLDivElement> & Partial<HTMLAttributes<HTMLDivElement>>
> = ({ ref, layer, style, ...props }) => {
    const tileSource = useMemo(() => getMapTileSource(layer), [layer]);
    const layers = useMemo(() => {
        if (tileSource.kind === 'raster') {
            return [
                new TileLayer({
                    id: `map-raster-${layer.numericId}`,
                    data: tileSource.tileUrl,
                    minZoom: 0,
                    maxZoom: tileSource.dataMaxZoom,
                    refinementStrategy: 'best-available',
                    renderSubLayers: (subLayerProps) => {
                        if (!isTileImage(subLayerProps.data)) return null;
                        const [[west, south], [east, north]] = subLayerProps.tile.boundingBox;
                        return new BitmapLayer(subLayerProps, {
                            id: `${subLayerProps.id}-bitmap`,
                            image: subLayerProps.data,
                            bounds: [west, south, east, north]
                        });
                    }
                })
            ];
        }

        return [
            new MVTLayer<Record<string, unknown>>({
                id: `map-vector-${layer.numericId}`,
                data: tileSource.tileUrl,
                minZoom: 0,
                maxZoom: tileSource.dataMaxZoom,
                binary: false,
                pickable: false,
                stroked: true,
                filled: true,
                pointType: 'circle+text',
                getFillColor,
                getLineColor,
                getLineWidth,
                lineWidthUnits: 'pixels',
                getPointRadius: 4,
                pointRadiusUnits: 'pixels',
                getText: getLabel,
                getTextColor: [245, 245, 238, 210],
                getTextSize: 12,
                textSizeUnits: 'pixels',
                textFontFamily:
                    'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                textCharacterSet: 'auto',
                refinementStrategy: 'best-available',
                loadOptions: {
                    mvt: {
                        coordinates: 'wgs84',
                        ...(tileSource.sourceLayers ? { layers: tileSource.sourceLayers } : {})
                    }
                }
            })
        ];
    }, [layer.numericId, tileSource]);

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
