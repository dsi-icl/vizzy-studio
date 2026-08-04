import Konva from 'konva';
import { memo, useMemo } from 'react';
import { Shape } from 'react-konva';

import { getLinePaths, type LayerWithEditorState } from '~/lib/types';

type LineLayer = Extract<LayerWithEditorState, { type: 'line' }>;

type KonvaLineSegmentsProps = {
    layer: LineLayer;
    opacity?: number;
    strokeWidth?: number;
    listening?: boolean;
    shadowForStrokeEnabled?: boolean;
};

type DrawablePath = {
    points: number[];
    tensionPoints: number[];
};

const LINE_TENSION = 0.4;
const tensionLine = new Konva.Line({ tension: LINE_TENSION });

function preparePath(points: number[]): DrawablePath {
    if (points.length <= 4) return { points, tensionPoints: [] };

    tensionLine.points(points);
    return { points, tensionPoints: [...tensionLine.getTensionPoints()] };
}

export const KonvaLineSegments = memo(function KonvaLineSegments({
    layer,
    opacity,
    strokeWidth = layer.strokeWidth,
    listening = false,
    shadowForStrokeEnabled = false
}: KonvaLineSegmentsProps) {
    const paths = useMemo(
        () =>
            getLinePaths(layer)
                .filter((path) => path.length >= 4)
                .map(preparePath),
        [layer]
    );

    return (
        <Shape
            listening={listening}
            opacity={opacity}
            sceneFunc={(context, shape) => {
                context.beginPath();

                for (const { points, tensionPoints } of paths) {
                    context.moveTo(points[0], points[1]);

                    if (tensionPoints.length === 0) {
                        for (let i = 2; i < points.length; i += 2) {
                            context.lineTo(points[i], points[i + 1]);
                        }
                        continue;
                    }

                    context.quadraticCurveTo(
                        tensionPoints[0],
                        tensionPoints[1],
                        tensionPoints[2],
                        tensionPoints[3]
                    );

                    let i = 4;
                    while (i < tensionPoints.length - 2) {
                        context.bezierCurveTo(
                            tensionPoints[i++],
                            tensionPoints[i++],
                            tensionPoints[i++],
                            tensionPoints[i++],
                            tensionPoints[i++],
                            tensionPoints[i++]
                        );
                    }

                    context.quadraticCurveTo(
                        tensionPoints[tensionPoints.length - 2],
                        tensionPoints[tensionPoints.length - 1],
                        points[points.length - 2],
                        points[points.length - 1]
                    );
                }

                context.strokeShape(shape);
            }}
            stroke={layer.strokeColor}
            strokeWidth={strokeWidth}
            dash={layer.strokeDash}
            dashEnabled={true}
            shadowForStrokeEnabled={shadowForStrokeEnabled}
            shadowColor="#00a1ff"
            shadowBlur={10}
            shadowOffsetY={20}
            shadowOffsetX={20}
            shadowOpacity={1}
            lineCap="round"
            lineJoin="round"
        />
    );
});
