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
import { configureWallMapTransform, type WallMapTransform } from '~/lib/wallMapTransform';
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
    const retainedCanvasRef = useRef<HTMLCanvasElement>(null);
    const rendererRef = useRef<ReturnType<typeof createWallMapRenderer> | null>(null);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const retainedCanvas = retainedCanvasRef.current;
        if (!container || !retainedCanvas) return;
        const map = new MapLibreMap({
            container,
            style: { version: 8, sources: {}, layers: [] },
            interactive: false,
            attributionControl: false,
            trackResize: false,
            // Wall crops should settle immediately instead of restarting label
            // fades every time movement reveals another part of the same map.
            fadeDuration: 0,
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
        const renderer = createWallMapRenderer(map, container, retainedCanvas);
        rendererRef.current = renderer;
        return () => {
            rendererRef.current = null;
            renderer.dispose();
            map.remove();
        };
    }, [transformRequest]);

    useLayoutEffect(() => {
        rendererRef.current?.update({ layer, viewport, mapStyle, pixelRatio });
    }, [layer, viewport, mapStyle, pixelRatio, transformRequest]);

    useLayoutEffect(() => {
        const render: WallMapRenderer = (config) => rendererRef.current?.render(config);
        renderers.set(layer.numericId, render);
        return () => {
            if (renderers.get(layer.numericId) === render) renderers.delete(layer.numericId);
        };
    }, [layer.numericId, renderers]);

    return (
        <>
            <div
                ref={containerRef}
                style={{ position: 'absolute', width: 1, height: 1, transformOrigin: 'top left' }}
            />
            <canvas
                ref={retainedCanvasRef}
                width={1}
                height={1}
                aria-hidden="true"
                style={{
                    position: 'absolute',
                    visibility: 'hidden',
                    pointerEvents: 'none',
                    zIndex: 1
                }}
            />
        </>
    );
}

type WallMapCrop = {
    x: number;
    y: number;
    width: number;
    height: number;
};

/**
 * Convert one wall unit's world viewport into map-local pixel crops.
 *
 * `required` reserves half the gutter for loading: start preparing another
 * crop before the current one runs out.
 * `buffered` is the larger region actually rendered into the WebGL canvas.
 */
function getWallMapCropPlan(
    placement: MapLayer['config'],
    viewport: Viewport,
    viewportScale: number
) {
    const { cx, cy, width, height, scaleX, scaleY, rotation } = placement;
    if (
        !Number.isFinite(viewportScale) ||
        viewportScale <= 0 ||
        ![cx, cy, width, height, scaleX, scaleY, rotation].every(Number.isFinite) ||
        width <= 0 ||
        height <= 0 ||
        !scaleX ||
        !scaleY
    ) {
        return null;
    }

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

    const visibleLeft = Math.max(0, Math.min(...corners.map((point) => point.x)));
    const visibleTop = Math.max(0, Math.min(...corners.map((point) => point.y)));
    const visibleRight = Math.min(width, Math.max(...corners.map((point) => point.x)));
    const visibleBottom = Math.min(height, Math.max(...corners.map((point) => point.y)));
    if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return null;

    const fullWidth = Math.max(1, Math.round(width * viewportScale));
    const fullHeight = Math.max(1, Math.round(height * viewportScale));
    const gutter = 128 / Math.min(Math.abs(scaleX), Math.abs(scaleY));
    const toCrop = (margin: number): WallMapCrop => {
        const x = Math.max(0, Math.floor((visibleLeft - margin) * viewportScale));
        const y = Math.max(0, Math.floor((visibleTop - margin) * viewportScale));
        const right = Math.min(fullWidth, Math.ceil((visibleRight + margin) * viewportScale));
        const bottom = Math.min(fullHeight, Math.ceil((visibleBottom + margin) * viewportScale));
        return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
    };

    return {
        fullWidth,
        fullHeight,
        required: toCrop(gutter / 2),
        buffered: toCrop(gutter)
    };
}

