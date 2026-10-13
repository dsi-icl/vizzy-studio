import { EditorEngine } from './editorEngine';
import type { EditorState, SliceHelpers } from './editorStore.types';
import { DEFAULT_SHAPE_EFFECT_SETTINGS } from './shapeEffects';
import type { ShapeEffect } from './types';
import { ShapeEffectSettingsSchema } from './types';
import type { ShapeEffectSettings } from './types';

type SliceSet = (
    partial: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)
) => void;
type SliceGet = () => EditorState;

export function createUiSlice(set: SliceSet, get: SliceGet, helpers: SliceHelpers) {
    return {
        allocateId: helpers.allocateId,
        allocateZIndex: helpers.allocateZIndex,

        setHoveredLayerId: (hoveredLayerId: string | null) =>
            set((s) => (s.hoveredLayerId === hoveredLayerId ? s : { hoveredLayerId })),

        setStrokeColor: (strokeColor: string) => {
            set((s) => {
                const newState: Partial<EditorState> = { strokeColor };
                if (s.selectedLayerIds.length > 0) {
                    const numericId = parseInt(s.selectedLayerIds[0]);
                    const layer = s.layers.get(numericId);
                    if (layer && (layer.type === 'line' || layer.type === 'shape')) {
                        const updatedLayer = { ...layer, strokeColor };
                        const newLayers = new Map(s.layers);
                        newLayers.set(numericId, updatedLayer);
                        newState.layers = newLayers;
                        helpers.sendLayerUpdate(updatedLayer, 'editor:set_stroke_color');
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

        setShapeEffect: (effect: ShapeEffect) => {
            const selectedLayerIds = get().selectedLayerIds;
            if (selectedLayerIds.length !== 1) return;
            const numericId = Number.parseInt(selectedLayerIds[0], 10);
            const layer = get().layers.get(numericId);
            if (
                (layer?.type !== 'shape' && layer?.type !== 'line') ||
                (layer.type === 'line' && effect !== 'none' && effect !== 'travel') ||
                (layer.effect ?? 'none') === effect
            )
                return;

            const effectSettings =
                effect === 'none'
                    ? layer.effectSettings
                    : {
                          ...DEFAULT_SHAPE_EFFECT_SETTINGS,
                          ...layer.effectSettings,
                          playMode: effect === 'reveal' ? ('once' as const) : ('loop' as const),
                          startAtMs:
                              effect === 'reveal'
                                  ? EditorEngine.getInstance().getServerTime()
                                  : undefined
                      };
            const updatedLayer = {
                ...layer,
                effect,
                effectSettings
            };
            set((s) => {
                const layers = new Map(s.layers);
                layers.set(numericId, updatedLayer);
                return { layers };
            });
            helpers.sendLayerUpdate(updatedLayer, 'editor:set_shape_effect');
            get().markDirty();
        },

        setShapeEffectSettings: (settings: Partial<ShapeEffectSettings>) => {
            const selectedLayerIds = get().selectedLayerIds;
            if (selectedLayerIds.length !== 1) return;
            const numericId = Number.parseInt(selectedLayerIds[0], 10);
            const layer = get().layers.get(numericId);
            if (layer?.type !== 'shape' && layer?.type !== 'line') return;
            const startAtMs =
                settings.playMode === 'loop'
                    ? undefined
                    : (settings.startAtMs ??
                      (settings.playMode === 'once' && layer.effectSettings?.playMode !== 'once'
                          ? EditorEngine.getInstance().getServerTime()
                          : layer.effectSettings?.startAtMs));
            const effectSettings = ShapeEffectSettingsSchema.parse({
                ...DEFAULT_SHAPE_EFFECT_SETTINGS,
                ...layer.effectSettings,
                ...settings,
                startAtMs
            });
            if (
                layer.effectSettings &&
                layer.effectSettings.speed === effectSettings.speed &&
                layer.effectSettings.intensity === effectSettings.intensity &&
                layer.effectSettings.direction === effectSettings.direction &&
                layer.effectSettings.ringCount === effectSettings.ringCount &&
                layer.effectSettings.segmentLength === effectSettings.segmentLength &&
                layer.effectSettings.playMode === effectSettings.playMode &&
                layer.effectSettings.phaseOffsetMs === effectSettings.phaseOffsetMs &&
                layer.effectSettings.accentColor === effectSettings.accentColor &&
                layer.effectSettings.startAtMs === effectSettings.startAtMs
            ) {
                return;
            }
            const updatedLayer = { ...layer, effectSettings };
            set((s) => {
                const layers = new Map(s.layers);
                layers.set(numericId, updatedLayer);
                return { layers };
            });
            helpers.sendLayerUpdate(updatedLayer, 'editor:set_shape_effect_settings');
            get().markDirty();
        },

        setRectangleCornerRadius: (radius: number) => {
            if (!Number.isFinite(radius)) return;
            const cornerRadius = Math.max(0, radius);
            let didUpdateLayer = false;
            set((s) => {
                const newState: Partial<EditorState> = { rectangleCornerRadius: cornerRadius };
                if (s.selectedLayerIds.length === 1) {
                    const numericId = parseInt(s.selectedLayerIds[0]);
                    const layer = s.layers.get(numericId);
                    if (layer?.type === 'shape' && layer.shape === 'rectangle') {
                        const updatedLayer = { ...layer, cornerRadius };
                        const newLayers = new Map(s.layers);
                        newLayers.set(numericId, updatedLayer);
                        newState.layers = newLayers;
                        didUpdateLayer = true;
                        helpers.sendLayerUpdate(updatedLayer, 'editor:set_rectangle_corner_radius');
                    }
                }
                return newState;
            });
            if (didUpdateLayer) get().markDirty();
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
                selectedLayerIds: !s.isDrawing ? [] : s.selectedLayerIds
            })),

        toggleSnapping: () => set((s) => ({ isSnapping: !s.isSnapping })),

        toggleSpacePreview: () => set((s) => ({ showSpacePreview: !s.showSpacePreview })),

        startTextEditing: (numericId: number) => {
            set({ editingTextLayerId: numericId });
        },

        stopTextEditing: () => set({ editingTextLayerId: null })
    };
}
