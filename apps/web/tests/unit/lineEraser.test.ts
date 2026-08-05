import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import type { EditorState, SliceHelpers } from '../../src/lib/editorStore.types';
import {
    ERASER_BATCH_MAX_POINTS,
    getLineEraseFailureMessage,
    LINE_ERASE_MAX_OUTPUT_PATHS,
    LINE_ERASE_MAX_OUTPUT_POINTS,
    LINE_PATH_MAX_POINTS,
    appendEraserPoint,
    eraseLinePathsResiliently,
    eraseLinePathsWithinBudget,
    type LineEraseEngineFailureReason,
    type LineEraseEngineResult,
    type LineEraseTerminalFailureReason,
    type LineEraseTerminalResult
} from '../../src/lib/lineEraser';
import {
    getLinePaths,
    GSMessageSchema,
    preserveLinePathsFromExisting,
    type Layer,
    type LayerWithEditorState
} from '../../src/lib/types';
import { z } from '../../src/lib/zod';

Object.assign(globalThis, {
    __APP_COMMIT_SHA__: 'test',
    __APP_BUILD_TIMESTAMP__: 'test'
});

const [{ EditorEngine }, { createLayerSlice }] = await Promise.all([
    import('../../src/lib/editorEngine'),
    import('../../src/lib/editorStore.layers')
]);

const lineLayer: LayerWithEditorState = {
    numericId: 7,
    type: 'line',
    config: {
        cx: 50,
        cy: 0,
        width: 100,
        height: 20,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        visible: true
    },
    line: [0, 0, 100, 0],
    strokeColor: '#ff0000',
    strokeWidth: 10,
    strokeDash: []
};

const legacyLine: Extract<Layer, { type: 'line' }> = {
    numericId: 7,
    type: 'line',
    config: lineLayer.config,
    line: [0, 0, 100, 0],
    strokeColor: '#ff0000',
    strokeWidth: 10,
    strokeDash: []
};

const splitPaths = [
    [0, 0, 40, 0],
    [60, 0, 100, 0]
];

const legacyLayerConfigSchema = z.object({
    cx: z.number(),
    cy: z.number(),
    width: z.number(),
    height: z.number(),
    rotation: z.number(),
    scaleX: z.number(),
    scaleY: z.number(),
    zIndex: z.number(),
    visible: z.boolean()
});
const legacyLineLayerSchema = z.object({
    numericId: z.number(),
    type: z.literal('line'),
    config: legacyLayerConfigSchema,
    line: z.array(z.number()),
    strokeColor: z.string(),
    strokeWidth: z.number(),
    strokeDash: z.array(z.number())
});
const legacyHydrateMessageSchema = z.object({
    type: z.literal('hydrate'),
    layers: z.array(legacyLineLayerSchema),
    projectId: z.string().optional(),
    commitId: z.string().optional(),
    slideId: z.string().optional()
});
const legacyUpsertMessageSchema = z.object({
    type: z.literal('upsert_layer'),
    origin: z.string(),
    layer: legacyLineLayerSchema
});

function createTestStore() {
    const sendJSON = mock();
    const markDirty = mock();
    spyOn(EditorEngine, 'getInstance').mockReturnValue({
        sendJSON
    } as unknown as ReturnType<(typeof EditorEngine)['getInstance']>);

    let state = {
        layers: new Map([[lineLayer.numericId, lineLayer]]),
        selectedLayerIds: [lineLayer.numericId.toString()],
        isErasing: true,
        markDirty
    } as unknown as EditorState;
    const set = (
        update: Partial<EditorState> | ((current: EditorState) => Partial<EditorState>)
    ) => {
        const partial = typeof update === 'function' ? update(state) : update;
        state = { ...state, ...partial };
    };
    const actions = createLayerSlice(set, () => state, {} as SliceHelpers);
    state = { ...state, ...actions };

    return { actions, getState: () => state, markDirty, sendJSON };
}

