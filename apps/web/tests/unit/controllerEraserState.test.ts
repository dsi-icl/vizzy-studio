import { beforeEach, describe, expect, test } from 'bun:test';

import { useControllerStore } from '../../src/lib/controllerStore';
import { ERASER_DEFAULT_WIDTH, ERASER_MAX_WIDTH } from '../../src/lib/eraser';
import { ERASER_BATCH_MAX_POINTS } from '../../src/lib/lineEraser';

beforeEach(() => {
    useControllerStore.setState({
        isDrawing: false,
        isErasing: false,
        eraserWidth: ERASER_DEFAULT_WIDTH,
        currentLine: []
    });
});

describe('controller eraser state', () => {
    test('keeps drawing and erasing mutually exclusive', () => {
        useControllerStore.getState().setErasing(true);
        expect(useControllerStore.getState().isErasing).toBe(true);

        useControllerStore.getState().toggleDrawing();
        expect(useControllerStore.getState().isDrawing).toBe(true);
        expect(useControllerStore.getState().isErasing).toBe(false);
    });

    test('clamps the eraser width', () => {
        useControllerStore.getState().setEraserWidth(ERASER_MAX_WIDTH + 1);
        expect(useControllerStore.getState().eraserWidth).toBe(ERASER_MAX_WIDTH);
    });

    test('keeps a 10,000-point gesture lossless across bounded batches', () => {
        const store = useControllerStore.getState();
        const batches: number[][] = [];
        let maxActivePoints = 0;
        store.startLine(0, 0);

        for (let i = 1; i < 10_000; i += 1) {
            const batch = store.appendEraserPoint(i, 0);
            if (batch) batches.push(batch);
            maxActivePoints = Math.max(
                maxActivePoints,
                useControllerStore.getState().currentLine.length / 2
            );
        }

        const remainder = store.consumeCurrentLine();
        const rebuilt = batches.flatMap((batch, index) => (index === 0 ? batch : batch.slice(2)));
        rebuilt.push(...(batches.length === 0 ? remainder : remainder.slice(2)));

        expect(maxActivePoints).toBeLessThanOrEqual(ERASER_BATCH_MAX_POINTS);
        expect(rebuilt).toHaveLength(20_000);
        expect(rebuilt[0]).toBe(0);
        expect(rebuilt.at(-2)).toBe(9_999);
    });
});
