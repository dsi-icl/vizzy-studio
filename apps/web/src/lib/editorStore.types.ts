import type { ConnectionStatus } from './reconnectingWs';
import type { Layer, LayerWithEditorState, Slide } from './types';

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface EditorState {
    // ── State ──
    projectId: string | null;
    projectName: string | null;
    parentSaveMessage: string | null;
    layers: Map<number, LayerWithEditorState>;
    selectedLayerIds: string[];
    slides: Slide[];
    activeSlideId: string | null;
    selectedSlides: string[];
    lastSelectedSlide: string | null;
    lastSelectedLayerId: string | null;
    showSpacePreview: boolean;
    showGrid: boolean;
    isDrawing: boolean;
    isSnapping: boolean;
    strokeColor: string;
    strokeWidth: number;
    strokeDash: number[];
    shapeFill: string;
    shapeStroke: string;
    editingTextLayerId: number | null;
    isErasing: boolean;
    eraserWidth: number;

    // ── Wall binding ──
    boundWallId: string | null;
    wallNodeCounts: Record<string, number>;

    // ── Connection state ──
    connectionStatus: ConnectionStatus;

    // ── Commit tracking ──
    commitId: string | null;

    // ── Save pipeline state ──
    loading: boolean;
    saveStatus: SaveStatus;
    headCommitId: string | null;
    insertionCenter: { x: number; y: number };
    insertionViewport: { width: number; height: number };

    // ── Actions ──
    loadProject: (projectId: string, commitId: string, slideId: string) => Promise<void>;
    switchSlide: (slideId: string) => Promise<void>;
    hydrate: (layers: LayerWithEditorState[]) => void;
    upsertLayer: (layer: LayerWithEditorState) => void;
    removeLayer: (numericId: number) => void;
    updateProgress: (numericId: number, progress: number) => void;
    updateLayerConfig: (numericId: number, config: Layer['config']) => void;
    toggleLayerVisibility: (numericId: number) => void;
    deselectAllLayers: () => void;
    toggleLayerSelection: (id: string, isShiftClick: boolean, isCtrlClick: boolean) => void;
    deleteSelectedLayer: () => void;
    bringToFront: () => void;
    sendToBack: () => void;
    alignSelectedLayers: (
        mode: 'left' | 'right' | 'top' | 'bottom' | 'center-horizontal' | 'center-vertical'
    ) => void;
    addTextLayer: () => void;
    addMapLayer: () => void;
    addShapeLayer: (shape: 'rectangle' | 'circle') => void;
    addWebLayer: () => void;
    addBackgroundLayer: () => void;
    addLineLayer: (line: Array<number>) => void;
    clearStage: () => void;
    reboot: () => void;
    reorderLayers: (layers: LayerWithEditorState[]) => void;
    setSlides: (slides: Slide[]) => void;
    setActiveSlideId: (id: string | null) => void;
    setSelectedSlides: (ids: string[]) => void;
    setStrokeColor: (color: string) => void;
    setStrokeWidth: (width: number) => void;
    setStrokeDash: (dash: number[]) => void;
    setShapeFill: (fill: string) => void;
    setInsertionCenter: (x: number, y: number) => void;
    setInsertionViewport: (width: number, height: number) => void;
    markDirty: () => void;
    saveProject: (message: string) => void;
    allocateId: () => number;
    allocateZIndex: () => number;
    addSlide: () => void;
    copySlide: (slide: Slide) => Promise<void>;
    deleteSlide: (slideId: string) => Promise<void>;
    renameSlide: (slideId: string, name: string) => void;
    reorderSlides: (slides: Slide[]) => void;
    toggleSlideSelection: (id: string, isShiftClick: boolean, isCtrlClick: boolean) => void;
    toggleGrid: () => void;
    toggleDrawing: () => void;
    toggleSnapping: () => void;
    toggleSpacePreview: () => void;
    startTextEditing: (numericId: number) => void;
    stopTextEditing: () => void;
    toggleErasing: () => void;
    setEraserWidth: (width: number) => void;
    eraseSelectedLineLayer: (eraserPath: number[]) => void;
}

/** Helpers threaded from editorStore.ts into each slice factory. */
export interface SliceHelpers {
    /** Throttled upsert_layer broadcast — defined once at module level. */
    sendLayerUpdate: (layer: LayerWithEditorState, origin: string) => void;
    /** Broadcast slide metadata to bus — needs get() for commitId. */
    broadcastSlides: (slides: Slide[]) => void;
    /** ID counter access — module-level state owned by editorStore.ts. */
    allocateId: () => number;
    allocateZIndex: () => number;
    setNextId: (n: number) => void;
    setNextZIndex: (n: number) => void;
    peekNextId: () => number;
    peekNextZIndex: () => number;
}
