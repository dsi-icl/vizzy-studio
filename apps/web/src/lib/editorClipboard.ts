import type { LayerWithEditorState } from './types';

export const LAYER_PASTE_OFFSET = 20;

export function snapshotCopyableLayers(
    layers: Iterable<LayerWithEditorState>
): LayerWithEditorState[] {
    return Array.from(layers)
        .filter((layer) => layer.type !== 'background' && !layer.isUploading)
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
        delete pasted.isUploading;

        if (pasted.type === 'line') {
            pasted.line = pasted.line.map((coordinate) => coordinate + offset);
        } else if (pasted.type === 'text') {
            // Nothing to reset. textHtml/textState/textFormat are *content* and
            // must carry over, so the copy seeds from structured state instead
            // of re-deriving from HTML. Fields identifying the source's Yjs
            // document are a different matter and must not be carried — strip
            // those here, never the content.
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
