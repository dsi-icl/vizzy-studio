'use client';

import { selectAssetVariantSrc } from '@repo/ui/lib/assetVariants';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Rect } from 'react-konva';

import { applyKonvaFilters } from '~/lib/konvaFilters';
import type { LayerWithEditorState } from '~/lib/types';

export function KonvaWebLayer({
    layer,
    isDrawing,
    isPinching,
    isLocked,
    opacity,
    onSelect,
    onTransform,
    onTransformEnd
}: {
    layer: Extract<LayerWithEditorState, { type: 'web' }>;
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
    const rectRef = useRef<Konva.Rect>(null);

    const variantUrl = useMemo(() => {
        if (!layer.stillImage) return null;
        const displayWidth = Math.ceil(layer.config.width * (layer.config.scaleX ?? 1));
        return selectAssetVariantSrc({
            src: layer.stillImage,
            sizes: layer.stillImageSizes,
            targetWidth: displayWidth
        });
    }, [layer.stillImage, layer.stillImageSizes, layer.config.width, layer.config.scaleX]);

    useEffect(() => {
        if (!variantUrl) {
            setImg(null);
            return;
        }
        const i = new window.Image();
        i.crossOrigin = 'anonymous';
        i.onload = () => {
            setImg(i);
            imageRef.current?.getLayer()?.batchDraw();
        };
        i.src = variantUrl;
    }, [variantUrl]);

    useEffect(() => {
        applyKonvaFilters(img ? imageRef.current : rectRef.current, layer.config.filters);
    }, [img, layer.config.filters, layer.config.width, layer.config.height]);

    const commonProps = {
        id: layer.numericId.toString(),
        x: layer.config.cx,
        y: layer.config.cy,
        width: layer.config.width,
        height: layer.config.height,
        scaleX: layer.config.scaleX,
        scaleY: layer.config.scaleY,
        offsetX: layer.config.width / 2,
        offsetY: layer.config.height / 2,
        rotation: layer.config.rotation,
        opacity,
        listening: !isDrawing,
        draggable: !isDrawing && !isPinching && !isLocked,
        onClick: onSelect,
        onTap: onSelect,
        onDragMove: onTransform,
        onTransform,
        onDragEnd: onTransformEnd,
        onTransformEnd
    };

    // Render stillImage if available, otherwise a placeholder rect
    if (img) {
        return <Image ref={imageRef} image={img} {...commonProps} />;
    }

    return <Rect ref={rectRef} {...commonProps} fill="#334" stroke="#556" strokeWidth={2} />;
}
