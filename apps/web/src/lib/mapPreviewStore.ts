import type { Map as MapLibreMap } from 'maplibre-gl';
import { create } from 'zustand';

// Transient editor images: never persisted or sent over the collaboration bus.
// Keys include the project, commit, slide and layer to isolate reused layer IDs.
export const useMapPreviewStore = create<Record<string, HTMLCanvasElement | undefined>>(() => ({}));

// Keep editor map frames separate from the small overview thumbnails. The
// canvas object stays stable so MapLibre frames do not rerender React.
export const useMapCanvasStore = create<Record<string, { canvas: HTMLCanvasElement } | undefined>>(
    () => ({})
);

const MAX_PREVIEW_SIZE = 256;
const mapCanvasListeners = new Map<string, Set<() => void>>();

export function subscribeMapCanvasFrame(key: string, listener: () => void) {
    const listeners = mapCanvasListeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    mapCanvasListeners.set(key, listeners);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) mapCanvasListeners.delete(key);
    };
}

// The live MapLibre refs must survive a module refresh alongside the editor.
const previewMaps: Map<string, MapLibreMap> =
    import.meta.hot?.data.previewMaps ?? new Map<string, MapLibreMap>();
if (import.meta.hot) {
    import.meta.hot.dispose((data) => {
        data.previewMaps = previewMaps;
    });
}

export function setMapPreviewMap(key: string, map: MapLibreMap | null) {
    if (map) previewMaps.set(key, map);
    else previewMaps.delete(key);
}

export function getMapPreviewMap(key: string) {
    return previewMaps.get(key) ?? null;
}

export function updateMapCanvas(key: string, source: HTMLCanvasElement) {
    if (!source.width || !source.height) return;

    const existingFrame = useMapCanvasStore.getState()[key];
    const canvas = existingFrame?.canvas ?? document.createElement('canvas');
    if (canvas.width !== source.width) canvas.width = source.width;
    if (canvas.height !== source.height) canvas.height = source.height;
    const context = canvas.getContext('2d');
    if (!context) return;

    // Copy every MapLibre frame before its WebGL drawing buffer is cleared.
    // A stable canvas lets Konva redraw without rerendering React each time.
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0);
    if (!existingFrame) useMapCanvasStore.setState({ [key]: { canvas } });
    mapCanvasListeners.get(key)?.forEach((listener) => listener());
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
    previewMaps.delete(key);
    const mapCanvas = useMapCanvasStore.getState()[key]?.canvas;
    if (mapCanvas) mapCanvas.width = mapCanvas.height = 1;
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