afterEach(() => mock.restore());

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

    test('a repeated erase preserves every prior gap instead of bridging paths', async () => {
        const first = await eraseLinePathsResiliently([[0, 0, 100, 0]], [50, 0], 10);
        const second = await eraseLinePathsResiliently(first.paths, [80, 0], 5);

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

describe('eraseLinePathsResiliently performance', () => {
    test('bounds dense large-input work without dropping the erase', async () => {
        const line = [makePath(LINE_PATH_MAX_POINTS, (i) => [i % 2, 0])];
        const eraserPath = makePath(ERASER_BATCH_MAX_POINTS, (i) => [i % 2, 0]);
        const start = performance.now();

        const result = await eraseLinePathsResiliently(line, eraserPath, 10);

        expect(result).toEqual({ status: 'changed', paths: [] });
        expect(performance.now() - start).toBeLessThan(250);
    });

    test('bounds a long-lived fragmented line through structure relaxation and direct fallback', async () => {
        const fragmentedPaths = Array.from({ length: 2_000 }, () => [0, 0, 1, 0]);
        const { eraserPath } = makeWorkHeavyGeometry();
        const boundedResult = eraseLinePathsWithinBudget(
            fragmentedPaths.slice(0, LINE_ERASE_MAX_OUTPUT_PATHS),
            eraserPath,
            10
        );
        const start = performance.now();

        let yieldCount = 0;
        const result = await eraseLinePathsResiliently(
            fragmentedPaths,
            eraserPath,
            10,
            async () => {
                yieldCount += 1;
            }
        );

        expect(boundedResult.status).toBe('failed');
        if (boundedResult.status !== 'failed') throw new Error('Expected bounded failure');
        expect(boundedResult.reason).toBe('work_budget_exceeded');
        expect(result).toEqual({ status: 'changed', paths: [] });
        expect(yieldCount).toBeGreaterThan(0);
        expect(performance.now() - start).toBeLessThan(250);
    });

    test('chunks one very long path and preserves the gap across chunk boundaries', async () => {
        const paths = [makePath(260_002, (index) => [index, 0])];
        let yieldCount = 0;
        const start = performance.now();

        const result = await eraseLinePathsResiliently(paths, [125_000, 0], 10, async () => {
            yieldCount += 1;
        });

        expect(result.status).toBe('changed');
        expect(result.paths).toHaveLength(2);
        expect(result.paths[0].slice(0, 2)).toEqual([0, 0]);
        expect(result.paths[0].slice(-2)).toEqual([124_990, 0]);
        expect(result.paths[1].slice(0, 2)).toEqual([125_010, 0]);
        expect(result.paths[1].slice(-2)).toEqual([260_001, 0]);
        expect(yieldCount).toBeGreaterThanOrEqual(2);
        expect(performance.now() - start).toBeLessThan(1_000);
    });

    test('does not lose a large erase after irrelevant input', async () => {
        const line = [makePath(LINE_PATH_MAX_POINTS, (i) => [i % 2, 0])];
        const eraserPath = makePath(ERASER_BATCH_MAX_POINTS, (i) =>
            i === ERASER_BATCH_MAX_POINTS - 1 ? [0, 0] : [30 + (i % 2), 30]
        );
        const start = performance.now();

        const result = await eraseLinePathsResiliently(line, eraserPath, 10);

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

describe('eraseLinePathsResiliently', () => {
    test('subdivides an oversized gesture without dropping its later points', async () => {
        const paths = [makePath(3_000, (i) => [i, 0])];
        const eraserPath = makePath(2_500, (i) => [i, 0]);

        const result = await eraseLinePathsResiliently(paths, eraserPath, 5);

        expect(result.status).toBe('changed');
        expect(result.paths).toHaveLength(1);
        expect(result.paths[0][0]).toBeGreaterThan(2_499);
        expect(result.paths[0].at(-2)).toBe(2_999);
    });

    test('falls back from a work-heavy batch and completes the erase', async () => {
        const { paths, eraserPath } = makeWorkHeavyGeometry();

        expect(eraseLinePathsWithinBudget(paths, eraserPath, 10).status).toBe('failed');

        const result = await eraseLinePathsResiliently(paths, eraserPath, 10);

        expect(result.status).toBe('changed');
        expect(result.paths).toEqual([]);
    });

    test('keeps all geometry when a valid erase exceeds output limits', async () => {
        const paths = [[0, 0, 6_000, 0]];
        const eraserPath: number[] = [];
        for (let i = 0; i < ERASER_BATCH_MAX_POINTS / 2; i += 1) {
            const x = i * 10 + 5;
            eraserPath.push(x, -5, x, 5);
        }

        const result = await eraseLinePathsResiliently(paths, eraserPath, 1);

        expect(result.status).toBe('changed');
        expect(result.paths.length).toBeGreaterThan(LINE_ERASE_MAX_OUTPUT_PATHS);
        expect(result.paths[0]).toEqual([0, 0, 4, 0]);
        expect(result.paths.at(-1)?.at(-2)).toBe(6_000);
    });

    test('keeps all points when a valid erase exceeds the output point limit', async () => {
        const paths = [makePath(LINE_ERASE_MAX_OUTPUT_POINTS, (i) => [i * 10, 0])];

        const result = await eraseLinePathsResiliently(paths, [5, -2, 5, 2], 1);
        const pointCount = result.paths.reduce((total, path) => total + path.length / 2, 0);

        expect(result.status).toBe('changed');
        expect(pointCount).toBeGreaterThan(LINE_ERASE_MAX_OUTPUT_POINTS);
    });

    test('continues erasing geometry that already exceeds structure limits', async () => {
        const manyPaths = Array.from({ length: LINE_ERASE_MAX_OUTPUT_PATHS + 1 }, (_, index) => [
            index * 10,
            0,
            index * 10 + 1,
            0
        ]);
        const manyPoints = [makePath(LINE_ERASE_MAX_OUTPUT_POINTS + 1, (i) => [i * 10, 0])];

        const pathResult = await eraseLinePathsResiliently(manyPaths, [0, 0], 2);
        const pointResult = await eraseLinePathsResiliently(manyPoints, [5, -2, 5, 2], 1);

        expect(pathResult.status).toBe('changed');
        expect(pathResult.paths).toHaveLength(LINE_ERASE_MAX_OUTPUT_PATHS);
        expect(pointResult.status).toBe('changed');
        expect(pointResult.paths.flat().length / 2).toBeGreaterThan(LINE_ERASE_MAX_OUTPUT_POINTS);
    });

    test('treats later batches as no-ops after an earlier batch erased the whole line', async () => {
        const firstBatch = await eraseLinePathsResiliently([[0, 0, 100, 0]], [0, 0, 100, 0], 10);

        expect(firstBatch).toEqual({ status: 'changed', paths: [] });
        expect(await eraseLinePathsResiliently(firstBatch.paths, [100, 0, 200, 0], 10)).toEqual({
            status: 'unchanged',
            paths: firstBatch.paths
        });
    });

    test('still reports invalid data instead of retrying it', async () => {
        const paths = [[0, 0, 100, 0]];
        const invalidPaths = [[0, 0, 1]];

        expectTerminalFailure(
            await eraseLinePathsResiliently(paths, [0, 0, 1], 10),
            'invalid_eraser_path',
            paths
        );
        expectTerminalFailure(
            await eraseLinePathsResiliently(paths, [0, 0], 0),
            'invalid_radius',
            paths
        );
        expectTerminalFailure(
            await eraseLinePathsResiliently(invalidPaths, [0, 0], 10),
            'invalid_line_paths',
            invalidPaths
        );
    });
});

describe('commitLineErase', () => {
    test('updates the local layer and sends one authoritative upsert', () => {
        const finalLine = [
            [0, 0, 40, 0],
            [60, 0, 100, 0]
        ];
        const { actions, getState, markDirty, sendJSON } = createTestStore();

        actions.commitLineErase(lineLayer.numericId, finalLine);

        const updatedLayer = getState().layers.get(lineLayer.numericId);
        expect(updatedLayer?.type).toBe('line');
        if (!updatedLayer || updatedLayer.type !== 'line') throw new Error('Expected line layer');
        expect(updatedLayer.line).toEqual(finalLine[0]);
        expect(updatedLayer.linePaths).toEqual(finalLine);
        expect(sendJSON).toHaveBeenCalledTimes(1);
        expect(sendJSON).toHaveBeenCalledWith({
            type: 'upsert_layer',
            origin: 'editor:erase_line_layer',
            layer: { ...lineLayer, line: finalLine[0], linePaths: finalLine }
        });
        expect(markDirty).toHaveBeenCalledTimes(1);
    });

    test('uses the longest remaining path as fallback and updates the full-path bounds', () => {
        const finalLine = [
            [20, 0, 40, 0],
            [60, 0, 80, 0, 100, 0]
        ];
        const { actions, getState } = createTestStore();

        actions.commitLineErase(lineLayer.numericId, finalLine);

        const updatedLayer = getState().layers.get(lineLayer.numericId);
        expect(updatedLayer?.type).toBe('line');
        if (!updatedLayer || updatedLayer.type !== 'line') throw new Error('Expected line layer');
        expect(updatedLayer.line).toEqual(finalLine[1]);
        expect(updatedLayer.linePaths).toEqual(finalLine);
        expect(updatedLayer.config).toEqual({
            ...lineLayer.config,
            cx: 60,
            width: 80,
            height: 20
        });
    });

    test('deletes a completely erased layer', () => {
        const { actions, getState, markDirty, sendJSON } = createTestStore();

        actions.commitLineErase(lineLayer.numericId, []);

        expect(getState().layers.has(lineLayer.numericId)).toBe(false);
        expect(getState().selectedLayerIds).toEqual([]);
        expect(getState().isErasing).toBe(false);
        expect(sendJSON).toHaveBeenCalledTimes(1);
        expect(sendJSON).toHaveBeenCalledWith({
            type: 'delete_layer',
            numericId: lineLayer.numericId
        });
        expect(markDirty).toHaveBeenCalledTimes(1);
    });
});

describe('linePaths compatibility', () => {
    test('hydrates the legacy flat line format', () => {
        const message = GSMessageSchema.parse({ type: 'hydrate', layers: [legacyLine] });

        expect(message.type).toBe('hydrate');
        if (message.type !== 'hydrate' || message.layers[0].type !== 'line') {
            throw new Error('Expected a hydrated line');
        }
        expect(getLinePaths(message.layers[0])).toEqual([[0, 0, 100, 0]]);
    });

    test('uses linePaths as the authoritative geometry', () => {
        const message = GSMessageSchema.parse({
            type: 'hydrate',
            layers: [{ ...legacyLine, line: splitPaths[0], linePaths: splitPaths }]
        });

        expect(message.type).toBe('hydrate');
        if (message.type !== 'hydrate' || message.layers[0].type !== 'line') {
            throw new Error('Expected a hydrated line');
        }
        expect(message.layers[0].line).toEqual(splitPaths[0]);
        expect(getLinePaths(message.layers[0])).toEqual(splitPaths);
    });

    test('serializes as a complete hydrate message accepted by a legacy client', () => {
        const wireMessage = JSON.parse(
            JSON.stringify({
                type: 'hydrate',
                projectId: 'legacy-project',
                commitId: 'legacy-commit',
                slideId: 'legacy-slide',
                layers: [{ ...legacyLine, line: splitPaths[0], linePaths: splitPaths }]
            })
        );

        expect(legacyHydrateMessageSchema.parse(wireMessage)).toEqual({
            type: 'hydrate',
            projectId: 'legacy-project',
            commitId: 'legacy-commit',
            slideId: 'legacy-slide',
            layers: [{ ...legacyLine, line: splitPaths[0] }]
        });
    });

    test('serializes as a complete upsert accepted by a legacy client', () => {
        const wireMessage = JSON.parse(
            JSON.stringify({
                type: 'upsert_layer',
                origin: 'editor:erase_line_layer',
                layer: { ...legacyLine, line: splitPaths[0], linePaths: splitPaths }
            })
        );

        expect(legacyUpsertMessageSchema.parse(wireMessage)).toEqual({
            type: 'upsert_layer',
            origin: 'editor:erase_line_layer',
            layer: { ...legacyLine, line: splitPaths[0] }
        });
    });

    test('normalizes branch data that was already stored with a nested line field', () => {
        const message = GSMessageSchema.parse({
            type: 'hydrate',
            layers: [{ ...legacyLine, line: splitPaths }]
        });

        expect(message.type).toBe('hydrate');
        if (message.type !== 'hydrate' || message.layers[0].type !== 'line') {
            throw new Error('Expected a hydrated line');
        }
        expect(message.layers[0].line).toEqual(splitPaths[0]);
        expect(message.layers[0].linePaths).toEqual(splitPaths);
    });

    test('preserves paths when an older client upserts without linePaths', () => {
        const existing: Layer = { ...legacyLine, line: splitPaths[0], linePaths: splitPaths };
        const incoming: Layer = { ...legacyLine, strokeColor: '#00ff00' };

        expect(preserveLinePathsFromExisting(existing, incoming)).toEqual({
            ...incoming,
            linePaths: splitPaths
        });
    });

    test('accepts authoritative paths supplied by a current client', () => {
        const existing: Layer = { ...legacyLine, line: splitPaths[0], linePaths: splitPaths };
        const replacement: Layer = {
            ...legacyLine,
            line: [10, 0, 20, 0],
            linePaths: [[10, 0, 20, 0]]
        };

        expect(preserveLinePathsFromExisting(existing, replacement)).toBe(replacement);
    });
});
