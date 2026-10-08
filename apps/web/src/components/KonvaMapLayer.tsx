import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useLayoutEffect, useRef } from 'react';
import { Image } from 'react-konva';

import { subscribeMapCanvasFrame, useMapCanvasStore } from '~/lib/mapPreviewStore';
import type { LayerWithEditorState } from '~/lib/types';

export function KonvaMapLayer({
    layer,
    previewKey,
    selected,
    isDrawing,
    isPinching,
    isLocked,
    opacity,
    onSelect,
    onTransform,
    onTransformEnd
}: {
    layer: Extract<LayerWithEditorState, { type: 'map' }>;
    previewKey: string;
    selected: boolean;
    isDrawing: boolean;
    isPinching: boolean;
    isLocked: boolean;
    opacity: number;
    onSelect: (event: KonvaEventObject<MouseEvent | TouchEvent>) => void;
    onTransform: (event: KonvaEventObject<Event>) => void;
    onTransformEnd: (event: KonvaEventObject<Event>) => void;
}) {
    const frame = useMapCanvasStore((state) => state[previewKey]);
    const imageRef = useRef<Konva.Image>(null);

    useLayoutEffect(() => {
        // Attach the canvas when its first frame arrives.
        imageRef.current?.getLayer()?.batchDraw();
    }, [frame]);

    useLayoutEffect(
        () =>
            subscribeMapCanvasFrame(previewKey, () => {
                imageRef.current?.getLayer()?.batchDraw();
            }),
        [previewKey]
    );

    return (
        <Image
            ref={imageRef}
            id={layer.numericId.toString()}
            image={frame?.canvas}
            fill="#f4f1ea"
            stroke={selected ? 'rgba(0, 161, 255, 0.9)' : 'rgba(255, 255, 255, 0.22)'}
            strokeWidth={2}
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