function wallMapCropContains(container: WallMapCrop, content: WallMapCrop): boolean {
    return (
        content.x >= container.x &&
        content.y >= container.y &&
        content.x + content.width <= container.x + container.width &&
        content.y + content.height <= container.y + container.height
    );
}

type WallMapInput = {
    layer: MapLayer;
    viewport: Viewport;
    mapStyle: StyleSpecification;
    pixelRatio: number;
};
type RetainedFrame = {
    crop: WallMapCrop;
    viewportScale: number;
    width: number;
    height: number;
};

/** Keep the render cache alive for the map's lifetime, including JSON position updates. */
function createWallMapRenderer(
    map: MapLibreMap,
    container: HTMLDivElement,
    retainedCanvas: HTMLCanvasElement
) {
    const context = retainedCanvas.getContext('2d');
    let input: WallMapInput | null = null;
    let lastConfig: MapLayer['config'] | null = null;
    let transform = map.transform as WallMapTransform;
    // Camera math only: never allocate a full-wall WebGL canvas.
    const full = transform.clone();
    full.setFov(10);
    full.clearNearFarZOverride();
    let crop: WallMapCrop = { x: 0, y: 0, width: 1, height: 1 };
    let requestedFrame: RetainedFrame | null = null;
    let retainedFrame: RetainedFrame | null = null;
    let renderedCamera: number[] = [];
    let previous: number[] = [];
    let invalidated = true;
    let updating = false;
    let visible = false;
    let restoreTransform = configureWallMapTransform(transform, full, () => crop);

    const positionRetainedFrame = () => {
        if (!retainedFrame || !lastConfig || !visible) return;
        const { crop: retained, viewportScale, width, height } = retainedFrame;
        // During a layer resize, stretch the old complete frame with the layer
        // until the newly framed map is ready. Translation/rotation/scale are
        // already applied to both canvases by the wall's parent DOM element.
        const xScale = lastConfig.width / width / viewportScale;
        const yScale = lastConfig.height / height / viewportScale;
        retainedCanvas.style.left = `${retained.x * xScale}px`;
        retainedCanvas.style.top = `${retained.y * yScale}px`;
        retainedCanvas.style.width = `${retained.width * xScale}px`;
        retainedCanvas.style.height = `${retained.height * yScale}px`;
        retainedCanvas.style.visibility = 'visible';
    };

    const render: WallMapRenderer = (config) => {
        lastConfig = config;
        if (!input || updating) return;
        // Style loading and WebGL restoration may replace the transform.
        if (transform !== map.transform) {
            restoreTransform();
            transform = map.transform as WallMapTransform;
            restoreTransform = configureWallMapTransform(transform, full, () => crop);
            invalidated = true;
        }
        const { layer, viewport, pixelRatio } = input;
        const viewportScale = layer.viewportScale ?? 1;
        const { width, height, scaleX, scaleY, cx, cy, rotation } = config;
        const density = pixelRatio * Math.max(Math.abs(scaleX), Math.abs(scaleY));
        const camera = [
            width,
            height,
            viewportScale,
            density,
            layer.view.longitude,
            layer.view.latitude,
            layer.view.zoom,
            layer.view.pitch,
            layer.view.bearing
        ];
        const next = [
            ...camera,
            cx,
            cy,
            scaleX,
            scaleY,
            rotation,
            viewport.x,
            viewport.y,
            viewport.w,
            viewport.h
        ];
        if (!invalidated && next.every((value, index) => value === previous[index])) return;
        previous = next;

        const plan = getWallMapCropPlan(config, viewport, viewportScale);
        visible = plan !== null;
        if (!plan) {
            container.style.visibility = 'hidden';
            retainedCanvas.style.visibility = 'hidden';
            return;
        }
        container.style.visibility = 'visible';
        positionRetainedFrame();

        // Compare camera values, not the layer object or its position. Keep the
        // rendered buffer while it covers this screen plus a small loading margin.
        if (
            !invalidated &&
            requestedFrame &&
            camera.every((value, index) => value === renderedCamera[index]) &&
            wallMapCropContains(requestedFrame.crop, plan.required)
        ) {
            return;
        }

        invalidated = false;
        renderedCamera = camera;
        crop = plan.buffered;
        requestedFrame = { crop, viewportScale, width, height };
        // The retained 2D canvas stays at its old source coordinates above this
        // live canvas. Resizing/retiling cannot erase the last complete image;
        // only newly exposed areas show MapLibre's in-progress render underneath.
        container.style.left = `${crop.x / viewportScale}px`;
        container.style.top = `${crop.y / viewportScale}px`;
        container.style.width = `${crop.width}px`;
        container.style.height = `${crop.height}px`;
        container.style.transform = `scale(${1 / viewportScale})`;

        full.resize(plan.fullWidth, plan.fullHeight, false);
        full.setZoom(layer.view.zoom);
        full.setCenter(new LngLat(layer.view.longitude, layer.view.latitude));
        full.setPitch(layer.view.pitch);
        full.setBearing(layer.view.bearing);

        const canvas = map.getCanvas();
        if (map.getPixelRatio() !== density) {
            map.setPixelRatio(density);
        } else if (
            canvas.style.width !== `${crop.width}px` ||
            canvas.style.height !== `${crop.height}px`
        ) {
            map.resize(undefined, false);
        }
        // Run this only for an actual crop/camera change. Its move events make
        // MapLibre update source coverage, including a new off-axis crop.
        map.jumpTo({
            center: full.center,
            zoom: full.zoom,
            pitch: full.pitch,
            bearing: full.bearing
        });
        transform.apply(full, false);
        transform.overrideNearFarZ(full.nearZ, full.farZ);
        transform.resize(crop.width, crop.height, false);
    };

    const refresh = () => {
        invalidated = true;
        if (lastConfig) render(lastConfig);
    };
    const onIdle = () => {
        if (
            !context ||
            !requestedFrame ||
            updating ||
            invalidated ||
            requestedFrame === retainedFrame ||
            !map.loaded()
        ) {
            return;
        }
        const canvas = map.getCanvas();
        if (!canvas.width || !canvas.height) return;
        // idle fires synchronously after the final render, before the browser
        // discards the WebGL drawing buffer. No preserveDrawingBuffer is needed.
        // Resize + copy + reposition happen together before the next browser paint.
        if (retainedCanvas.width !== canvas.width) retainedCanvas.width = canvas.width;
        if (retainedCanvas.height !== canvas.height) retainedCanvas.height = canvas.height;
        context.clearRect(0, 0, retainedCanvas.width, retainedCanvas.height);
        context.drawImage(canvas, 0, 0);
        retainedFrame = requestedFrame;
        positionRetainedFrame();
    };
    map.on('projectiontransition', refresh);
    map.on('style.load', refresh);
    map.on('webglcontextrestored', refresh);
    map.on('idle', onIdle);

    return {
        render,
        update(next: WallMapInput) {
            const styleChanged = input?.mapStyle !== next.mapStyle;
            input = next;
            lastConfig = next.layer.config;
            if (styleChanged) {
                // setStyle can synchronously replace the projection. Defer the
                // refresh handler until the entire new input is installed.
                invalidated = true;
                updating = true;
                try {
                    map.setStyle(next.mapStyle);
                } finally {
                    updating = false;
                }
            }
            render(lastConfig);
        },
        dispose() {
            map.off('projectiontransition', refresh);
            map.off('style.load', refresh);
            map.off('webglcontextrestored', refresh);
            map.off('idle', onIdle);
            restoreTransform();
            retainedCanvas.style.visibility = 'hidden';
            retainedCanvas.width = retainedCanvas.height = 1;
        }
    };
}

export default MapWrapper;
