'use client';

import type { ImageDeepZoomLayer } from '@repo/db/schema';
import { selectAssetVariantSrc } from '@repo/ui/lib/assetVariants';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Shape } from 'react-konva';

import {
    ImageTileController,
    type ImageTileView,
    clippedViewport,
    observeImageTileView
} from '~/lib/imageTiles';
import { applyKonvaFilters } from '~/lib/konvaFilters';
import { toCssFilterString } from '~/lib/layerFilters';
import type { LayerWithEditorState } from '~/lib/types';

function LegacyKonvaStaticImage({
    layer,
    isDrawing,
    isPinching,
    isLocked,
    opacity,
    onSelect,
    onTransform,
    onTransformEnd
}: {
    layer: Extract<LayerWithEditorState, { type: 'image' }>;
    isDrawing: boolean;
    isPinching: boolean;
    isLocked: boolean;
    opacity?: number;
    onSelect: (e: KonvaEventObject<MouseEvent | TouchEvent>) => void;
    onTransform: (e: KonvaEventObject<Event>) => void;
    onTransformEnd: (e: KonvaEventObject<Event>) => void;
}) {
    const [img, setImg] = useState<HTMLImageElement | null>(null);
    const imageRef = useRef<Konva.Image>(null);

    // Pick variant based on the layer's display width (scaled)
    const variantUrl = useMemo(() => {
        if (layer.type !== 'image') return layer.url;
        if (!layer.url.startsWith('/api/assets/')) return layer.url;
        const displayWidth = Math.ceil(layer.config.width * (layer.config.scaleX ?? 1));
        return selectAssetVariantSrc({
            src: layer.url,
            targetWidth: displayWidth
        });
    }, [layer.url, layer.config.width, layer.config.scaleX, layer.type]);

    useEffect(() => {
        if (layer.type !== 'image')
            return () => {
                setImg(null);
            };
        const i = new window.Image();
        if (!variantUrl.startsWith('blob:') && !variantUrl.startsWith('data:')) {
            i.crossOrigin = 'anonymous';
        }
        i.onload = () => {
            setImg(i);
            imageRef.current?.getLayer()?.batchDraw();
        };
        i.src = variantUrl;
    }, [variantUrl, layer.type]);

    useEffect(() => {
        applyKonvaFilters(imageRef.current, layer.config.filters);
    }, [layer.config.filters, img, layer.config.width, layer.config.height]);

    return (
        <Image
            id={layer.numericId.toString()}
            ref={imageRef}
            image={img || undefined}
            x={layer.config.cx}
            y={layer.config.cy}
            width={layer.config.width}
            height={layer.config.height}
            scaleX={layer.config.scaleX}
            scaleY={layer.config.scaleY}
            offsetX={layer.config.width / 2}
            offsetY={layer.config.height / 2}
            rotation={layer.config.rotation}
            opacity={opacity}
            listening={!isDrawing}
            draggable={!isDrawing && !isPinching && !isLocked}
            onClick={onSelect}
            onTap={onSelect}
            onDragMove={onTransform}
            onTransform={onTransform}
            onDragEnd={onTransformEnd}
            onTransformEnd={onTransformEnd}
        />
    );
}

export function KonvaStaticImage(props: Parameters<typeof LegacyKonvaStaticImage>[0]) {
    return props.layer.deepZoom || props.layer.isUploading ? (
        <KonvaTiledImage {...props} />
    ) : (
        <LegacyKonvaStaticImage {...props} />
    );
}

