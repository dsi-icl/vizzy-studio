import type { KonvaEventObject } from 'konva/lib/Node';
import { Shape } from 'react-konva';

import { toCssFilterString } from '~/lib/layerFilters';
import { drawNetwork } from '~/lib/network/render';
import type { LayerWithEditorState } from '~/lib/types';

export function KonvaNetworkLayer({
    layer,
    isDrawing = true,
    isPinching = false,
    isLocked = false,
    opacity = 1,
    onSelect,
    onTransform,
    onTransformEnd
}: {
    layer: Extract<LayerWithEditorState, { type: 'graph' }>;
    isDrawing?: boolean;
    isPinching?: boolean;
    isLocked?: boolean;
    opacity?: number;
    onSelect?: (event: KonvaEventObject<MouseEvent | TouchEvent>) => void;
    onTransform?: (event: KonvaEventObject<Event>) => void;
    onTransformEnd?: (event: KonvaEventObject<Event>) => void;
}) {
    const { config } = layer;
    return (
        <Shape
            id={String(layer.numericId)}
            x={config.cx}
            y={config.cy}
            width={config.width}
            height={config.height}
            offsetX={config.width / 2}
            offsetY={config.height / 2}
            scaleX={config.scaleX}
            scaleY={config.scaleY}
            rotation={config.rotation}
            opacity={opacity}
            listening={!isDrawing}
            draggable={!isDrawing && !isPinching && !isLocked}
            onClick={onSelect}
            onTap={onSelect}
            onDragMove={onTransform}
            onTransform={onTransform}
            onDragEnd={onTransformEnd}
            onTransformEnd={onTransformEnd}
            sceneFunc={(ctx, shape) => {
                ctx._context.save();
                ctx._context.filter = toCssFilterString(layer.config.filters);
                drawNetwork(ctx._context, layer.network, shape.width(), shape.height());
                ctx._context.restore();
            }}
            hitFunc={(ctx, shape) => {
                ctx.beginPath();
                ctx.rect(0, 0, shape.width(), shape.height());
                ctx.closePath();
                ctx.fillStrokeShape(shape);
            }}
            fill="transparent"
        />
    );
}
