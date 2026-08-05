import { memo } from 'react';
import { Line } from 'react-konva';

import { getLinePaths, type LayerWithEditorState } from '~/lib/types';

type LineLayer = Extract<LayerWithEditorState, { type: 'line' }>;

type KonvaLineSegmentsProps = {
    layer: LineLayer;
    opacity?: number;
    strokeWidth?: number;
    listening?: boolean;
    shadowForStrokeEnabled?: boolean;
};

const LINE_TENSION = 0.4;

export const KonvaLineSegments = memo(function KonvaLineSegments({
    layer,
    opacity,
    strokeWidth = layer.strokeWidth,
    listening = false,
    shadowForStrokeEnabled = false
}: KonvaLineSegmentsProps) {
    return (
        <>
            {getLinePaths(layer)
                .filter((path) => path.length >= 4)
                .map((path, pathIndex) => (
                    <Line
                        key={`line-path-${pathIndex}`}
                        points={path}
                        listening={listening}
                        opacity={opacity}
                        stroke={layer.strokeColor}
                        strokeWidth={strokeWidth}
                        dash={layer.strokeDash}
                        dashEnabled={true}
                        tension={LINE_TENSION}
                        shadowForStrokeEnabled={shadowForStrokeEnabled}
                        shadowColor="#00a1ff"
                        shadowBlur={10}
                        shadowOffsetY={20}
                        shadowOffsetX={20}
                        shadowOpacity={1}
                        lineCap="round"
                        lineJoin="round"
                    />
                ))}
        </>
    );
});
