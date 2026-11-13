import { memo, type ComponentProps } from 'react';
import { Group, Line } from 'react-konva';

import { getLinePaths, type LayerWithEditorState } from '~/lib/types';

type LineLayer = Extract<LayerWithEditorState, { type: 'line' }>;

type KonvaLineSegmentsProps = Omit<
    ComponentProps<typeof Line>,
    'points' | 'stroke' | 'strokeWidth' | 'dash'
> & {
    layer: LineLayer;
    strokeWidth?: number;
};

export const KonvaLineSegments = memo(function KonvaLineSegments({
    id,
    layer,
    strokeWidth = layer.strokeWidth,
    ...lineProps
}: KonvaLineSegmentsProps) {
    // A layer has one id, even when erasing splits it into several paths.
    // Selecting the group lets outlines cover all of the remaining segments.
    return (
        <Group id={id}>
            {getLinePaths(layer).map((points, pathIndex) => (
                <Line
                    {...lineProps}
                    key={`line-path-${pathIndex}`}
                    points={points}
                    stroke={layer.strokeColor}
                    strokeWidth={strokeWidth}
                    dash={layer.strokeDash}
                    dashEnabled={true}
                    tension={0.4}
                    lineCap="round"
                    lineJoin="round"
                />
            ))}
        </Group>
    );
});
