'use client';

import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox';
import { LngLat, Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl';
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    type FC,
    type HTMLAttributes,
    type RefAttributes
} from 'react';
import Map, { type MapProps, type MapRef, useControl } from 'react-map-gl/maplibre';

import { setRefs } from '~/lib/setRefs';
import { DEFAULT_MAP_STYLE_ID, type Layer, type MapStyleId } from '~/lib/types';
import type { Viewport } from '~/lib/wallEngine';
import protomapsDarkStyle from '~/map-styles/protomaps-dark.json';
import protomapsDarkVizGrayStyle from '~/map-styles/protomaps-darkvizgray.json';
import protomapsDarkVizWhiteStyle from '~/map-styles/protomaps-darkvizwhite.json';
import protomapsLightStyle from '~/map-styles/protomaps-light.json';

type MapLayer = Extract<Layer, { type: 'map' }>;
export type WallMapRenderer = (config: MapLayer['config']) => void;
type WallMapViewport = {
    viewport: Viewport;
    renderers: globalThis.Map<number, WallMapRenderer>;
};

const MAP_STYLES: Record<MapStyleId, StyleSpecification> = {
    'protomaps-light': protomapsLightStyle as StyleSpecification,
    'protomaps-dark': protomapsDarkStyle as StyleSpecification,
    'protomaps-darkvizgray': protomapsDarkVizGrayStyle as StyleSpecification,
    'protomaps-darkvizwhite': protomapsDarkVizWhiteStyle as StyleSpecification
};

type MapWrapperProps = {
    layer: MapLayer;
    projectId: string;
    onIdle?: MapProps['onIdle'];
    onRender?: MapProps['onRender'];
    pixelRatio?: number;
    wall?: WallMapViewport;
} & RefAttributes<HTMLDivElement> &
    Partial<HTMLAttributes<HTMLDivElement>>;

function DeckGLOverlay(props: MapboxOverlayProps) {
    const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
    overlay.setProps(props);
    return null;
}

export const MapWrapper: FC<MapWrapperProps> = ({
    ref,
    layer,
    projectId,
    onIdle,
    onRender,
    pixelRatio,
    wall,
    style,
    ...props
}) => {
    // Render the authored editor viewport, then enlarge it to the layer bounds.
    // Camera zoom alone cannot preserve framing across different viewport sizes.
    const viewportScale = layer.viewportScale ?? 1;
    const mapPixelRatio =
        (pixelRatio ?? (typeof window === 'undefined' ? 1 : window.devicePixelRatio)) /
        viewportScale;
    const mapRef = useRef<MapRef>(null);
    useEffect(() => {
        // react-map-gl only applies pixelRatio when the map is constructed.
        // Update the backing resolution when the editor preview is zoomed.
        mapRef.current?.setPixelRatio(mapPixelRatio);
    }, [mapPixelRatio]);

    const styleId = layer.style ?? DEFAULT_MAP_STYLE_ID;
    const showBuildings = layer.view.pitch > 0;
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
                              visibility: showBuildings ? 'visible' : 'none'
                          }
                      }
                    : styleLayer;
            })
        } as StyleSpecification;
    }, [styleId, tileUrl, showBuildings]);
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
            {wall ? (
                <WallMapCanvas
                    layer={layer}
                    wall={wall}
                    mapStyle={mapStyle}
                    pixelRatio={mapPixelRatio}
                    transformRequest={transformRequest}
                />
            ) : (
                <Map
                    ref={mapRef}
                    key={`${styleId}:${tileUrl}`}
                    mapStyle={mapStyle}
                    pixelRatio={mapPixelRatio}
                    interactive={false}
                    longitude={layer.view.longitude}
                    latitude={layer.view.latitude}
                    zoom={layer.view.zoom}
                    maxPitch={90}
                    pitch={layer.view.pitch}
                    bearing={layer.view.bearing}
                    attributionControl={false}
                    transformRequest={transformRequest}
                    onIdle={onIdle}
                    onRender={onRender}
                    onLoad={(event) => {
                        event.target.setVerticalFieldOfView(10);
                    }}
                    onError={(event) => {
                        if (process.env.NODE_ENV === 'development') {
                            console.warn('[MapWrapper]', event.error);
                        }
                    }}
                    style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        width: `${viewportScale * 100}%`,
                        height: `${viewportScale * 100}%`,
                        transform: `scale(${1 / viewportScale})`,
                        transformOrigin: 'top left'
                    }}
                >
                    <DeckGLOverlay layers={deckLayers} interleaved />
                </Map>
            )}
        </div>
    );
};

