'use client';

import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useEffect, useRef, useState } from 'react';
import { Image } from 'react-konva';

import { applyKonvaFilters } from '~/lib/konvaFilters';
import { textHtmlToImage } from '~/lib/textToCanvas';
import type { LayerWithEditorState } from '~/lib/types';

export function KonvaTextLayer({
    layer,
    isDrawing,
    isPinching,
    opacity,
    onSelect,
    onDblClick,
    onTransform,
    onTransformEnd
}: {
    layer: Extract<LayerWithEditorState, { type: 'text' }>;
    isDrawing: boolean;
    isPinching: boolean;
    opacity?: number;
    onSelect: (e: KonvaEventObject<MouseEvent | TouchEvent>) => void;
    onDblClick: () => void;
    onTransform: (e: KonvaEventObject<Event>) => void;
    onTransformEnd: (e: KonvaEventObject<Event>) => void;
}) {
    const [img, setImg] = useState<HTMLImageElement | null>(null);
    const imageRef = useRef<Konva.Image>(null);
    const renderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        // Debounce re-renders while typing
        if (renderTimer.current) clearTimeout(renderTimer.current);
        renderTimer.current = setTimeout(() => {
            textHtmlToImage(layer.textHtml ?? '', layer.config.width, layer.config.height)
                .then(async (rendered) => {
                    const image = await rendered;
                    if (!image) return;
                    setImg(image);
                    imageRef.current?.getLayer()?.batchDraw();
                })
                .catch(() => setImg(null));
        }, 100);

        return () => {
            if (renderTimer.current) clearTimeout(renderTimer.current);
        };
    }, [layer.textHtml, layer.config.width, layer.config.height]);

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
            draggable={!isDrawing && !isPinching}
            onClick={onSelect}
            onTap={onSelect}
            onDblClick={onDblClick}
            onDblTap={onDblClick}
            onDragMove={onTransform}
            onTransform={onTransform}
            onDragEnd={onTransformEnd}
            onTransformEnd={onTransformEnd}
        />
    );
}
