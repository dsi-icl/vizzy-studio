import type { LayerWithEditorState } from './types';

interface SelectionModifierState {
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
}

interface ResolveSelectedLayersOptions {
    excludeLocked?: boolean;
}

export const resolveSelectedLayers = (
    layers: Map<number, LayerWithEditorState>,
    selectedLayerIds: string[],
    { excludeLocked = true }: ResolveSelectedLayersOptions = {}
): LayerWithEditorState[] =>
    selectedLayerIds
        .map((id) => layers.get(Number.parseInt(id, 10)))
        .filter((layer): layer is LayerWithEditorState => {
            if (!layer) return false;
            if (excludeLocked && layer.config.locked) return false;
            return true;
        });

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
