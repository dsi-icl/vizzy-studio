import { create } from 'zustand';

// Transient editor images: never persisted or sent over the collaboration bus.
// Keys include the project, commit, slide and layer to isolate reused layer IDs.
export const useMapPreviewStore = create<Record<string, HTMLCanvasElement | undefined>>(() => ({}));

// Keep full-resolution map frames separate from the small overview thumbnails.
// Reuse the canvas; a new frame object tells the editor image to redraw it.
export const useMapCanvasStore = create<Record<string, { canvas: HTMLCanvasElement } | undefined>>(
    () => ({})
);

const MAX_PREVIEW_SIZE = 256;

export function updateMapCanvas(key: string, source: HTMLCanvasElement) {
    if (!source.width || !source.height) return;

    const canvas = useMapCanvasStore.getState()[key]?.canvas ?? document.createElement('canvas');
    if (canvas.width !== source.width) canvas.width = source.width;
    if (canvas.height !== source.height) canvas.height = source.height;
    const context = canvas.getContext('2d');
    if (!context) return;

    // Copy during MapLibre's render event, before its WebGL drawing buffer is
    // cleared. Konva can then paint the retained frame in normal layer order.
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0);
    useMapCanvasStore.setState({ [key]: { canvas } });
}

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
    useMapCanvasStore.setState((state) => {
        const next = { ...state };
        delete next[key];
        return next;
    }, true);
    useMapPreviewStore.setState((state) => {
        const next = { ...state };
        delete next[key];
        return next;
    }, true);
}
