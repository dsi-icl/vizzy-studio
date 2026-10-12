import type { LayerWithEditorState } from './types';

export interface LayerPatch {
    numericId: number;
    before: LayerWithEditorState | null;
    after: LayerWithEditorState | null;
}

export function layersEqual(
    a: LayerWithEditorState | null,
    b: LayerWithEditorState | null
): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return JSON.stringify(a) === JSON.stringify(b);
}

const TEXT_CONTENT_FIELDS = ['textHtml', 'textState', 'textFormat'] as const;

export function withTextContentOf(
    target: LayerWithEditorState,
    source: LayerWithEditorState
): LayerWithEditorState {
    if (target.type !== 'text' || source.type !== 'text') return target;

    const merged = { ...target };
    for (const field of TEXT_CONTENT_FIELDS) {
        if (field in source) (merged as Record<string, unknown>)[field] = source[field];
        else delete (merged as Record<string, unknown>)[field];
    }
    return merged;
}

export function makeLayerPatch(
    numericId: number,
    before: LayerWithEditorState | null,
    after: LayerWithEditorState | null
): LayerPatch | null {
    const pinnedBefore = before && after ? withTextContentOf(before, after) : before;
    if (layersEqual(pinnedBefore, after)) return null;
    return { numericId, before: pinnedBefore, after };
}

export function pruneSelection(
    selection: string[],
    layers: Map<number, LayerWithEditorState>
): string[] {
    return selection.filter((id) => layers.has(Number.parseInt(id, 10)));
}

export function applyPatches(
    layers: Map<number, LayerWithEditorState>,
    patches: LayerPatch[]
): Map<number, LayerWithEditorState> {
    const next = new Map(layers);
    for (const patch of patches) {
        if (patch.after === null) next.delete(patch.numericId);
        else next.set(patch.numericId, patch.after);
    }
    return next;
}
