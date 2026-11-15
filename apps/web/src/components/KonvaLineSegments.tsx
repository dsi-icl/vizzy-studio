import { memo, type ComponentProps } from 'react';
import { Group, Line } from 'react-konva';

import { EffectLine } from '~/components/AnimatedKonvaShape';
import { getLinePaths, type LayerWithEditorState } from '~/lib/types';

type LineLayer = Extract<LayerWithEditorState, { type: 'line' }>;

type KonvaLineSegmentsProps = Omit<
    ComponentProps<typeof Line>,
    'points' | 'stroke' | 'strokeWidth' | 'dash'
> & {
    layer: LineLayer;
    strokeWidth?: number;
    getTimeMs?: () => number;
};

export const KonvaLineSegments = memo(function KonvaLineSegments({
    id,
    layer,
    strokeWidth = layer.strokeWidth,
    getTimeMs,
    ...lineProps
}: KonvaLineSegmentsProps) {
    // A layer has one id, even when erasing splits it into several paths.
    // Selecting the group lets outlines cover all of the remaining segments.
    return (
        <Group id={id}>
            {getLinePaths(layer).map((points, pathIndex) => {
                const props = {
                    ...lineProps,
                    points,
                    stroke: layer.strokeColor,
                    strokeWidth,
                    dash: layer.strokeDash,
                    dashEnabled: true,
                    tension: 0.4,
                    lineCap: 'round' as const,
                    lineJoin: 'round' as const
                };
                return layer.effect === 'travel' ? (
                    <EffectLine
                        key={`line-path-${pathIndex}`}
                        {...props}
                        effect={layer.effect}
                        effectSettings={layer.effectSettings}
                        getTimeMs={getTimeMs}
                    />
                ) : (
                    <Line key={`line-path-${pathIndex}`} {...props} />
                );
            })}
        </Group>
    );
});
