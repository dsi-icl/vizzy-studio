import type { StageLayout } from '@repo/db/schema';
import { Line } from 'react-konva';

export type StageGridLine = {
    key: string;
    points: [number, number, number, number];
};

export function getStageLogicalSize(layout: StageLayout) {
    return {
        width: layout.columns * layout.screenWidth,
        height: layout.rows * layout.screenHeight
    };
}

export function getStageGridLineSegments(layout: StageLayout): StageGridLine[] {
    const columns = Math.max(1, Math.trunc(layout.columns));
    const rows = Math.max(1, Math.trunc(layout.rows));
    const { width, height } = getStageLogicalSize({
        ...layout,
        columns,
        rows
    });
    const lines: StageGridLine[] = [];

    for (let column = 1; column < columns; column++) {
        const x = column * layout.screenWidth;
        lines.push({ key: `v-${column}`, points: [x, 0, x, height] });
    }

    for (let row = 1; row < rows; row++) {
        const y = row * layout.screenHeight;
        lines.push({ key: `h-${row}`, points: [0, y, width, y] });
    }

    return lines;
}

export function getStageGridLines(layout: StageLayout, strokeWidth = 1) {
    return getStageGridLineSegments(layout).map((line) => (
        <Line
            key={line.key}
            points={line.points}
            strokeWidth={strokeWidth}
            strokeScaleEnabled={false}
            listening={false}
            stroke="black"
        />
    ));
}
