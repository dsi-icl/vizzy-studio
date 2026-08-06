import { describe, expect, test } from 'bun:test';

import { getCanvasSelectionModifiers } from './editorSelection';

describe('canvas layer selection', () => {
    test('maps Shift to a single-hit additive selection instead of a list range', () => {
        expect(
            getCanvasSelectionModifiers({ shiftKey: true, ctrlKey: false, metaKey: false })
        ).toEqual({ isShiftClick: false, isCtrlClick: true });
    });

    test('preserves plain and Ctrl/Command selection gestures', () => {
        expect(
            getCanvasSelectionModifiers({ shiftKey: false, ctrlKey: false, metaKey: false })
        ).toEqual({ isShiftClick: false, isCtrlClick: false });
        expect(
            getCanvasSelectionModifiers({ shiftKey: false, ctrlKey: true, metaKey: false })
        ).toEqual({ isShiftClick: false, isCtrlClick: true });
        expect(
            getCanvasSelectionModifiers({ shiftKey: false, ctrlKey: false, metaKey: true })
        ).toEqual({ isShiftClick: false, isCtrlClick: true });
    });

    test('only permits a locked layer to be selected without a modifier', () => {
        expect(
            getCanvasSelectionModifiers({ shiftKey: false, ctrlKey: false, metaKey: false }, true)
        ).toEqual({ isShiftClick: false, isCtrlClick: false });
        expect(
            getCanvasSelectionModifiers({ shiftKey: true, ctrlKey: false, metaKey: false }, true)
        ).toBeNull();
        expect(
            getCanvasSelectionModifiers({ shiftKey: false, ctrlKey: true, metaKey: false }, true)
        ).toBeNull();
    });
});