// MapLibre has no public off-axis viewport API. Keep its Mercator-specific
// adaptation here: ordinary padding clamps the vanishing point to the canvas,
// whereas an outer wall screen needs that point to remain outside its canvas.
type WallMapTransform = MapLibreMap['transform'] & {
    _helper: {
        readonly centerPoint: MapLibreMap['transform']['centerPoint'];
        readonly fovInRadians: number;
        readonly fov: number;
    };
};

function WallMapCanvas({
    layer,
    wall: { viewport, renderers },
    mapStyle,
    pixelRatio,
    transformRequest
}: {
    layer: MapLayer;
    wall: WallMapViewport;
    mapStyle: StyleSpecification;
    pixelRatio: number;
    transformRequest: NonNullable<MapProps['transformRequest']>;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<MapLibreMap | null>(null);

    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const map = new MapLibreMap({
            container,
            style: { version: 8, sources: {}, layers: [] },
            interactive: false,
            attributionControl: false,
            trackResize: false,
            maxPitch: 90,
            transformRequest
        });
        const canvas = map.getCanvas();
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        if (gl) {
            const viewportLimit = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
            const textureLimit = Math.min(
                gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
                gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number
            );
            // Allow a HiDPI screen plus its gutter to exceed the default 4096.
            // Allocation still follows only this screen's cropped viewport.
            map._maxCanvasSize = [
                Math.min(textureLimit, viewportLimit[0]),
                Math.min(textureLimit, viewportLimit[1])
            ];
        }
        mapRef.current = map;
        return () => {
            mapRef.current = null;
            map.remove();
        };
    }, [transformRequest]);

    useLayoutEffect(() => {
        mapRef.current?.setStyle(mapStyle);
    }, [mapStyle]);

    useLayoutEffect(() => {
        const map = mapRef.current;
        const container = containerRef.current;
        if (!map || !container) return;
        const viewportScale = layer.viewportScale ?? 1;
        let transform = map.transform as WallMapTransform;
        // This is only camera math. Never allocate a full-wall WebGL canvas.
        const full = transform.clone();
        full.setFov(10);
        full.clearNearFarZOverride();
        let crop = { x: 0, y: 0, width: 1, height: 1 };
        const restoreTransform = () => {
            for (const property of ['centerPoint', 'fovInRadians', 'fov']) {
                Reflect.deleteProperty(transform._helper, property);
            }
        };
        const configureTransform = () =>
            Object.defineProperties(transform._helper, {
                centerPoint: {
                    configurable: true,
                    get: () => {
                        const point = full.centerPoint;
                        point.x -= crop.x;
                        point.y -= crop.y;
                        return point;
                    }
                },
                fovInRadians: {
                    configurable: true,
                    get: () =>
                        2 * Math.atan((crop.height / full.height) * Math.tan(full.fovInRadians / 2))
                },
                fov: {
                    configurable: true,
                    get: () => (transform._helper.fovInRadians * 180) / Math.PI
                }
            });
        configureTransform();
        let previous: number[] = [];
        let lastConfig = layer.config;
        const render: WallMapRenderer = (config) => {
            lastConfig = config;
            // Style loading can replace MapLibre's transform, including on the
            // first load and after WebGL context restoration.
            if (transform !== map.transform) {
                restoreTransform();
                transform = map.transform as WallMapTransform;
                configureTransform();
                previous = [];
            }
            const { cx, cy, width, height, scaleX, scaleY, rotation } = config;
            const next = [cx, cy, width, height, scaleX, scaleY, rotation];
            if (next.every((value, index) => value === previous[index])) return;
            previous = next;
            if (!width || !height || !scaleX || !scaleY) {
                container.style.visibility = 'hidden';
                return;
            }

            // Invert the layer's CSS transform to find this screen in map space.
            // A small gutter keeps labels and antialiasing across screen edges.
            const angle = (rotation * Math.PI) / 180;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const corners = [
                [viewport.x, viewport.y],
                [viewport.x + viewport.w, viewport.y],
                [viewport.x, viewport.y + viewport.h],
                [viewport.x + viewport.w, viewport.y + viewport.h]
            ].map(([x, y]) => ({
                x: ((x - cx) * cos + (y - cy) * sin) / scaleX + width / 2,
                y: (-(x - cx) * sin + (y - cy) * cos) / scaleY + height / 2
            }));
            const gutter = 128 / Math.min(Math.abs(scaleX), Math.abs(scaleY));
            const left = Math.max(0, Math.min(...corners.map((point) => point.x)) - gutter);
            const top = Math.max(0, Math.min(...corners.map((point) => point.y)) - gutter);
            const right = Math.min(width, Math.max(...corners.map((point) => point.x)) + gutter);
            const bottom = Math.min(height, Math.max(...corners.map((point) => point.y)) + gutter);
            if (right <= left || bottom <= top) {
                container.style.visibility = 'hidden';
                return;
            }

            const fullWidth = Math.max(1, Math.round(width * viewportScale));
            const fullHeight = Math.max(1, Math.round(height * viewportScale));
            const x = Math.floor(left * viewportScale);
            const y = Math.floor(top * viewportScale);
            crop = {
                x,
                y,
                width: Math.max(1, Math.min(fullWidth, Math.ceil(right * viewportScale)) - x),
                height: Math.max(1, Math.min(fullHeight, Math.ceil(bottom * viewportScale)) - y)
            };
            container.style.visibility = 'visible';
            container.style.left = `${x / viewportScale}px`;
            container.style.top = `${y / viewportScale}px`;
            container.style.width = `${crop.width}px`;
            container.style.height = `${crop.height}px`;
            container.style.transform = `scale(${1 / viewportScale})`;

            full.resize(fullWidth, fullHeight, false);
            full.setZoom(layer.view.zoom);
            full.setCenter(new LngLat(layer.view.longitude, layer.view.latitude));
            full.setPitch(layer.view.pitch);
            full.setBearing(layer.view.bearing);

            const density = pixelRatio * Math.max(Math.abs(scaleX), Math.abs(scaleY));
            const canvas = map.getCanvas();
            if (map.getPixelRatio() !== density) {
                // setPixelRatio already resizes the canvas to the new container.
                map.setPixelRatio(density);
            } else if (
                canvas.style.width !== `${crop.width}px` ||
                canvas.style.height !== `${crop.height}px`
            ) {
                map.resize(undefined, false);
            }
            // jumpTo invalidates zoom-dependent style and source state. Applying
            // the full camera afterward keeps all screens on the same camera.
            // Its move events also load newly visible tiles on position-only updates.
            map.jumpTo({
                center: full.center,
                zoom: full.zoom,
                pitch: full.pitch,
                bearing: full.bearing
            });
            transform.apply(full, false);
            transform.overrideNearFarZ(full.nearZ, full.farZ);
            // Update projection math without reallocating the WebGL drawing buffer.
            transform.resize(crop.width, crop.height, false);
        };
        const refresh = () => {
            previous = [];
            render(lastConfig);
        };
        map.on('projectiontransition', refresh);
        map.on('style.load', refresh);
        map.on('webglcontextrestored', refresh);
        renderers.set(layer.numericId, render);
        render(layer.config);
        return () => {
            if (renderers.get(layer.numericId) === render) renderers.delete(layer.numericId);
            map.off('projectiontransition', refresh);
            map.off('style.load', refresh);
            map.off('webglcontextrestored', refresh);
            restoreTransform();
        };
    }, [layer, viewport, renderers, pixelRatio]);

    return (
        <div
            ref={containerRef}
            style={{ position: 'absolute', width: 1, height: 1, transformOrigin: 'top left' }}
        />
    );
}

export default MapWrapper;
