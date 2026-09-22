import { create } from 'zustand';

// Transient editor images: never persisted or sent over the collaboration bus.
// Keys include the project, commit, slide and layer to isolate reused layer IDs.
export const useMapPreviewStore = create<Record<string, HTMLCanvasElement | undefined>>(() => ({}));

const MAX_PREVIEW_SIZE = 256;

export function updateMapPreview(key: string, source: HTMLCanvasElement) {
    if (!source.width || !source.height) return;

    const scale = Math.min(1, MAX_PREVIEW_SIZE / Math.max(source.width, source.height));
    const preview = document.createElement('canvas');
    preview.width = Math.max(1, Math.round(source.width * scale));
    preview.height = Math.max(1, Math.round(source.height * scale));
    const context = preview.getContext('2d');
    if (!context) return;

    // Copy synchronously during MapLibre's idle event, before its WebGL buffer
    // is cleared. A fresh small canvas also tells Konva to redraw the image.
    context.drawImage(source, 0, 0, preview.width, preview.height);
    useMapPreviewStore.setState({ [key]: preview });
}

export function removeMapPreview(key: string) {
    useMapPreviewStore.setState((state) => {
        const next = { ...state };
        delete next[key];
        return next;
    }, true);
}
