import { describe, expect, test } from 'bun:test';

import {
    ERASER_BATCH_MAX_POINTS,
    getLineEraseFailureMessage,
    LINE_ERASE_MAX_OUTPUT_PATHS,
    LINE_ERASE_MAX_OUTPUT_POINTS,
    LINE_PATH_MAX_POINTS,
    appendEraserPoint,
    eraseLinePaths,
    eraseLinePathsWithinBudget,
    type LineEraseEngineFailureReason,
    type LineEraseEngineResult,
    type LineEraseTerminalFailureReason,
    type LineEraseTerminalResult
} from '../../src/lib/lineEraser';

function makePath(pointCount: number, pointAt: (index: number) => [number, number]): number[] {
    const path = new Array<number>(pointCount * 2);
    for (let i = 0; i < pointCount; i += 1) {
        const [x, y] = pointAt(i);
        path[i * 2] = x;
        path[i * 2 + 1] = y;
    }
    return path;
}

function makeWorkHeavyGeometry(): { paths: number[][]; eraserPath: number[] } {
    return {
        paths: [makePath(1_000, (i) => [i % 2, 0])],
        eraserPath: makePath(ERASER_BATCH_MAX_POINTS, (i) => {
            if (i === ERASER_BATCH_MAX_POINTS - 1) return [0, 0];
            return [10, i % 2 === 0 ? 10 : 11];
        })
    };
}

function expectFailure(
    result: LineEraseEngineResult,
    reason: LineEraseEngineFailureReason,
    originalPaths: number[][]
) {
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error(`Expected ${reason}`);
    expect(result.reason).toBe(reason);
    expect(result.paths).toBe(originalPaths);
}

function expectTerminalFailure(
    result: LineEraseTerminalResult,
    reason: LineEraseTerminalFailureReason,
    originalPaths: number[][]
) {
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error(`Expected ${reason}`);
    expect(result.reason).toBe(reason);
    expect(result.paths).toBe(originalPaths);
}

describe('terminal failure messages', () => {
    test.each([
        'invalid_radius',
        'invalid_eraser_path',
        'invalid_line_paths',
        'processing_failed'
    ] as const)('has user-facing copy for %s', (reason) => {
        expect(getLineEraseFailureMessage(reason).length).toBeGreaterThan(0);
    });
});

describe('eraseLinePathsWithinBudget geometry', () => {
    test('partially erases a line', () => {
        const result = eraseLinePathsWithinBudget([[0, 0, 100, 0]], [50, -20, 50, 20], 10);

        expect(result).toEqual({
            status: 'changed',
            paths: [
                [0, 0, 40, 0],
                [60, 0, 100, 0]
            ]
        });
    });

    test('removes a completely erased line', () => {
        const result = eraseLinePathsWithinBudget([[0, 0, 100, 0]], [0, 0, 100, 0], 10);

        expect(result).toEqual({ status: 'changed', paths: [] });
    });

    test('supports multiple cuts in one stroke', () => {
        const result = eraseLinePathsWithinBudget(
            [[0, 0, 100, 0]],
            [25, -20, 25, 20, 50, 20, 75, 20, 75, -20],
            5
        );

        expect(result).toEqual({
            status: 'changed',
            paths: [
                [0, 0, 20, 0],
                [30, 0, 70, 0],
                [80, 0, 100, 0]
            ]
        });
    });

    test('reports an unchanged result for a no-op stroke', () => {
        const paths = [[0, 0, 100, 0]];

        expect(eraseLinePathsWithinBudget(paths, [0, 100, 100, 100], 10)).toEqual({
            status: 'unchanged',
            paths
        });
    });

    test('erases one existing split path without joining it to its neighbour', () => {
        const paths = [
            [0, 0, 100, 0],
            [0, 50, 100, 50]
        ];

        expect(eraseLinePathsWithinBudget(paths, [50, 0], 10)).toEqual({
            status: 'changed',
            paths: [
                [0, 0, 40, 0],
                [60, 0, 100, 0],
                [0, 50, 100, 50]
            ]
        });
    });

    test('cuts diagonal geometry at the circle intersections', () => {
        expect(eraseLinePathsWithinBudget([[0, 0, 100, 100]], [50, 50], 10)).toEqual({
            status: 'changed',
            paths: [
                [0, 0, 43, 43],
                [57, 57, 100, 100]
            ]
        });
    });

    test('supports a tap erase and clips an endpoint', () => {
        expect(eraseLinePathsWithinBudget([[0, 0, 100, 0]], [0, 0], 10)).toEqual({
            status: 'changed',
            paths: [[10, 0, 100, 0]]
        });
    });

    test('treats an exact tangent as a no-op', () => {
        const paths = [[0, 10, 100, 10]];

        expect(eraseLinePathsWithinBudget(paths, [50, 0], 10)).toEqual({
            status: 'unchanged',
            paths
        });
    });

    test('a repeated erase preserves every prior gap instead of bridging paths', () => {
        const first = eraseLinePaths([[0, 0, 100, 0]], [50, 0], 10);
        const second = eraseLinePaths(first.paths, [80, 0], 5);

        expect(second).toEqual({
            status: 'changed',
            paths: [
                [0, 0, 40, 0],
                [60, 0, 75, 0],
                [85, 0, 100, 0]
            ]
        });
    });
});

