import { EditorEngine } from './editorEngine';
import type { EditorState, SliceHelpers } from './editorStore.types';

type SliceSet = (
    partial: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)
) => void;
type SliceGet = () => EditorState;

export function createUiSlice(set: SliceSet, get: SliceGet, helpers: SliceHelpers) {
    return {
        allocateId: helpers.allocateId,
        allocateZIndex: helpers.allocateZIndex,

        setStrokeColor: (strokeColor: string) => {
            set((s) => {
                const newState: Partial<EditorState> = { strokeColor };
                if (s.selectedLayerIds.length > 0) {
                    const numericId = parseInt(s.selectedLayerIds[0]);
                    const layer = s.layers.get(numericId);
                    if (layer && (layer.type === 'line' || layer.type === 'shape')) {
                        const newLayers = new Map(s.layers);
                        newLayers.set(numericId, { ...layer, strokeColor });
                        newState.layers = newLayers;
                    }
                    if (layer) {
                        helpers.sendLayerUpdate(layer, 'editor:set_stroke_color');
                    }
                }
                return newState;
            });
            get().markDirty();
        },

        setStrokeWidth: (strokeWidth: number) => {
            set((s) => {
                const newState: Partial<EditorState> = { strokeWidth };
                if (s.selectedLayerIds.length > 0) {
                    const numericId = parseInt(s.selectedLayerIds[0]);
                    const layer = s.layers.get(numericId);
                    if (layer) {
                        if (layer.type === 'line' || layer.type === 'shape') {
                            const updatedLayer = { ...layer, strokeWidth };
                            const newLayers = new Map(s.layers);
                            newLayers.set(numericId, updatedLayer);
                            newState.layers = newLayers;
                            helpers.sendLayerUpdate(updatedLayer, 'editor:set_stroke_width');
                        }
                    }
                }
                return newState;
            });
            get().markDirty();
        },

        setStrokeDash: (strokeDash: number[]) => {
            set((s) => {
                const newState: Partial<EditorState> = { strokeDash };
                if (s.selectedLayerIds.length > 0) {
                    const numericId = parseInt(s.selectedLayerIds[0]);
                    const layer = s.layers.get(numericId);
                    if (layer) {
                        if (layer.type === 'line' || layer.type === 'shape') {
                            const updatedLayer = { ...layer, strokeDash };
                            const newLayers = new Map(s.layers);
                            newLayers.set(numericId, updatedLayer);
                            newState.layers = newLayers;
                            helpers.sendLayerUpdate(updatedLayer, 'editor:set_stroke_dash');
                        }
                    }
                }
                return newState;
            });
            get().markDirty();
        },

        setShapeFill: (fill: string) => {
            set((s) => {
                const newState: Partial<EditorState> = { shapeFill: fill };
                if (s.selectedLayerIds.length > 0) {
                    const numericId = parseInt(s.selectedLayerIds[0]);
                    const layer = s.layers.get(numericId);
                    if (layer) {
                        const updatedLayer = { ...layer, fill };
                        const newLayers = new Map(s.layers);
                        newLayers.set(numericId, updatedLayer);
                        newState.layers = newLayers;
                        helpers.sendLayerUpdate(updatedLayer, 'editor:set_shape_fill');
                    }
                }
                return newState;
            });
            get().markDirty();
        },

        setInsertionCenter: (x: number, y: number) =>
            set((s) => {
                if (s.insertionCenter.x === x && s.insertionCenter.y === y) return s;
                return { insertionCenter: { x, y } };
            }),

        setInsertionViewport: (width: number, height: number) =>
            set((s) => {
                const nextWidth = Math.max(1, Math.round(width));
                const nextHeight = Math.max(1, Math.round(height));
                if (
                    s.insertionViewport.width === nextWidth &&
                    s.insertionViewport.height === nextHeight
                ) {
                    return s;
                }
                return { insertionViewport: { width: nextWidth, height: nextHeight } };
            }),

        markDirty: () => {
            const { saveStatus } = get();
            if (saveStatus !== 'saving') {
                set({ saveStatus: 'dirty' });
                const engine = EditorEngine.getInstance();
                engine.sendDirty();
            }
        },

        saveProject: (message: string) => {
            set({ saveStatus: 'saving' });
            const engine = EditorEngine.getInstance();
            engine.requestSave(message);
        },

        toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),

        toggleDrawing: () =>
            set((s) => ({
                isDrawing: !s.isDrawing,
                isErasing: false,
                selectedLayerIds: !s.isDrawing ? [] : s.selectedLayerIds
            })),

        setEraserWidth: (eraserWidth: number) => set({ eraserWidth }),

        toggleErasing: () =>
            set((s) => ({
                isErasing: !s.isErasing,
                isDrawing: false
            })),

        toggleSnapping: () => set((s) => ({ isSnapping: !s.isSnapping })),

        toggleSpacePreview: () => set((s) => ({ showSpacePreview: !s.showSpacePreview })),

        startTextEditing: (numericId: number) => {
            set({ editingTextLayerId: numericId });
        },

        stopTextEditing: () => set({ editingTextLayerId: null })
    };
}
