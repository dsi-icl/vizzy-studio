import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import type { EditorState, SliceHelpers } from '../../src/lib/editorStore.types';
import {
    ERASER_BATCH_MAX_POINTS,
    LINE_PATH_MAX_POINTS,
    appendEraserPoint,
    eraseLinePaths
} from '../../src/lib/lineEraser';
import type { LayerWithEditorState } from '../../src/lib/types';

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
        height: 10,
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

function eraseInBatches(line: number[][], eraserPath: number[], radius: number): number[][] {
    let nextLine = line;
    const pointCount = eraserPath.length / 2;
    const activeBatch = eraserPath.slice(0, 2);
    let didProcessBatch = false;

    for (let i = 1; i < pointCount; i += 1) {
        const batch = appendEraserPoint(activeBatch, eraserPath[i * 2], eraserPath[i * 2 + 1]);
        if (!batch) continue;
        nextLine = eraseLinePaths(nextLine, batch, radius);
        didProcessBatch = true;
    }

    if (activeBatch.length > 2 || !didProcessBatch) {
        nextLine = eraseLinePaths(nextLine, activeBatch, radius);
    }

    return nextLine;
}

describe('eraseLinePaths', () => {
    test('partially erases a line', () => {
        const result = eraseLinePaths([[0, 0, 100, 0]], [50, -20, 50, 20], 10);

        expect(result).toEqual([
            [0, 0, 40, 0],
            [60, 0, 100, 0]
        ]);
    });

    test('removes a completely erased line', () => {
        const result = eraseLinePaths([[0, 0, 100, 0]], [0, 0, 100, 0], 10);

        expect(result).toEqual([]);
    });

    test('supports multiple cuts in one stroke', () => {
        const result = eraseLinePaths(
            [[0, 0, 100, 0]],
            [25, -20, 25, 20, 50, 20, 75, 20, 75, -20],
            5
        );

        expect(result).toEqual([
            [0, 0, 20, 0],
            [30, 0, 70, 0],
            [80, 0, 100, 0]
        ]);
    });

    test('returns the original line for a no-op stroke', () => {
        const line = [[0, 0, 100, 0]];

        expect(eraseLinePaths(line, [0, 100, 100, 100], 10)).toBe(line);
    });

    test('continues a stroke across processing batches', () => {
        const line = [makePath(3_000, (i) => [i, 0])];
        const eraserPath = makePath(2_500, (i) => [i, 0]);

        const result = eraseInBatches(line, eraserPath, 5);

        expect(result).not.toBe(line);
        expect(result).toHaveLength(1);
        expect(result[0][0]).toBeGreaterThan(2_499);
        expect(result[0].at(-2)).toBe(2_999);
    });

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

    test('bounds dense large-input work without dropping the erase', () => {
        const line = [makePath(LINE_PATH_MAX_POINTS, (i) => [i % 2, 0])];
        const eraserPath = makePath(ERASER_BATCH_MAX_POINTS, (i) => [i % 2, 0]);
        const start = performance.now();

        const result = eraseLinePaths(line, eraserPath, 10);

        expect(result).toEqual([]);
        expect(performance.now() - start).toBeLessThan(250);
    });

    test('does not lose a large erase after irrelevant input', () => {
        const line = [makePath(LINE_PATH_MAX_POINTS, (i) => [i % 2, 0])];
        const eraserPath = makePath(ERASER_BATCH_MAX_POINTS, (i) =>
            i === ERASER_BATCH_MAX_POINTS - 1 ? [0, 0] : [30 + (i % 2), 30]
        );
        const start = performance.now();

        const result = eraseLinePaths(line, eraserPath, 10);

        expect(result).toEqual([]);
        expect(performance.now() - start).toBeLessThan(250);
    });

    test('rejects malformed and oversized batches', () => {
        const line = [[0, 0, 100, 0]];
        const oversizedPath = makePath(ERASER_BATCH_MAX_POINTS + 1, (i) => [i, 0]);

        expect(eraseLinePaths(line, [0, 0, 1], 10)).toBe(line);
        expect(eraseLinePaths(line, oversizedPath, 10)).toBe(line);
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
        expect(updatedLayer.line).toEqual(finalLine);
        expect(sendJSON).toHaveBeenCalledTimes(1);
        expect(sendJSON).toHaveBeenCalledWith({
            type: 'upsert_layer',
            origin: 'editor:erase_line_layer',
            layer: { ...lineLayer, line: finalLine }
        });
        expect(markDirty).toHaveBeenCalledTimes(1);
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