export function KonvaTiledImage({
    layer,
    previewScale = 1,
    followConfig = false,
    isDrawing = false,
    isPinching = false,
    isLocked = false,
    listening = true,
    opacity = 1,
    onSelect,
    onTransform,
    onTransformEnd
}: {
    layer: Extract<LayerWithEditorState, { type: 'image' }>;
    previewScale?: number;
    followConfig?: boolean;
    isDrawing?: boolean;
    isPinching?: boolean;
    isLocked?: boolean;
    listening?: boolean;
    opacity?: number;
    onSelect?: (event: KonvaEventObject<MouseEvent | TouchEvent>) => void;
    onTransform?: (event: KonvaEventObject<Event>) => void;
    onTransformEnd?: (event: KonvaEventObject<Event>) => void;
}) {
    const nodeRef = useRef<Konva.Shape>(null);
    const controllerRef = useRef<ImageTileController | null>(null);
    const previewRef = useRef<HTMLImageElement | null>(null);
    const previewUrl = layer.isUploading ? layer.url : '';
    useEffect(() => {
        if (!previewUrl) return;
        const preview = new window.Image();
        if (!previewUrl.startsWith('blob:')) preview.crossOrigin = 'anonymous';
        preview.onload = () => {
            previewRef.current = preview;
            nodeRef.current?.getLayer()?.batchDraw();
        };
        preview.src = previewUrl;
        return () => {
            preview.onload = null;
        };
    }, [previewUrl]);
    const currentRef = useRef({ layer, previewScale });
    useEffect(() => {
        currentRef.current = { layer, previewScale };
    }, [layer, previewScale]);
    const sourceKey = JSON.stringify(layer.deepZoom);
    useEffect(() => {
        const node = nodeRef.current;
        if (!node || !sourceKey) return;
        const image = JSON.parse(sourceKey) as ImageDeepZoomLayer;
        const controller = new ImageTileController(
            image,
            document.createElement('canvas'),
            (frame) => {
                node.setAttr('imageTilesReady', Boolean(frame?.ready));
                node.setAttr(
                    'imageTileCanvasSize',
                    frame ? [frame.canvas.width, frame.canvas.height] : [0, 0]
                );
                node.getLayer()?.batchDraw();
            }
        );
        controllerRef.current = controller;
        let geometryKey = '';
        const readView = (): ImageTileView | null => {
            // The editor's binary path mutates the shared layer config without
            // rendering React. Its minimap has separate Konva nodes to update.
            if (followConfig) {
                const { layer: current, previewScale: scale } = currentRef.current;
                const config = current.config;
                const geometry = {
                    x: config.cx * scale,
                    y: config.cy * scale,
                    width: config.width * scale,
                    height: config.height * scale,
                    offsetX: (config.width * scale) / 2,
                    offsetY: (config.height * scale) / 2,
                    scaleX: config.scaleX,
                    scaleY: config.scaleY,
                    rotation: config.rotation
                };
                const key = JSON.stringify(geometry);
                if (key !== geometryKey) {
                    geometryKey = key;
                    node.setAttrs(geometry);
                    node.getLayer()?.batchDraw();
                }
            }
            const stage = node.getStage();
            if (!stage || !node.isVisible() || !stage.width() || !stage.height()) return null;
            const content =
                stage.container().querySelector('.konvajs-content') ?? stage.container();
            const rect = content.getBoundingClientRect();
            const sx = rect.width / stage.width(),
                sy = rect.height / stage.height();
            const [a, b, c, d, e, f] = node.getAbsoluteTransform().getMatrix();
            const rx = node.width() / image.width,
                ry = node.height() / image.height;
            return {
                matrix: [
                    a * rx * sx,
                    b * rx * sy,
                    c * ry * sx,
                    d * ry * sy,
                    rect.left + e * sx,
                    rect.top + f * sy
                ],
                viewport: clippedViewport(content),
                pixelRatio: window.devicePixelRatio || 1
            };
        };
        const update = () => controller.update(readView());
        // Draw-time refresh avoids a stale crop for a binary update/drag arriving
        // after the shared frame observer, without asking React to rerender.
        const canvasLayer = node.getLayer();
        canvasLayer?.on('beforeDraw', update);
        const stop = observeImageTileView(readView, (view) => controller.update(view));
        update();
        return () => {
            stop();
            canvasLayer?.off('beforeDraw', update);
            controllerRef.current = null;
            controller.dispose();
        };
    }, [sourceKey, followConfig]);

    return (
        <Shape
            ref={nodeRef}
            id={String(layer.numericId)}
            name={layer.deepZoom ? 'deep-zoom-image' : 'uploading-image'}
            x={layer.config.cx * previewScale}
            y={layer.config.cy * previewScale}
            width={layer.config.width * previewScale}
            height={layer.config.height * previewScale}
            offsetX={(layer.config.width * previewScale) / 2}
            offsetY={(layer.config.height * previewScale) / 2}
            scaleX={layer.config.scaleX}
            scaleY={layer.config.scaleY}
            rotation={layer.config.rotation}
            opacity={opacity}
            listening={listening && !isDrawing}
            draggable={listening && !isDrawing && !isPinching && !isLocked}
            fill="transparent"
            perfectDrawEnabled={false}
            onClick={onSelect}
            onTap={onSelect}
            onDragMove={onTransform}
            onTransform={onTransform}
            onDragEnd={onTransformEnd}
            onTransformEnd={onTransformEnd}
            sceneFunc={(context, node) => {
                const controller = controllerRef.current;
                const frame = controller?.frame;
                if (!controller || !frame || (!frame.ready && previewRef.current)) {
                    context.save();
                    context._context.filter = toCssFilterString(layer.config.filters);
                    if (previewRef.current)
                        context.drawImage(previewRef.current, 0, 0, node.width(), node.height());
                    else if (layer.isUploading) {
                        context.setAttr('fillStyle', '#d1d5db');
                        context.fillRect(0, 0, node.width(), node.height());
                    }
                    context.restore();
                    return;
                }
                const rx = node.width() / controller.source.width,
                    ry = node.height() / controller.source.height;
                context.save();
                context.beginPath();
                context.rect(0, 0, node.width(), node.height());
                context.clip();
                // Native canvas filters operate on the bounded mosaic; caching the
                // entire logical image via node.cache() can allocate enormous canvases.
                context._context.filter = toCssFilterString(layer.config.filters);
                context.drawImage(
                    frame.canvas,
                    frame.x * rx,
                    frame.y * ry,
                    frame.width * rx,
                    frame.height * ry
                );
                context.restore();
            }}
            hitFunc={(context, node) => {
                context.beginPath();
                context.rect(0, 0, node.width(), node.height());
                context.closePath();
                context.fillStrokeShape(node);
            }}
        />
    );
}
