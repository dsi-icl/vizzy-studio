import { EditorEngine } from './editorEngine';
import type { EditorState, SliceHelpers } from './editorStore.types';
import { fitSizeToViewport, MIN_LAYER_DIMENSION } from './fitSizeToViewport';
import { COLS, ROWS, SCREEN_H, SCREEN_W } from './stageConstants';
import type { Layer, LayerWithEditorState } from './types';

type SliceSet = (
    partial: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)
) => void;
type SliceGet = () => EditorState;

export function createLayerSlice(set: SliceSet, get: SliceGet, helpers: SliceHelpers) {
    return {
        hydrate: (layers: LayerWithEditorState[]) => {
            const engine = EditorEngine.getInstance();
            set((s) => {
                const mergedLayers = layers.map((layer) => {
                    if (layer.type !== 'video') return layer;
                    const existing = s.layers.get(layer.numericId);
                    if (existing?.type === 'video') {
                        return { ...layer, playback: existing.playback };
                    }
                    const livePlayback = engine.getPlayback(layer.numericId);
                    return livePlayback ? { ...layer, playback: livePlayback } : layer;
                });

                helpers.setNextId(
                    mergedLayers.reduce((max, l) => Math.max(max, l.numericId), 0) + 5
                );
                helpers.setNextZIndex(
                    mergedLayers.reduce((max, l) => Math.max(max, l.config.zIndex), 0) + 5
                );

                return { layers: new Map(mergedLayers.map((l) => [l.numericId, l])) };
            });
        },

        upsertLayer: (layer: LayerWithEditorState) =>
            set((s) => {
                const existingLayer = s.layers.get(layer.numericId);
                const isNew = !existingLayer;
                const nextLayer =
                    existingLayer?.type === 'video' && layer.type === 'video'
                        ? { ...layer, playback: existingLayer.playback ?? layer.playback }
                        : layer;

                if (nextLayer.numericId >= helpers.peekNextId())
                    helpers.setNextId(nextLayer.numericId + 5);
                if (isNew) {
                    helpers.setNextZIndex(
                        (nextLayer.config.zIndex ?? 0) >= helpers.peekNextZIndex()
                            ? nextLayer.config.zIndex + 5
                            : helpers.peekNextZIndex() + 5
                    );
                }

                const newLayers = new Map(s.layers);
                newLayers.set(nextLayer.numericId, nextLayer);
                return { layers: newLayers };
            }),

        removeLayer: (numericId: number) => {
            set((s) => {
                const newLayers = new Map(s.layers);
                newLayers.delete(numericId);
                return {
                    layers: newLayers,
                    selectedLayerIds: s.selectedLayerIds.filter((id) => id !== numericId.toString())
                };
            });
            const engine = EditorEngine.getInstance();
            engine.sendJSON({ type: 'delete_layer', numericId });
            get().markDirty();
        },

        updateProgress: (numericId: number, progress: number) =>
            set((s) => {
                const layer = s.layers.get(numericId);
                if (!layer) return s;
                const newLayers = new Map(s.layers);
                newLayers.set(numericId, { ...layer, progress });
                return { layers: newLayers };
            }),

        updateLayerConfig: (numericId: number, config: Layer['config']) => {
            set((s) => {
                const layer = s.layers.get(numericId);
                if (!layer) return s;
                const newLayers = new Map(s.layers);
                newLayers.set(numericId, { ...layer, config });
                return { layers: newLayers };
            });
            get().markDirty();
        },

        toggleLayerVisibility: (numericId: number) => {
            const layer = get().layers.get(numericId);
            if (!layer) return;
            const updatedLayer = {
                ...layer,
                config: { ...layer.config, visible: !layer.config.visible }
            };
            set((s) => {
                const newLayers = new Map(s.layers);
                newLayers.set(numericId, updatedLayer);
                return { layers: newLayers };
            });
            const engine = EditorEngine.getInstance();
            engine.sendJSON({
                type: 'upsert_layer',
                origin: 'editor:toggle_layer_visibility',
                layer: updatedLayer
            });
            get().markDirty();
        },

        deselectAllLayers: () => {
            set(() => ({ selectedLayerIds: [] }));
        },

        toggleLayerSelection: (id: string, isShiftClick: boolean, isCtrlClick: boolean) => {
            const { layers, lastSelectedLayerId } = get();
            const layersArray = Array.from(layers.values());
            if (isShiftClick && lastSelectedLayerId) {
                const lastIndex = layersArray.findIndex(
                    (l) => l.numericId.toString() === lastSelectedLayerId
                );
                const currentIndex = layersArray.findIndex((l) => l.numericId.toString() === id);
                const inBetween = layersArray.slice(
                    Math.min(lastIndex, currentIndex),
                    Math.max(lastIndex, currentIndex) + 1
                );
                set((s) => ({
                    selectedLayerIds: [
                        ...new Set([
                            ...s.selectedLayerIds,
                            ...inBetween.map((l) => l.numericId.toString())
                        ])
                    ]
                }));
            } else if (isCtrlClick) {
                set((s) => {
                    const newSelection = [...s.selectedLayerIds];
                    const index = newSelection.indexOf(id);
                    if (index > -1) {
                        newSelection.splice(index, 1);
                    } else {
                        newSelection.push(id);
                    }
                    return { selectedLayerIds: newSelection };
                });
            } else {
                const selectedLayer = layers.get(parseInt(id));
                const newState: Partial<EditorState> = { selectedLayerIds: [id] };
                if (selectedLayer?.type === 'line') {
                    newState.strokeColor = selectedLayer.strokeColor;
                    newState.strokeDash = selectedLayer.strokeDash;
                    newState.strokeWidth = selectedLayer.strokeWidth;
                }
                if (selectedLayer?.type === 'shape') {
                    newState.strokeColor = selectedLayer.strokeColor;
                    newState.strokeDash = selectedLayer.strokeDash;
                    newState.strokeWidth = selectedLayer.strokeWidth;
                    newState.shapeFill = selectedLayer.fill;
                }
                set(newState);
            }
            set({ lastSelectedLayerId: id });
        },

        deleteSelectedLayer: () => {
            const { selectedLayerIds } = get();
            if (!selectedLayerIds.length) return;
            const numericId = parseInt(selectedLayerIds[0]);
            const engine = EditorEngine.getInstance();
            engine.sendJSON({ type: 'delete_layer', numericId });
            set((s) => {
                const newLayers = new Map(s.layers);
                newLayers.delete(numericId);
                return { layers: newLayers, selectedLayerIds: [] };
            });
            get().markDirty();
        },

        bringToFront: () => {
            const s = get();
            if (!s.selectedLayerIds.length) return;
            const numericId = parseInt(s.selectedLayerIds[0]);
            const layer = s.layers.get(numericId);
            if (!layer) return;

            const nextZIndex = helpers.peekNextZIndex();
            const alreadyOnTop = layer.config.zIndex === nextZIndex;
            const newZIndex = alreadyOnTop ? layer.config.zIndex : nextZIndex;
            if (!alreadyOnTop) helpers.setNextZIndex(nextZIndex + 1);
            const updatedConfig = { ...layer.config, zIndex: newZIndex };
            const updatedLayer = { ...layer, config: updatedConfig };

            const newLayers = new Map(s.layers);
            newLayers.set(numericId, updatedLayer);
            set({ layers: newLayers });

            helpers.sendLayerUpdate(updatedLayer, 'editor:bring_to_front');
            get().markDirty();
        },

        sendToBack: () => {
            const s = get();
            if (!s.selectedLayerIds.length) return;
            const numericId = parseInt(s.selectedLayerIds[0]);
            const layer = s.layers.get(numericId);
            if (!layer) return;

            const minZIndex = Array.from(s.layers.values()).reduce(
                (min, l) => Math.min(min, l.config.zIndex),
                Infinity
            );
            const newZIndex = layer.config.zIndex === minZIndex ? minZIndex : minZIndex - 1;
            const updatedConfig = { ...layer.config, zIndex: newZIndex };
            const updatedLayer = { ...layer, config: updatedConfig };

            const newLayers = new Map(s.layers);
            newLayers.set(numericId, updatedLayer);
            set({ layers: newLayers });

            helpers.sendLayerUpdate(updatedLayer, 'editor:send_to_back');
            get().markDirty();
        },

        alignSelectedLayers: (
            mode: 'left' | 'right' | 'top' | 'bottom' | 'center-horizontal' | 'center-vertical'
        ) => {
            const engine = EditorEngine.getInstance();
            const s = get();
            const selectedNumericIds = s.selectedLayerIds
                .map((id) => Number.parseInt(id, 10))
                .filter((id) => Number.isFinite(id))
                .map((id) => Number(id));
            if (selectedNumericIds.length < 2) return;

            const selectedLayers = selectedNumericIds
                .map((id) => s.layers.get(id))
                .filter((layer): layer is LayerWithEditorState => Boolean(layer));
            if (selectedLayers.length < 2) return;

            const boxes = selectedLayers.map((layer) => {
                const width = Math.max(
                    MIN_LAYER_DIMENSION,
                    Math.abs(layer.config.width * layer.config.scaleX)
                );
                const height = Math.max(
                    MIN_LAYER_DIMENSION,
                    Math.abs(layer.config.height * layer.config.scaleY)
                );
                const left = layer.config.cx - width / 2;
                const right = layer.config.cx + width / 2;
                const top = layer.config.cy - height / 2;
                const bottom = layer.config.cy + height / 2;
                return { layer, width, height, left, right, top, bottom };
            });

            const groupLeft = Math.min(...boxes.map((box) => box.left));
            const groupRight = Math.max(...boxes.map((box) => box.right));
            const groupTop = Math.min(...boxes.map((box) => box.top));
            const groupBottom = Math.max(...boxes.map((box) => box.bottom));
            const groupCenterX = (groupLeft + groupRight) / 2;
            const groupCenterY = (groupTop + groupBottom) / 2;

            const newLayers = new Map(s.layers);
            const updatedLayers: LayerWithEditorState[] = [];

            for (const box of boxes) {
                let newCx = box.layer.config.cx;
                let newCy = box.layer.config.cy;

                if (mode === 'left') {
                    newCx = groupLeft + box.width / 2;
                } else if (mode === 'right') {
                    newCx = groupRight - box.width / 2;
                } else if (mode === 'center-horizontal') {
                    newCx = groupCenterX;
                } else if (mode === 'top') {
                    newCy = groupTop + box.height / 2;
                } else if (mode === 'bottom') {
                    newCy = groupBottom - box.height / 2;
                } else if (mode === 'center-vertical') {
                    newCy = groupCenterY;
                }

                if (newCx === box.layer.config.cx && newCy === box.layer.config.cy) continue;

                const updatedLayer: LayerWithEditorState = {
                    ...box.layer,
                    config: {
                        ...box.layer.config,
                        cx: Math.round(newCx),
                        cy: Math.round(newCy)
                    }
                };
                newLayers.set(updatedLayer.numericId, updatedLayer);
                updatedLayers.push(updatedLayer);
            }

            if (updatedLayers.length === 0) return;

            set({ layers: newLayers });
            for (const updatedLayer of updatedLayers) {
                engine.sendJSON({
                    type: 'upsert_layer',
                    origin: 'editor:align_selected_layers',
                    layer: updatedLayer
                });
            }
            get().markDirty();
        },

        addTextLayer: () => {
            const { allocateId, allocateZIndex, insertionCenter, insertionViewport } = get();
            const numericId = allocateId();
            const zIndex = allocateZIndex();
            const fitted = fitSizeToViewport(
                1920,
                1080,
                insertionViewport.width,
                insertionViewport.height
            );

            const newLayer: LayerWithEditorState = {
                numericId,
                type: 'text',
                config: {
                    cx: insertionCenter.x,
                    cy: insertionCenter.y,
                    width: fitted.width,
                    height: fitted.height,
                    rotation: 0,
                    scaleX: 1,
                    scaleY: 1,
                    zIndex,
                    visible: true
                },
                textHtml: '<p>New Text</p>'
            };

            set((s) => {
                const newLayers = new Map(s.layers);
                newLayers.set(numericId, newLayer);
                return { layers: newLayers, selectedLayerIds: [numericId.toString()] };
            });
            const engine = EditorEngine.getInstance();
            engine.sendJSON({
                type: 'upsert_layer',
                origin: 'editor:add_text_layer',
                layer: newLayer
            });
            get().markDirty();
        },

        addMapLayer: () => {
            const { allocateId, allocateZIndex, insertionCenter, insertionViewport } = get();
            const numericId = allocateId();
            const zIndex = allocateZIndex();
            const fitted = fitSizeToViewport(
                300,
                200,
                insertionViewport.width,
                insertionViewport.height
            );

            const newLayer: LayerWithEditorState = {
                numericId,
                type: 'map',
                config: {
                    cx: insertionCenter.x,
                    cy: insertionCenter.y,
                    width: fitted.width,
                    height: fitted.height,
                    rotation: 0,
                    scaleX: 1,
                    scaleY: 1,
                    zIndex,
                    visible: true
                },
                view: {
                    latitude: 37.7751,
                    longitude: -122.4193,
                    zoom: 11,
                    bearing: 0,
                    pitch: 0
                }
            };

            set((s) => {
                const newLayers = new Map(s.layers);
                newLayers.set(numericId, newLayer);
                return { layers: newLayers, selectedLayerIds: [numericId.toString()] };
            });
            const engine = EditorEngine.getInstance();
            engine.sendJSON({
                type: 'upsert_layer',
                origin: 'editor:add_map_layer',
                layer: newLayer
            });
            get().markDirty();
        },

        addWebLayer: () => {
            const { allocateId, allocateZIndex, insertionCenter, insertionViewport } = get();
            const numericId = allocateId();
            const zIndex = allocateZIndex();
            const fitted = fitSizeToViewport(
                800,
                600,
                insertionViewport.width,
                insertionViewport.height
            );

            const newLayer: LayerWithEditorState = {
                numericId,
                type: 'web',
                config: {
                    cx: insertionCenter.x,
                    cy: insertionCenter.y,
                    width: fitted.width,
                    height: fitted.height,
                    rotation: 0,
                    scaleX: 1,
                    scaleY: 1,
                    zIndex,
                    visible: true
                },
                url: '',
                proxy: false,
                scale: 1
            };

            set((s) => {
                const newLayers = new Map(s.layers);
                newLayers.set(numericId, newLayer);
                return { layers: newLayers, selectedLayerIds: [numericId.toString()] };
            });
            const engine = EditorEngine.getInstance();
            engine.sendJSON({
                type: 'upsert_layer',
                origin: 'editor:add_web_layer',
                layer: newLayer
            });
            get().markDirty();
        },

        addShapeLayer: (shape: 'rectangle' | 'circle') => {
            const {
                allocateId,
                allocateZIndex,
                strokeColor,
                strokeDash,
                strokeWidth,
                insertionCenter,
                insertionViewport
            } = get();
            const numericId = allocateId();
            const zIndex = allocateZIndex();
            const fitted = fitSizeToViewport(
                200,
                200,
                insertionViewport.width,
                insertionViewport.height
            );

            const newLayer: LayerWithEditorState = {
                numericId,
                type: 'shape',
                shape,
                config: {
                    cx: insertionCenter.x,
                    cy: insertionCenter.y,
                    width: fitted.width,
                    height: fitted.height,
                    rotation: 0,
                    scaleX: 1,
                    scaleY: 1,
                    zIndex,
                    visible: true
                },
                fill: 'transparent',
                strokeColor,
                strokeDash,
                strokeWidth
            };

            set((s) => {
                const newLayers = new Map(s.layers);
                newLayers.set(numericId, newLayer);
                return { layers: newLayers, selectedLayerIds: [numericId.toString()] };
            });
            const engine = EditorEngine.getInstance();
            engine.sendJSON({
                type: 'upsert_layer',
                origin: 'editor:add_shape_layer',
                layer: newLayer
            });
            get().markDirty();
        },

        addBackgroundLayer: () => {
            const { layers } = get();
            // Singleton: if one already exists, do nothing (settings accessible via toolbar popover)
            const existing = Array.from(layers.values()).find((l) => l.type === 'background');
            if (existing) return;

            const numericId = helpers.allocateId();
            const wallW = COLS * SCREEN_W;
            const wallH = ROWS * SCREEN_H;

            const newLayer: LayerWithEditorState = {
                numericId,
                type: 'background',
                config: {
                    cx: wallW / 2,
                    cy: wallH / 2,
                    width: wallW,
                    height: wallH,
                    rotation: 0,
                    scaleX: 1,
                    scaleY: 1,
                    zIndex: 0,
                    visible: true
                },
                backgroundType: 'i-pattern',
                backgroundColor: '#0a0a14',
                atmosphereColor: '#1a1a3a',
                motifColor1: '#2a1a4a',
                motifColor2: '#0a2a3a',
                noiseSeed: 0,
                speedFactor: 1
            };

            set((s) => {
                const newLayers = new Map(s.layers);
                newLayers.set(numericId, newLayer);
                return { layers: newLayers };
            });
            const engine = EditorEngine.getInstance();
            engine.sendJSON({
                type: 'upsert_layer',
                origin: 'editor:add_background_layer',
                layer: newLayer
            });
            get().markDirty();
        },

        addLineLayer: (line: Array<number>) => {
            const { allocateId, allocateZIndex, strokeColor, strokeDash, strokeWidth } = get();
            const numericId = allocateId();
            const zIndex = allocateZIndex();

            let minX: number | null = null;
            let minY: number | null = null;
            let maxX: number | null = null;
            let maxY: number | null = null;
            for (let i = 0; i < line.length; i += 2) {
                const x = line[i];
                const y = line[i + 1];
                if (minX === null || minY === null || maxX === null || maxY === null) {
                    minX = x;
                    minY = y;
                    maxX = x;
                    maxY = y;
                }
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
            if (minX === null || minY === null || maxX === null || maxY === null) return null;
            const rawWidth = maxX - minX;
            const rawHeight = maxY - minY;
            const width = Math.max(MIN_LAYER_DIMENSION, Math.round(rawWidth));
            const height = Math.max(MIN_LAYER_DIMENSION, Math.round(rawHeight));
            const cx = Math.round(minX + rawWidth / 2);
            const cy = Math.round(minY + rawHeight / 2);

            const newLayer: LayerWithEditorState = {
                numericId,
                type: 'line',
                config: {
                    cx,
                    cy,
                    width,
                    height,
                    rotation: 0,
                    scaleX: 1,
                    scaleY: 1,
                    zIndex,
                    visible: true
                },
                line: line.map((p) => Math.round(p)),
                strokeColor,
                strokeWidth,
                strokeDash
            };
            set((s) => {
                const newLayers = new Map(s.layers);
                newLayers.set(numericId, newLayer);
                return { layers: newLayers, selectedLayerIds: [numericId.toString()] };
            });
            const engine = EditorEngine.getInstance();
            engine.sendJSON({
                type: 'upsert_layer',
                origin: 'editor:add_line_layer',
                layer: newLayer
            });
            get().markDirty();
        },

        clearStage: () => {
            const engine = EditorEngine.getInstance();
            engine.sendJSON({ type: 'clear_stage' });
            set({ layers: new Map(), selectedLayerIds: [] });
            get().markDirty();
        },

        reboot: () => {
            const engine = EditorEngine.getInstance();
            engine.sendJSON({ type: 'reboot' });
            set({ selectedLayerIds: [] });
        },

        reorderLayers: (layers: LayerWithEditorState[]) => {
            const engine = EditorEngine.getInstance();
            const updatedLayers = layers.map((layer, index) => ({
                ...layer,
                config: { ...layer.config, zIndex: index }
            }));

            set({ layers: new Map(updatedLayers.map((l) => [l.numericId, l])) });

            updatedLayers.forEach((layer) => {
                engine.sendJSON({
                    type: 'upsert_layer',
                    origin: 'editor:reorder_layers',
                    layer
                });
            });
            get().markDirty();
        }
    };
}
