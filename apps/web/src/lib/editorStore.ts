import { DEFAULT_STAGE_LAYOUT } from '@repo/db/schema';
import { throttle } from '@tanstack/pacer';
import { create } from 'zustand';

import { EditorEngine } from './editorEngine';
import { wireEngineSubscriptions } from './editorStore.engine';
import { createLayerSlice } from './editorStore.layers';
import { createProjectSlice } from './editorStore.project';
import { createSlideSlice } from './editorStore.slides';
import type { EditorState, SliceHelpers } from './editorStore.types';
import { createUiSlice } from './editorStore.ui';
import type { ConnectionStatus } from './reconnectingWs';

export type { EditorState };
export type EditorStateCreator = ReturnType<ReturnType<typeof create<EditorState>>>;

// ── Module-level allocator state ─────────────────────────────────────────────

let _nextId = 1;
let _nextZIndex = 10;

// ── Store creation ────────────────────────────────────────────────────────────

export const useEditorStore =
    typeof window !== 'undefined' && window.__EDITOR_STORE__
        ? window.__EDITOR_STORE__
        : create<EditorState>()((set, get) => {
              /** Keep the latest update for every layer during the throttle window. */
              const pendingLayerUpdates = new Map<
                  number,
                  { layer: Parameters<SliceHelpers['sendLayerUpdate']>[0]; origin: string }
              >();
              const flushLayerUpdates = throttle(
                  () => {
                      const engine = EditorEngine.getInstance();
                      for (const { layer, origin } of pendingLayerUpdates.values()) {
                          if (!get().layers.has(layer.numericId)) continue;
                          engine.sendJSON({ type: 'upsert_layer', origin, layer });
                      }
                      pendingLayerUpdates.clear();
                  },
                  { wait: 100 }
              );
              const sendLayerUpdate: SliceHelpers['sendLayerUpdate'] = (layer, origin) => {
                  pendingLayerUpdates.set(layer.numericId, { layer, origin });
                  flushLayerUpdates();
              };

              /** Broadcast slide metadata — needs get() for commitId */
              function broadcastSlides(slides: Parameters<SliceHelpers['broadcastSlides']>[0]) {
                  const engine = EditorEngine.getInstance();
                  const commitId = get().commitId;
                  if (!commitId) return;
                  engine.sendJSON({
                      type: 'update_slides',
                      commitId,
                      slides: slides.map((s) => ({ id: s.id, order: s.order, name: s.name }))
                  });
              }

              const helpers: SliceHelpers = {
                  sendLayerUpdate,
                  broadcastSlides,
                  allocateId: () => _nextId++,
                  allocateZIndex: () => _nextZIndex++,
                  setNextId: (n) => {
                      _nextId = n;
                  },
                  setNextZIndex: (n) => {
                      _nextZIndex = n;
                  },
                  peekNextId: () => _nextId,
                  peekNextZIndex: () => _nextZIndex
              };

              return {
                  // ── Initial state ──
                  projectId: null,
                  projectName: null,
                  stageId: null,
                  stageName: null,
                  stageLayout: { ...DEFAULT_STAGE_LAYOUT },
                  parentSaveMessage: null,
                  layers: new Map(),
                  selectedLayerIds: [],
                  hoveredLayerId: null,
                  layerClipboard: null,
                  slides: [],
                  activeSlideId: null,
                  selectedSlides: [],
                  lastSelectedSlide: null,
                  lastSelectedLayerId: null,
                  showSpacePreview: false,
                  showGrid: true,
                  isDrawing: false,
                  isSnapping: false,
                  strokeColor: '#ff0000',
                  strokeWidth: 10,
                  strokeDash: [],
                  shapeFill: '#ff0000',
                  recentColours: [],
                  shapeStroke: '#000000',
                  rectangleCornerRadius: 0,
                  editingTextLayerId: null,
                  boundWallId: null,
                  wallNodeCounts: {},
                  connectionStatus: 'connecting' as ConnectionStatus,
                  commitId: null,
                  loading: true,
                  saveStatus: 'idle',
                  headCommitId: null,
                  insertionCenter: {
                      x: (DEFAULT_STAGE_LAYOUT.columns * DEFAULT_STAGE_LAYOUT.screenWidth) / 2,
                      y: (DEFAULT_STAGE_LAYOUT.rows * DEFAULT_STAGE_LAYOUT.screenHeight) / 2
                  },
                  insertionViewport: {
                      width: DEFAULT_STAGE_LAYOUT.screenWidth,
                      height: DEFAULT_STAGE_LAYOUT.screenHeight
                  },

                  // ── Slices ──
                  ...createProjectSlice(set, get, helpers),
                  ...createLayerSlice(set, get, helpers),
                  ...createSlideSlice(set, get, helpers),
                  ...createUiSlice(set, get, helpers)
              };
          });

if (typeof window !== 'undefined') window.__EDITOR_STORE__ = useEditorStore;

// ── Engine subscriptions ──────────────────────────────────────────────────────

let unsubEngine = () => {};

if (typeof window !== 'undefined') {
    unsubEngine = wireEngineSubscriptions(useEditorStore);
}

// ── HMR ──────────────────────────────────────────────────────────────────────

if (import.meta.hot) {
    import.meta.hot.accept();
    import.meta.hot.dispose((data) => {
        unsubEngine();
        data.editorState = useEditorStore.getState();
        data._nextId = _nextId;
        data._nextZIndex = _nextZIndex;
    });
    if (import.meta.hot.data.editorState) {
        try {
            useEditorStore.setState(import.meta.hot.data.editorState);
            _nextId = import.meta.hot.data._nextId ?? _nextId;
            _nextZIndex = import.meta.hot.data._nextZIndex ?? _nextZIndex;
        } catch (e) {
            console.error('[HMR]: Failed to rehydrate the store:', e);
        }
    }
}
