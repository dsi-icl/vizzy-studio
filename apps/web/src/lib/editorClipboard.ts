import type { LayerWithEditorState } from './types';

export const LAYER_PASTE_OFFSET = 20;

export function snapshotCopyableLayers(
    layers: Iterable<LayerWithEditorState>
): LayerWithEditorState[] {
    return Array.from(layers)
        .filter((layer) => layer.type !== 'background')
        .sort((a, b) => a.config.zIndex - b.config.zIndex)
        .map((layer) => structuredClone(layer));
}

export function createPastedLayers(
    copiedLayers: Iterable<LayerWithEditorState>,
    pasteNumber: number,
    allocateId: () => number,
    allocateZIndex: () => number
): LayerWithEditorState[] {
    const offset = LAYER_PASTE_OFFSET * Math.max(1, pasteNumber);

    return Array.from(copiedLayers).map((source) => {
        const layer = structuredClone(source);
        const pasted: LayerWithEditorState = {
            ...layer,
            numericId: allocateId(),
            config: {
                ...layer.config,
                cx: layer.config.cx + offset,
                cy: layer.config.cy + offset,
                zIndex: allocateZIndex()
            }
        };

        delete pasted.progress;

        if (pasted.type === 'line') {
            pasted.line = pasted.line.map((coordinate) => coordinate + offset);
        } else if (pasted.type === 'text') {
        } else if (pasted.type === 'video') {
            pasted.playback = {
                status: 'paused',
                anchorMediaTime: 0,
                anchorServerTime: 0
            };
            pasted.rvfcActive = false;
        }

        return pasted;
    });
}
