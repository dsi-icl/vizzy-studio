'use client';

import { selectAssetVariantSrc } from '@repo/ui/lib/assetVariants';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image } from 'react-konva';

import { applyKonvaFilters } from '~/lib/konvaFilters';
import type { LayerWithEditorState } from '~/lib/types';

export function KonvaStaticImage({
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
