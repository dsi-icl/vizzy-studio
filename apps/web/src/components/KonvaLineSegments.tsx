import { Line } from 'react-konva';

import type { LayerWithEditorState } from '~/lib/types';

type LineLayer = Extract<LayerWithEditorState, { type: 'line' }>;

type KonvaLineSegmentsProps = {
    layer: LineLayer;
    opacity?: number;
    strokeWidth?: number;
    listening?: boolean;
    shadowForStrokeEnabled?: boolean;
};

export function KonvaLineSegments({
    layer,
    opacity,
    strokeWidth = layer.strokeWidth,
    listening = false,
    shadowForStrokeEnabled = false
}: KonvaLineSegmentsProps) {
    const segments = layer.segments ?? [layer.line];

    return segments
        .filter((segment) => segment.length >= 4)
        .map((segment, segmentIndex) => (
            <Line
                key={`lin_${layer.numericId}_${segmentIndex}`}
                listening={listening}
                opacity={opacity}
                points={segment}
                stroke={layer.strokeColor}
                strokeWidth={strokeWidth}
                dash={layer.strokeDash}
                dashEnabled={true}
                tension={0.4}
                shadowForStrokeEnabled={shadowForStrokeEnabled}
                shadowColor="#00a1ff"
                shadowBlur={10}
                shadowOffsetY={20}
                shadowOffsetX={20}
                shadowOpacity={1}
                lineCap="round"
                lineJoin="round"
            />
        ));
}
