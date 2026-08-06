interface SelectionModifierState {
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
}

/**
 * Shift-click on the canvas is additive/toggling, not the contiguous range
 * selection used by the Layers list. Konva has already resolved one top hit.
 */
export const getCanvasSelectionModifiers = (
    { shiftKey, ctrlKey, metaKey }: SelectionModifierState,
    isLocked = false
) => {
    const hasSelectionModifier = shiftKey || ctrlKey || metaKey;
    if (isLocked && hasSelectionModifier) return null;

    return {
        isShiftClick: false,
        isCtrlClick: hasSelectionModifier
    };
};