describe('appendEraserPoint', () => {
    test('keeps the boundary point between batches', () => {
        const activeBatch = [0, 0];
        let completedBatch: number[] | null = null;

        for (let i = 1; i < ERASER_BATCH_MAX_POINTS; i += 1) {
            completedBatch = appendEraserPoint(activeBatch, i, 0);
        }

        expect(completedBatch).not.toBeNull();
        expect(completedBatch?.slice(-2)).toEqual(activeBatch);
        expect(activeBatch).toEqual([ERASER_BATCH_MAX_POINTS - 1, 0]);
    });
});

describe('eraseLinePaths performance', () => {
    test('bounds dense maximum-size input', () => {
        const line = [makePath(LINE_PATH_MAX_POINTS, (i) => [i % 2, 0])];
        const eraserPath = makePath(ERASER_BATCH_MAX_POINTS, (i) => [i % 2, 0]);
        const start = performance.now();

        const result = eraseLinePaths(line, eraserPath, 10);

        expect(result).toEqual({ status: 'changed', paths: [] });
        expect(performance.now() - start).toBeLessThan(250);
    });

    test('does not lose a maximum-size erase after irrelevant input', () => {
        const line = [makePath(LINE_PATH_MAX_POINTS, (i) => [i % 2, 0])];
        const eraserPath = makePath(ERASER_BATCH_MAX_POINTS, (i) =>
            i === ERASER_BATCH_MAX_POINTS - 1 ? [0, 0] : [30 + (i % 2), 30]
        );
        const start = performance.now();

        const result = eraseLinePaths(line, eraserPath, 10);

        expect(result).toEqual({ status: 'changed', paths: [] });
        expect(performance.now() - start).toBeLessThan(250);
    });
});

