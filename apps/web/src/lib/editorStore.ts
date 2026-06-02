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

export const ERASER_MIN_WIDTH = 10;
export const ERASER_MAX_WIDTH = 1000;
export const ERASER_WHEEL_STEP = 10;

export function clampEraserWidth(width: number): number {
    return Math.max(ERASER_MIN_WIDTH, Math.min(ERASER_MAX_WIDTH, Math.round(width)));
}

// ── Module-level allocator state ─────────────────────────────────────────────

let _nextId = 1;
let _nextZIndex = 10;

// ── Store creation ────────────────────────────────────────────────────────────

export const useEditorStore =
    typeof window !== 'undefined' && window.__EDITOR_STORE__
        ? window.__EDITOR_STORE__
        : create<EditorState>()((set, get) => {
              /** Throttled layer broadcast — one instance, shared across all slices */
              const sendLayerUpdate = throttle(
                  (layer: Parameters<SliceHelpers['sendLayerUpdate']>[0], origin: string) => {
                      const engine = EditorEngine.getInstance();
                      engine.sendJSON({ type: 'upsert_layer', origin, layer });
                  },
                  { wait: 100 }
              );

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
                  parentSaveMessage: null,
                  layers: new Map(),
                  selectedLayerIds: [],
                  slides: [],
                  activeSlideId: null,
                  selectedSlides: [],
                  lastSelectedSlide: null,
                  lastSelectedLayerId: null,
                  showSpacePreview: false,
                  showGrid: true,
                  isDrawing: false,
                  isErasing: false,
                  eraserWidth: 70,
                  isSnapping: true,
                  strokeColor: '#ff0000',
                  strokeWidth: 10,
                  strokeDash: [],
                  shapeFill: '#ff0000',
                  shapeStroke: '#000000',
                  editingTextLayerId: null,
                  boundWallId: null,
                  wallNodeCounts: {},
                  connectionStatus: 'connecting' as ConnectionStatus,
                  commitId: null,
                  loading: true,
                  saveStatus: 'idle',
                  headCommitId: null,
                  insertionCenter: { x: 1920 / 2, y: 1080 / 2 },
                  insertionViewport: { width: 1920, height: 1080 },

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
