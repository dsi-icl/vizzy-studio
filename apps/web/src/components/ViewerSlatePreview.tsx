import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useState, RefObject, useEffect } from 'react';
import { Circle, KonvaNodeEvents, Layer, Rect, Stage, Line } from 'react-konva';

import { KonvaBackgroundLayer } from '~/components/KonvaBackgroundLayer';
import { PreviewMediaLayer, PreviewTextLayer } from '~/components/PreviewLayers';
import { getDOGridLines } from '~/lib/editorHelpers';
import type { LayerWithEditorState } from '~/lib/types';

type SlatePreviewProps = {
    stageSlot: RefObject<HTMLDivElement | null>;
    stageInstance: RefObject<Konva.Stage | null>;
    stageScaleFactor: number;
    layers: LayerWithEditorState[];
};

const PREVIEW_SCALE = 0.15;

export function ViewerSlatePreview({
    stageSlot,
    stageInstance,
    stageScaleFactor,
    layers
}: SlatePreviewProps) {
    const [scrollLeft, setScrollLeft] = useState(0);
    const [showGrid] = useState(true);

    const stageWidth = stageInstance.current?.width() || 0;
    const stageHeight = stageInstance.current?.height() || 0;

    useEffect(() => {
        if (!stageSlot.current) return;
        const currentStageSlot = stageSlot.current;
        const onScroll = () => {
            if (!stageSlot.current) return;
            setScrollLeft(stageSlot.current.scrollLeft);
        };
        stageSlot.current.addEventListener('scroll', onScroll);
        return () => {
            currentStageSlot?.removeEventListener('scroll', onScroll);
        };
    }, [stageSlot]);

    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0;
    const canvasWidth = stageSlot.current?.clientWidth || viewportWidth;
    const canvasHeight = stageSlot.current?.clientHeight || viewportHeight;
    const safeStageScaleFactor = Math.max(stageScaleFactor, 1e-6);
    const previewScale = safeStageScaleFactor * PREVIEW_SCALE;
    const logicalStageWidth = stageWidth / safeStageScaleFactor;
    const logicalStageHeight = stageHeight / safeStageScaleFactor;
    const logicalCanvasWidth = canvasWidth / safeStageScaleFactor;
    const logicalCanvasHeight = canvasHeight / safeStageScaleFactor;

    const handleHorizontalDragMove: KonvaNodeEvents['onDragMove'] = (e) => {
        const x = e.target.x();
        if (x < 0) e.target.x(0);
        if (x > logicalStageWidth - e.target.width())
            e.target.x(logicalStageWidth - e.target.width());
        const slot = stageSlot.current;
        if (slot) {
            // oxlint-disable-next-line react-hooks-js/immutability
            slot.scrollLeft = x * safeStageScaleFactor;
        }
        e.target.y(0);
    };

    const handlePreviewWheel = (e: KonvaEventObject<WheelEvent>) => {
        e.evt.preventDefault();
        const slot = stageSlot.current;
        if (!slot) return;
        slot.scrollLeft += e.evt.deltaX + e.evt.deltaY;
    };

    return (
        <div className="lineheig m-0 line-clamp-1 block overscroll-none p-0 text-center">
            <Stage
                width={logicalStageWidth * previewScale}
                height={logicalStageHeight * previewScale}
                scaleX={previewScale}
                scaleY={previewScale}
                onWheel={handlePreviewWheel}
                onClick={(e) => {
                    let x =
                        (e.target.getStage()?.getPointerPosition()?.x ?? 0) / previewScale -
                        logicalCanvasWidth / 2;
                    if (x < 0) x = 0;
                    if (x > logicalStageWidth - logicalCanvasWidth)
                        x = logicalStageWidth - logicalCanvasWidth;
                    setScrollLeft(x * safeStageScaleFactor);
                    const slot = stageSlot.current;
                    if (slot) {
                        // oxlint-disable-next-line react-hooks-js/immutability
                        slot.scrollLeft = x * safeStageScaleFactor;
                    }
                }}
                className="m-auto block w-fit cursor-pointer bg-[#222]"
            >
                <Layer>
                    {[...layers]
                        .sort((a, b) => a.config.zIndex - b.config.zIndex)
                        .filter((shape) => shape.config.visible)
                        .map((shape) => {
                            if (shape.type === 'line')
                                return (
                                    <Line
                                        key={`lin_${shape.numericId}`}
                                        points={shape.line}
                                        stroke={shape.strokeColor}
                                        strokeWidth={shape.strokeWidth * 2}
                                        dash={shape.strokeDash}
                                        dashEnabled={true}
                                        tension={0.4}
                                        lineCap="round"
                                        lineJoin="round"
                                    />
                                );
                            if (shape.type === 'shape') {
                                if (shape.shape === 'circle')
                                    return (
                                        <Circle
                                            key={shape.numericId}
                                            x={shape.config.cx}
                                            y={shape.config.cy}
                                            offsetX={shape.config.width / 2}
                                            offsetY={shape.config.height / 2}
                                            radius={shape.config.width / 2}
                                            fill="transparent"
                                            stroke={shape.strokeColor}
                                            strokeWidth={shape.strokeWidth * 2}
                                            dash={shape.strokeDash}
                                            lineCap="round"
                                            lineJoin="round"
                                            listening={false}
                                        />
                                    );
                                if (shape.shape === 'rectangle')
                                    return (
                                        <Rect
                                            key={shape.numericId}
                                            x={shape.config.cx}
                                            y={shape.config.cy}
                                            width={shape.config.width}
                                            height={shape.config.height}
                                            offsetX={shape.config.width / 2}
                                            offsetY={shape.config.height / 2}
                                            rotation={shape.config.rotation}
                                            fill="transparent"
                                            stroke={shape.strokeColor}
                                            strokeWidth={shape.strokeWidth * 2}
                                            dash={shape.strokeDash}
                                            dashOffset={(shape.strokeDash[0] ?? 0) / 2}
                                            lineCap="round"
                                            lineJoin="round"
                                            listening={false}
                                        />
                                    );
                            }
                            if (shape.type === 'background') {
                                return (
                                    <KonvaBackgroundLayer
                                        key={`bg_${shape.numericId}`}
                                        layer={shape}
                                        previewScale={1}
                                    />
                                );
                            }
                            if (
                                shape.type === 'image' ||
                                shape.type === 'video' ||
                                shape.type === 'web'
                            ) {
                                return (
                                    <PreviewMediaLayer
                                        key={shape.numericId}
                                        shape={shape}
                                        stageScaleFactor={1}
                                    />
                                );
                            }
                            if (shape.type === 'text') {
                                return (
                                    <PreviewTextLayer
                                        key={shape.numericId}
                                        shape={shape}
                                        stageScaleFactor={1}
                                    />
                                );
                            }
                            return (
                                <Rect
                                    key={shape.numericId}
                                    x={shape.config.cx}
                                    y={shape.config.cy}
                                    width={shape.config.width}
                                    height={shape.config.height}
                                    offsetX={shape.config.width / 2}
                                    offsetY={shape.config.height / 2}
                                    rotation={shape.config.rotation}
                                    fill="#555"
                                    listening={false}
                                />
                            );
                        })}
                    <Rect
                        x={scrollLeft / safeStageScaleFactor}
                        y={0}
                        width={logicalCanvasWidth}
                        height={logicalCanvasHeight}
                        fill="rgba(255, 255, 255, 0.2)"
                        draggable
                        onDragMove={handleHorizontalDragMove}
                    />
                    {showGrid && getDOGridLines(logicalStageWidth, logicalStageHeight)}
                </Layer>
            </Stage>
        </div>
    );
}