describe('eraseLinePathsWithinBudget failures', () => {
    test('reports an invalid radius', () => {
        const paths = [[0, 0, 100, 0]];

        expectFailure(eraseLinePathsWithinBudget(paths, [50, 0], 0), 'invalid_radius', paths);
    });

    test('reports malformed or empty eraser geometry', () => {
        const paths = [[0, 0, 100, 0]];

        expectFailure(
            eraseLinePathsWithinBudget(paths, [0, 0, 1], 10),
            'invalid_eraser_path',
            paths
        );
        expectFailure(eraseLinePathsWithinBudget(paths, [], 10), 'invalid_eraser_path', paths);
        expectFailure(
            eraseLinePathsWithinBudget(paths, [Number.NaN, 0], 10),
            'invalid_eraser_path',
            paths
        );
    });

    test('reports an oversized eraser batch', () => {
        const paths = [[0, 0, 100, 0]];
        const oversizedPath = makePath(ERASER_BATCH_MAX_POINTS + 1, (i) => [i, 0]);

        expectFailure(
            eraseLinePathsWithinBudget(paths, oversizedPath, 10),
            'eraser_batch_limit_exceeded',
            paths
        );
    });

    test('reports invalid line geometry', () => {
        const oddPath = [[0, 0, 1]];
        const nonFinitePath = [[0, 0, Number.POSITIVE_INFINITY, 0]];
        const emptyPaths: number[][] = [];

        expectFailure(
            eraseLinePathsWithinBudget(oddPath, [0, 0], 10),
            'invalid_line_paths',
            oddPath
        );
        expectFailure(
            eraseLinePathsWithinBudget(nonFinitePath, [0, 0], 10),
            'invalid_line_paths',
            nonFinitePath
        );
        expect(eraseLinePathsWithinBudget(emptyPaths, [0, 0], 10)).toEqual({
            status: 'unchanged',
            paths: emptyPaths
        });
    });

    test('reports an existing line path-count overflow', () => {
        const paths = Array.from({ length: LINE_ERASE_MAX_OUTPUT_PATHS + 1 }, (_, index) => [
            index,
            0,
            index + 1,
            0
        ]);

        expectFailure(
            eraseLinePathsWithinBudget(paths, [0, 0], 10),
            'line_path_limit_exceeded',
            paths
        );
    });

    test('reports an existing line point-count overflow', () => {
        const paths = [makePath(LINE_ERASE_MAX_OUTPUT_POINTS + 1, (i) => [i, 0])];

        expectFailure(
            eraseLinePathsWithinBudget(paths, [0, 0], 10),
            'line_point_limit_exceeded',
            paths
        );
    });

    test('reports work-budget exhaustion inside a valid batch', () => {
        const { paths, eraserPath } = makeWorkHeavyGeometry();

        expectFailure(
            eraseLinePathsWithinBudget(paths, eraserPath, 10),
            'work_budget_exceeded',
            paths
        );
    });

    test('reports when an erase would create too many paths', () => {
        const paths = [[0, 0, 6_000, 0]];
        const eraserPath: number[] = [];
        for (let i = 0; i < ERASER_BATCH_MAX_POINTS / 2; i += 1) {
            const x = i * 10 + 5;
            eraserPath.push(x, -5, x, 5);
        }

        expectFailure(
            eraseLinePathsWithinBudget(paths, eraserPath, 1),
            'output_path_limit_exceeded',
            paths
        );
    });

    test('reports when an erase would create too many points', () => {
        const paths = [makePath(LINE_ERASE_MAX_OUTPUT_POINTS, (i) => [i * 10, 0])];

        expectFailure(
            eraseLinePathsWithinBudget(paths, [5, -2, 5, 2], 1),
            'output_point_limit_exceeded',
            paths
        );
    });
});

describe('eraseLinePaths', () => {
    test('treats a later batch as a no-op after the line is gone', () => {
        const firstBatch = eraseLinePaths([[0, 0, 100, 0]], [0, 0, 100, 0], 10);

        expect(firstBatch).toEqual({ status: 'changed', paths: [] });
        expect(eraseLinePaths(firstBatch.paths, [100, 0, 200, 0], 10)).toEqual({
            status: 'unchanged',
            paths: firstBatch.paths
        });
    });

    test('returns terminal failures without retrying invalid input', () => {
        const paths = [[0, 0, 100, 0]];
        const invalidPaths = [[0, 0, 1]];

        expectTerminalFailure(eraseLinePaths(paths, [0, 0, 1], 10), 'invalid_eraser_path', paths);
        expectTerminalFailure(eraseLinePaths(paths, [0, 0], 0), 'invalid_radius', paths);
        expectTerminalFailure(
            eraseLinePaths(invalidPaths, [0, 0], 10),
            'invalid_line_paths',
            invalidPaths
        );
    });
});
