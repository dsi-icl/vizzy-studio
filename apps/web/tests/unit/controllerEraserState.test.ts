import { beforeEach, describe, expect, test } from 'bun:test';

import { useControllerStore } from '../../src/lib/controllerStore';
import { ERASER_DEFAULT_WIDTH, ERASER_MAX_WIDTH } from '../../src/lib/eraser';

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
});
