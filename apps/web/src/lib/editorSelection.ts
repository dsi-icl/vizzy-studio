import type { LayerWithEditorState } from './types';

interface SelectionModifierState {
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
}

interface ResolveSelectedLayersOptions {
    excludeLocked?: boolean;
    excludeLines?: boolean;
}

/**
 * Resolve the selected id strings to their layers, in selection order, dropping ids
 * that no longer exist plus any the options exclude. Node-structure agnostic (keyed
 * by numericId), so composite layers like video resolve the same as any other.
 */
export const resolveSelectedLayers = (
    layers: Map<number, LayerWithEditorState>,
    selectedLayerIds: string[],
    { excludeLocked = true, excludeLines = false }: ResolveSelectedLayersOptions = {}
): LayerWithEditorState[] =>
    selectedLayerIds
        .map((id) => layers.get(Number.parseInt(id, 10)))
        .filter((layer): layer is LayerWithEditorState => {
            if (!layer) return false;
            if (excludeLocked && layer.config.locked) return false;
            if (excludeLines && layer.type === 'line') return false;
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
