import { describe, expect, test } from 'bun:test';

import {
    getStageGridLineSegments,
    getStageGridLines,
    getStageLogicalSize
} from '../../src/lib/editorHelpers';

describe('stage preview geometry', () => {
    test('uses the stage layout for its logical aspect ratio', () => {
        expect(
            getStageLogicalSize({
                columns: 3,
                rows: 2,
                screenWidth: 1280,
                screenHeight: 1024
            })
        ).toEqual({ width: 3840, height: 2048 });
    });

    test('places one grid line at each internal screen boundary', () => {
        const lines = getStageGridLineSegments({
            columns: 3,
            rows: 2,
            screenWidth: 1280,
            screenHeight: 1024
        });

        expect(lines).toEqual([
            { key: 'v-1', points: [1280, 0, 1280, 2048] },
            { key: 'v-2', points: [2560, 0, 2560, 2048] },
            { key: 'h-1', points: [0, 1024, 3840, 1024] }
        ]);
    });

    test('does not draw internal grid lines for a single-screen stage', () => {
        expect(
            getStageGridLineSegments({
                columns: 1,
                rows: 1,
                screenWidth: 1920,
                screenHeight: 1080
            })
        ).toEqual([]);
    });

    test('keeps grid strokes independent from stage scaling', () => {
        const [line] = getStageGridLines(
            {
                columns: 2,
                rows: 1,
                screenWidth: 1920,
                screenHeight: 1080
            },
            2
        );

        expect(line.props.strokeWidth).toBe(2);
        expect(line.props.strokeScaleEnabled).toBe(false);
    });
});
