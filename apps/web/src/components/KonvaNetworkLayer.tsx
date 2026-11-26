import type { KonvaEventObject } from 'konva/lib/Node';
import type { Shape as KonvaShape } from 'konva/lib/Shape';
import { useEffect, useMemo, useRef } from 'react';
import { Shape } from 'react-konva';

import { useTextFontRevision } from '~/hooks/useFonts';
import { useEditorStore } from '~/lib/editorStore';
import { toCssFilterString } from '~/lib/layerFilters';
import { initialNetworkPositions, networkDocumentKey } from '~/lib/network/document';
import type { NetworkFrameBuffer } from '~/lib/network/frames';
import {
    clampNetworkNodePosition,
    hitTestNetwork,
    networkPointerPosition,
    networkPreviewView
} from '~/lib/network/interaction';
import { drawNetwork, type NetworkSelection } from '~/lib/network/render';
import { useNetworkLayerAnimation } from '~/lib/network/useNetworkLayerAnimation';
import type { LayerWithEditorState } from '~/lib/types';

export function KonvaNetworkLayer({
    layer,
    frames,
    isDrawing = true,
    isPinching = false,
    isLocked = false,
    opacity = 1,
    onSelect,
    onTransform,
    onTransformEnd
}: {
    layer: Extract<LayerWithEditorState, { type: 'graph' }>;
    frames?: NetworkFrameBuffer;
    isDrawing?: boolean;
    isPinching?: boolean;
    isLocked?: boolean;
    opacity?: number;
    onSelect?: (event: KonvaEventObject<MouseEvent | TouchEvent>) => void;
    onTransform?: (event: KonvaEventObject<Event>) => void;
    onTransformEnd?: (event: KonvaEventObject<Event>) => void;
}) {
    const { config } = layer;
    const shapeRef = useRef<KonvaShape>(null);
    const nodeDrag = useRef<{
        nodeId: string;
        startX: number;
        startY: number;
        point: { x: number; y: number } | null;
        active: boolean;
    } | null>(null);
    const suppressNextClick = useRef(false);
    const fontRevision = useTextFontRevision();
    useEffect(() => {
        shapeRef.current?.getLayer()?.batchDraw();
    }, [fontRevision]);
    const animation = useNetworkLayerAnimation(layer.network, layer.numericId, frames, () =>
        shapeRef.current?.getLayer()?.batchDraw()
    );
    const documentKey = useMemo(
        () => (layer.network ? networkDocumentKey(layer.network) : ''),
        [layer.network]
    );
    const canDragNode = !isDrawing && !isPinching && !isLocked && !config.locked && !!layer.network;
    const currentView = () => {
        const network = layer.network;
        if (!network) return undefined;
        const live = animation.current;
        const fallback = network.positions ?? initialNetworkPositions(network.data);
        const view = networkPreviewView(
            network.data,
            live ?? { data: network.data, positions: fallback }
        );
        const positions = view.positions.slice();
        const move = network.nodeMove;
        if (move && live?.documentKey !== documentKey) {
            const index = view.data.nodes.findIndex((node) => node.id === move.nodeId);
            if (index !== -1) positions[index] = { x: move.x, y: move.y };
        }
        const drag = nodeDrag.current;
        if (drag?.active && drag.point) {
            const index = view.data.nodes.findIndex((node) => node.id === drag.nodeId);
            if (index !== -1) positions[index] = drag.point;
        }
        return { data: view.data, positions };
    };
    const pointerPoint = () => {
        const shape = shapeRef.current;
        const pointer = shape?.getRelativePointerPosition();
        return pointer && shape
            ? networkPointerPosition(pointer.x, pointer.y, {
                  x: 0,
                  y: 0,
                  w: shape.width(),
                  h: shape.height()
              })
            : null;
    };
    const finishNodeDrag = (event: KonvaEventObject<MouseEvent>) => {
        const drag = nodeDrag.current;
        if (!drag) return;
        nodeDrag.current = null;
        shapeRef.current?.draggable(!isDrawing && !isPinching && !isLocked && !config.locked);
        shapeRef.current?.getLayer()?.batchDraw();
        event.cancelBubble = true;
        if (!drag.active || !drag.point) return;
        suppressNextClick.current = true;
        requestAnimationFrame(() => {
            suppressNextClick.current = false;
        });
        const store = useEditorStore.getState();
        if (!store.selectedLayerIds.includes(String(layer.numericId)))
            store.toggleLayerSelection(String(layer.numericId), false, false);
        const current = store.layers.get(layer.numericId);
        if (current?.type !== 'graph' || current.config.locked || !current.network) return;
        store.updateNetworkLayer(layer.numericId, {
            ...current.network,
            nodeMove: {
                nodeId: drag.nodeId,
                ...drag.point,
                revision: (current.network.nodeMove?.revision ?? 0) + 1
            }
        });
    };
    return (
        <Shape
            ref={shapeRef}
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
            draggable={!isDrawing && !isPinching && !isLocked && !config.locked}
            onMouseDown={(event) => {
                if (!canDragNode || event.evt.button !== 0) return;
                const point = pointerPoint();
                const view = currentView();
                if (!point || !view || !layer.network) return;
                const target: NetworkSelection = hitTestNetwork(
                    view,
                    layer.network.settings,
                    point,
                    layer.network
                );
                if (!target || !('nodeId' in target)) return;
                nodeDrag.current = {
                    nodeId: target.nodeId,
                    startX: event.evt.clientX,
                    startY: event.evt.clientY,
                    point: null,
                    active: false
                };
                shapeRef.current?.stopDrag();
                shapeRef.current?.draggable(false);
                event.cancelBubble = true;
            }}
            onMouseMove={(event) => {
                const drag = nodeDrag.current;
                if (!drag || !layer.network) return;
                if (
                    !drag.active &&
                    Math.hypot(event.evt.clientX - drag.startX, event.evt.clientY - drag.startY) >=
                        6
                )
                    drag.active = true;
                if (drag.active) {
                    const point = pointerPoint();
                    if (point)
                        drag.point = clampNetworkNodePosition(
                            point,
                            layer.network.settings.nodeRadius
                        );
                    shapeRef.current?.getLayer()?.batchDraw();
                }
                event.cancelBubble = true;
            }}
            onMouseUp={finishNodeDrag}
            onMouseLeave={finishNodeDrag}
            onClick={(event) => {
                if (suppressNextClick.current) {
                    suppressNextClick.current = false;
                    return;
                }
                onSelect?.(event);
            }}
            onTap={onSelect}
            onDragMove={onTransform}
            onTransform={onTransform}
            onDragEnd={onTransformEnd}
            onTransformEnd={onTransformEnd}
            sceneFunc={(ctx, shape) => {
                ctx._context.save();
                ctx._context.filter = toCssFilterString(layer.config.filters);
                drawNetwork(
                    ctx._context,
                    layer.network,
                    shape.width(),
                    shape.height(),
                    undefined,
                    currentView()
                );
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
