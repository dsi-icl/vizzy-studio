import Uppy from '@uppy/core';
import Tus from '@uppy/tus';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    useLayoutEffect,
    type DragEvent
} from 'react';
import {
    Stage,
    FastLayer,
    Layer as KonvaLayer,
    Transformer,
    Rect,
    Line,
    Circle
} from 'react-konva';
import { toast } from 'sonner';

import { getAssetDragMimeType, type AssetLibraryAsset } from '~/components/AssetLibrary';
import { EditorToolbar } from '~/components/EditorToolbar';
import { KonvaBackgroundLayer } from '~/components/KonvaBackgroundLayer';
import { KonvaStaticImage } from '~/components/KonvaStaticImage';
import { KonvaTextLayer } from '~/components/KonvaTextLayer';
import { KonvaVideo } from '~/components/KonvaVideo';
import { KonvaWebLayer } from '~/components/KonvaWebLayer';
import { EditorEngine } from '~/lib/editorEngine';
import { getDOGridLines } from '~/lib/editorHelpers';
import { useEditorStore } from '~/lib/editorStore';
import { fitSizeToViewport, MIN_LAYER_DIMENSION } from '~/lib/fitSizeToViewport';
import { isFontAsset } from '~/lib/mediaUtils';
import { COLS, ROWS, SCREEN_H, SCREEN_W, SNAP_GRID } from '~/lib/stageConstants';
import {
    getAngle,
    getAngleDelta,
    getDistance,
    isCardinalRotation,
    normalizeRotationToQuadrant,
    snapToGrid,
    touchToStagePoint
} from '~/lib/stageGeometry';
import { scrubInsecureTusResumeEntries } from '~/lib/tusClient';
import type { Layer, LayerWithEditorState } from '~/lib/types';
import { $createUploadToken } from '~/server/projects.fns';

import { SlatePreview } from './SlatePreview';

const DEFAULT_STAGE_SCALE_FACTOR = 0.15;
const EDGE_SCROLL_ZONE_PX = 96;
const EDGE_SCROLL_MAX_STEP_PX = 24;
const DRAW_PATH_MAX_POINT_GAP = 0.5;

function lerp(start: number, end: number, t: number): number {
    return start + (end - start) * t;
}

function appendInterpolatedPathPoint(path: number[], x: number, y: number): number[] {
    if (path.length < 2) return path.concat([x, y]);

    const lastX = path[path.length - 2];
    const lastY = path[path.length - 1];
    const distance = Math.hypot(x - lastX, y - lastY);
    if (distance === 0) return path;

    const steps = Math.ceil(distance / DRAW_PATH_MAX_POINT_GAP);
    const nextPath = [...path];
    for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        nextPath.push(lerp(lastX, x, t), lerp(lastY, y, t));
    }

    return nextPath;
}

export function EditorSlate() {
    const engine = useMemo(
        () => (typeof window !== 'undefined' ? EditorEngine.getInstance() : null),
        []
    );
    const layers = useEditorStore((s) => s.layers);
    // TODO This probably requires some attention: The Konva Stage only selects one item at a time, but we use the multi-select layer sorter here.
    const selectedLayerIds = useEditorStore((s) => s.selectedLayerIds);
    const toggleLayerSelection = useEditorStore((s) => s.toggleLayerSelection);
    const deselectAllLayers = useEditorStore((s) => s.deselectAllLayers);
    const startTextEditing = useEditorStore((s) => s.startTextEditing);
    const showGrid = useEditorStore((s) => s.showGrid);
    const isDrawing = useEditorStore((s) => s.isDrawing);
    const isSnapping = useEditorStore((s) => s.isSnapping);
    const addLineLayer = useEditorStore((s) => s.addLineLayer);
    const strokeColor = useEditorStore((s) => s.strokeColor);
    const strokeDash = useEditorStore((s) => s.strokeDash);
    const strokeWidth = useEditorStore((s) => s.strokeWidth);
    const isErasing = useEditorStore((s) => s.isErasing);
    const eraserWidth = useEditorStore((s) => s.eraserWidth);
    const eraseSelectedLineLayer = useEditorStore((s) => s.eraseSelectedLineLayer);

    const [stageScaleFactor, setStageScaleFactor] = useState(DEFAULT_STAGE_SCALE_FACTOR);
    const [isPinching, setIsPinching] = useState(false);
    const [currentLine, setCurrentLine] = useState<Array<number>>([]);
    const [currentEraserPath, setCurrentEraserPath] = useState<Array<number>>([]);
    const editingTextLayerId = useEditorStore((s) => s.editingTextLayerId);
    const lastX = useRef(0);
    const stageLastX = useRef(0);

    const stageSlot = useRef<HTMLDivElement>(null);
    const stageWrapper = useRef<HTMLDivElement>(null);
    const stageInstance = useRef<Konva.Stage>(null);
    const trRef = useRef<Konva.Transformer>(null);
    const lastCenter = useRef<{ x: number; y: number } | null>(null);
    const lastDist = useRef<number | null>(null);
    const lastAngle = useRef<number | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const sortedLayers = useMemo(
        () => Array.from(layers.values()).sort((a, b) => a.config.zIndex - b.config.zIndex),
        [layers]
    );
    const backgroundLayer = useMemo(
        () => sortedLayers.find((layer) => layer.type === 'background') ?? null,
        [sortedLayers]
    );
    const foregroundLayers = useMemo(
        () => sortedLayers.filter((layer) => layer.type !== 'background'),
        [sortedLayers]
    );
    const selectedLayerIdSet = useMemo(() => new Set(selectedLayerIds), [selectedLayerIds]);
    const selectedOutlineLayers = useMemo(
        () =>
            selectedLayerIds
                .map((id) => layers.get(Number.parseInt(id, 10)))
                .filter((layer): layer is LayerWithEditorState => Boolean(layer)),
        [layers, selectedLayerIds]
    );

    const autoScrollStageDuringDrag = useCallback((evt: Event) => {
        const slot = stageSlot.current;
        if (!slot) return;

        let clientX: number | null = null;
        let clientY: number | null = null;

        if (evt instanceof TouchEvent) {
            const touch = evt.touches[0] ?? evt.changedTouches?.[0];
            if (!touch) return;
            clientX = touch.clientX;
            clientY = touch.clientY;
        } else if ('clientX' in evt && 'clientY' in evt) {
            const pointerEvt = evt as MouseEvent;
            clientX = pointerEvt.clientX;
            clientY = pointerEvt.clientY;
        }

        if (clientX === null || clientY === null) return;

        const rect = slot.getBoundingClientRect();

        const edgeStep = (distanceIntoEdge: number) =>
            Math.round(
                Math.min(
                    EDGE_SCROLL_MAX_STEP_PX,
                    (distanceIntoEdge / EDGE_SCROLL_ZONE_PX) * EDGE_SCROLL_MAX_STEP_PX
                )
            );

        let dx = 0;
        if (clientX < rect.left + EDGE_SCROLL_ZONE_PX) {
            dx = -edgeStep(rect.left + EDGE_SCROLL_ZONE_PX - clientX);
        } else if (clientX > rect.right - EDGE_SCROLL_ZONE_PX) {
            dx = edgeStep(clientX - (rect.right - EDGE_SCROLL_ZONE_PX));
        }

        let dy = 0;
        if (clientY < rect.top + EDGE_SCROLL_ZONE_PX) {
            dy = -edgeStep(rect.top + EDGE_SCROLL_ZONE_PX - clientY);
        } else if (clientY > rect.bottom - EDGE_SCROLL_ZONE_PX) {
            dy = edgeStep(clientY - (rect.bottom - EDGE_SCROLL_ZONE_PX));
        }

        if (dx !== 0) {
            const maxLeft = Math.max(0, slot.scrollWidth - slot.clientWidth);
            slot.scrollLeft = Math.max(0, Math.min(maxLeft, slot.scrollLeft + dx));
        }
        if (dy !== 0) {
            const maxTop = Math.max(0, slot.scrollHeight - slot.clientHeight);
            slot.scrollTop = Math.max(0, Math.min(maxTop, slot.scrollTop + dy));
        }
    }, []);

    const addDroppedAssetAsLayer = useCallback(
        async (asset: AssetLibraryAsset, dropPoint: { x: number; y: number }) => {
            if (!engine) return;
            if (isFontAsset(asset)) return;

            const isVideo =
                asset.mimeType?.startsWith('video/') ||
                /\.(mp4|mov|webm|avi|mkv)$/i.test(asset.name) ||
                /\.(mp4|mov|webm|avi|mkv)$/i.test(asset.url);
            const isImage =
                asset.mimeType?.startsWith('image/') ||
                /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(asset.name) ||
                /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(asset.url);

            if (!isVideo && !isImage) return;

            const store = useEditorStore.getState();
            const numericId = store.allocateId();
            const zIndex = store.allocateZIndex();

            let mediaWidth = 800;
            let mediaHeight = 600;
            let duration = 0;

            if (isVideo) {
                try {
                    const vid = document.createElement('video');
                    vid.muted = true;
                    vid.playsInline = true;
                    vid.crossOrigin = 'anonymous';
                    vid.src = `/api/assets/${asset.url}`;
                    await new Promise<void>((resolve, reject) => {
                        vid.onloadeddata = () => resolve();
                        vid.onerror = () => reject(new Error('Failed to load video'));
                    });
                    mediaWidth = vid.videoWidth || mediaWidth;
                    mediaHeight = vid.videoHeight || mediaHeight;
                    duration = vid.duration || 0;
                    vid.removeAttribute('src');
                    vid.load();
                } catch {
                    // Keep defaults.
                }
            } else {
                try {
                    const img = new window.Image();
                    img.crossOrigin = 'anonymous';
                    img.src = `/api/assets/${asset.url}`;
                    await new Promise<void>((resolve) => {
                        img.onload = () => resolve();
                        img.onerror = () => resolve();
                    });
                    mediaWidth = img.naturalWidth || mediaWidth;
                    mediaHeight = img.naturalHeight || mediaHeight;
                } catch {
                    // Keep defaults.
                }
            }

            const fitted = fitSizeToViewport(
                mediaWidth,
                mediaHeight,
                store.insertionViewport.width,
                store.insertionViewport.height
            );

            const config: Layer['config'] = {
                cx: dropPoint.x,
                cy: dropPoint.y,
                width: fitted.width,
                height: fitted.height,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                zIndex,
                visible: true
            };

            const defaultPlayback: Extract<Layer, { type: 'video' }>['playback'] = {
                status: 'paused',
                anchorMediaTime: 0,
                anchorServerTime: engine.getServerTime()
            };

            const layerBase = {
                numericId,
                url: `/api/assets/${asset.url}`,
                config,
                isUploading: false,
                progress: 100
            };

            const layer: LayerWithEditorState = isVideo
                ? {
                      type: 'video',
                      playback: defaultPlayback,
                      rvfcActive: false,
                      duration,
                      loop: true,
                      blurhash: asset.blurhash ?? '',
                      ...layerBase
                  }
                : {
                      type: 'image',
                      blurhash: asset.blurhash ?? '',
                      ...layerBase
                  };

            store.upsertLayer(layer);
            store.toggleLayerSelection(numericId.toString(), false, false);

            engine.sendJSON({
                type: 'upsert_layer',
                origin: 'editor:asset_library_drop',
                layer
            });
            store.markDirty();
        },
        [engine]
    );

    const handleStageDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
        if (e.dataTransfer.types.includes(getAssetDragMimeType())) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        }
    }, []);

    const handleStageDrop = useCallback(
        async (e: DragEvent<HTMLDivElement>) => {
            const raw = e.dataTransfer.getData(getAssetDragMimeType());
            if (!raw) return;
            e.preventDefault();

            let asset: AssetLibraryAsset | null = null;
            try {
                asset = JSON.parse(raw) as AssetLibraryAsset;
            } catch {
                return;
            }
            if (!asset) return;

            const slot = stageSlot.current;
            if (!slot) return;
            const rect = slot.getBoundingClientRect();
            const scale = Math.max(stageScaleFactor, 0.001);
            const x = (slot.scrollLeft + (e.clientX - rect.left)) / scale;
            const y = (slot.scrollTop + (e.clientY - rect.top)) / scale;

            await addDroppedAssetAsLayer(asset, { x, y });
        },
        [addDroppedAssetAsLayer, stageScaleFactor]
    );

    const syncInsertionCenter = useCallback(() => {
        const slot = stageSlot.current;
        if (!slot) return;
        const scale = Math.max(stageScaleFactor, 0.001);
        const centerX = (slot.scrollLeft + slot.clientWidth / 2) / scale;
        const centerY = (slot.scrollTop + slot.clientHeight / 2) / scale;
        const viewportWidth = slot.clientWidth / scale;
        const viewportHeight = slot.clientHeight / scale;
        const store = useEditorStore.getState();
        store.setInsertionCenter(centerX, centerY);
        store.setInsertionViewport(viewportWidth, viewportHeight);
    }, [stageScaleFactor]);

    useLayoutEffect(() => {
        const slot = stageSlot.current;
        if (!slot) return;

        const logicalHeight = SCREEN_H * ROWS;
        const minScale = 0.01;

        const recomputeScale = () => {
            const availableHeight = slot.clientHeight;
            if (availableHeight <= 0) return;
            const maxVerticalScale = Math.max(minScale, availableHeight / logicalHeight);
            setStageScaleFactor((prev) =>
                Math.abs(prev - maxVerticalScale) < 0.0005 ? prev : maxVerticalScale
            );
        };

        recomputeScale();

        const observer = new ResizeObserver(recomputeScale);
        observer.observe(slot);

        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const slot = stageSlot.current;
        if (!slot) return;

        let rafId: number | null = null;

        const scheduleSync = () => {
            if (rafId !== null) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
                syncInsertionCenter();
                rafId = null;
            });
        };

        scheduleSync();
        slot.addEventListener('scroll', scheduleSync, { passive: true });
        window.addEventListener('resize', scheduleSync);

        return () => {
            slot.removeEventListener('scroll', scheduleSync);
            window.removeEventListener('resize', scheduleSync);
            if (rafId !== null) cancelAnimationFrame(rafId);
        };
    }, [syncInsertionCenter]);

    // Shadow ref — keeps binary-updated positions for the fast-path.
    // Binary updates mutate this directly (no React re-render).
    const layersRef = useRef<Map<number, LayerWithEditorState>>(new Map());
    useEffect(() => {
        layersRef.current = layers;
    }, [layers]);

    useEffect(() => {
        if (!engine) return;
        if (window.__EDITOR_RELOADING__) {
            setTimeout(() => {
                engine.sendJSON({ type: 'rehydrate_please' });
            }, 500);
            window.__EDITOR_RELOADING__ = false;
        }
    }, [engine]);

    // JSON messages are handled by the store wiring in editorStore.ts.
    // Only the binary path stays here because it directly manipulates Konva nodes.
    useEffect(() => {
        if (!engine) return;
        const unsubscribeBinary = engine.subscribeToBinary(
            (id, cx, cy, width, height, scaleX, scaleY, rotation) => {
                if (trRef.current) {
                    const stage = trRef.current.getStage();
                    const node = stage?.findOne(`#${id}`);
                    const currentSelectedIds = useEditorStore.getState().selectedLayerIds;
                    const isActivelyTransforming = trRef.current.isTransforming();

                    if (node && !node.isDragging() && !isActivelyTransforming && !isPinching) {
                        node.x(cx);
                        node.y(cy);
                        node.width(width);
                        node.height(height);
                        node.offsetX(width / 2);
                        node.offsetY(height / 2);
                        node.scaleX(scaleX);
                        node.scaleY(scaleY);
                        node.rotation(rotation);
                        if (currentSelectedIds[0] === id.toString()) trRef.current.forceUpdate();
                        node.getLayer()?.batchDraw();
                    }

                    // Shadow state — so React reads accurate coords on next render
                    const shadowLayer = layersRef.current.get(id);
                    if (shadowLayer) {
                        shadowLayer.config.cx = cx;
                        shadowLayer.config.cy = cy;
                        shadowLayer.config.width = width;
                        shadowLayer.config.height = height;
                        shadowLayer.config.scaleX = scaleX;
                        shadowLayer.config.scaleY = scaleY;
                        shadowLayer.config.rotation = rotation;

                        // Text reflow must follow binary width/height updates (local + remote),
                        // so we sync store config for text layers from the fast path.
                        if (shadowLayer.type === 'text') {
                            useEditorStore.setState((s) => {
                                const current = s.layers.get(id);
                                if (!current || current.type !== 'text') return s;
                                const cfg = current.config;
                                if (
                                    cfg.cx === cx &&
                                    cfg.cy === cy &&
                                    cfg.width === width &&
                                    cfg.height === height &&
                                    cfg.scaleX === scaleX &&
                                    cfg.scaleY === scaleY &&
                                    cfg.rotation === rotation
                                ) {
                                    return s;
                                }
                                const newLayers = new Map(s.layers);
                                newLayers.set(id, {
                                    ...current,
                                    config: {
                                        ...cfg,
                                        cx,
                                        cy,
                                        width,
                                        height,
                                        scaleX,
                                        scaleY,
                                        rotation
                                    }
                                });
                                return { layers: newLayers };
                            });
                        }
                    }
                }
            }
        );

        return () => unsubscribeBinary();
    }, [engine, isPinching]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const isEditingInput =
                target instanceof HTMLElement &&
                (target.closest('input, textarea, select') !== null || target.isContentEditable);
            if (isEditingInput) return;
            if (editingTextLayerId !== null) return;
            const store = useEditorStore.getState();
            if (!store.selectedLayerIds.length) return;

            if (e.key === 'Delete') store.deleteSelectedLayer();
            if (e.key === 'Escape') store.deselectAllLayers();
            const currentSelected = store.layers.get(parseInt(store.selectedLayerIds[0]));
            if (!currentSelected) return;

            const newLayerState = { ...currentSelected, config: { ...currentSelected.config } };
            if (e.key === 'ArrowLeft') {
                if (e.shiftKey)
                    newLayerState.config.rotation = Math.round(newLayerState.config.rotation - 1);
                else newLayerState.config.cx -= isSnapping ? SNAP_GRID : 10;
            }
            if (e.key === 'ArrowRight') {
                if (e.shiftKey)
                    newLayerState.config.rotation = Math.round(newLayerState.config.rotation + 1);
                else newLayerState.config.cx += isSnapping ? SNAP_GRID : 10;
            }
            if (e.key === 'ArrowUp') newLayerState.config.cy -= isSnapping ? SNAP_GRID : 10;
            if (e.key === 'ArrowDown') newLayerState.config.cy += isSnapping ? SNAP_GRID : 10;
            store.updateLayerConfig(currentSelected.numericId, newLayerState.config);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [editingTextLayerId, isSnapping]);

    // ── Upload handler (stays here — complex async + file APIs) ───────────
    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!engine) return;
        const file = e.target.files?.[0];
        if (!file) return;

        const isImage = file.type.startsWith('image/');
        const localUrl = URL.createObjectURL(file);

        let mediaWidth = 800;
        let mediaHeight = 600;
        let duration = 0;
        let previewDataUrl = localUrl;

        // 1. Read dimensions and extract a poster frame locally
        if (isImage) {
            const img = new window.Image();
            const p = new Promise((resolve) => {
                img.onload = resolve;
                img.onerror = resolve;
            });
            if (!localUrl.startsWith('blob:') && !localUrl.startsWith('data:')) {
                img.crossOrigin = 'anonymous';
            }
            img.src = localUrl;
            await p;
            mediaWidth = img.width;
            mediaHeight = img.height;
        } else {
            const tempVid = document.createElement('video');
            tempVid.muted = true;
            tempVid.playsInline = true;
            const p = new Promise((resolve) => (tempVid.onloadeddata = resolve));
            if (!localUrl.startsWith('blob:') && !localUrl.startsWith('data:')) {
                tempVid.crossOrigin = 'anonymous';
            }
            tempVid.src = localUrl;
            await p;
            mediaWidth = tempVid.videoWidth;
            mediaHeight = tempVid.videoHeight;
            duration = tempVid.duration;

            tempVid.currentTime = Math.min(0.5, duration / 2);
            await new Promise((resolve) => {
                tempVid.onseeked = () => {
                    requestAnimationFrame(() => requestAnimationFrame(resolve));
                };
            });

            const canvas = document.createElement('canvas');
            canvas.width = mediaWidth;
            canvas.height = mediaHeight;
            canvas.getContext('2d')?.drawImage(tempVid, 0, 0, mediaWidth, mediaHeight);
            previewDataUrl = canvas.toDataURL('image/jpeg', 0.8);

            tempVid.removeAttribute('src');
            tempVid.load();
        }

        const store = useEditorStore.getState();
        const numericId = store.allocateId();
        const zIndex = store.allocateZIndex();
        const { x: insertionX, y: insertionY } = store.insertionCenter;
        const fitted = fitSizeToViewport(
            mediaWidth,
            mediaHeight,
            store.insertionViewport.width,
            store.insertionViewport.height
        );

        const positions = {
            cx: insertionX,
            cy: insertionY,
            width: fitted.width,
            height: fitted.height,
            rotation: 0,
            scaleX: 1,
            scaleY: 1
        };

        const config: Layer['config'] = { ...positions, zIndex, visible: true };

        const defaultPlayback: Extract<Layer, { type: 'video' }>['playback'] = {
            status: 'paused',
            anchorMediaTime: 0,
            anchorServerTime: engine.getServerTime()
        };

        // 2. OPTIMISTIC UPDATE — mount immediately
        const optimisticLayer = {
            numericId,
            type: isImage ? 'image' : 'video',
            url: previewDataUrl,
            playback: defaultPlayback,
            config,
            isUploading: true,
            progress: 0,
            rvfcActive: false,
            duration,
            loop: true
        } as LayerWithEditorState;

        store.upsertLayer(optimisticLayer);
        store.toggleLayerSelection(numericId.toString(), false, false);

        // 3. Background tus upload with metadata for server-side post-processing
        const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
        const currentProjectId = useEditorStore.getState().projectId;
        if (!currentProjectId) {
            useEditorStore.getState().removeLayer(numericId);
            toast.error('Upload failed: project context is missing');
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }

        let uploadToken: string;
        try {
            const tokenResult = await $createUploadToken({ data: { projectId: currentProjectId } });
            uploadToken = tokenResult.token;
        } catch (err) {
            console.error('Upload token creation failure', err);
            useEditorStore.getState().removeLayer(numericId);
            toast.error(err instanceof Error ? err.message : 'Upload failed to initialize');
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }
        scrubInsecureTusResumeEntries();

        const uppy = new Uppy().use(Tus, {
            endpoint: '/api/uploads/',
            chunkSize: 5 * 1024 * 1024,
            // Avoid reusing stale absolute upload URLs from previous sessions
            // (e.g. cached http:// links after moving behind HTTPS).
            storeFingerprintForResuming: false,
            removeFingerprintOnSuccess: true
        });

        try {
            uppy.addFile({
                name: file.name,
                type: file.type,
                data: file,
                meta: {
                    numericId: numericId.toString(),
                    duration: duration.toString(),
                    projectId: currentProjectId,
                    uploadToken
                }
            });
        } catch (err) {
            console.error('Upload add-file failure', err);
            useEditorStore.getState().removeLayer(numericId);
            uppy.destroy();
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }

        uppy.on('upload-success', (_file, response) => {
            // Derive asset URL from the tus upload ID
            const uploadId = response.uploadURL?.split('/').pop() ?? '';
            const assetFilename = isImage ? `${uploadId}${ext}` : `${uploadId}.mp4`;
            const assetUrl = `${window.location.origin}/api/assets/${assetFilename}`;
            const stillImageFilename = isImage ? undefined : `${uploadId}.jpg`;

            // Grab freshest config from shadow state (user may have moved the preview)
            const freshestLayer = layersRef.current.get(numericId) || optimisticLayer;

            // 4. Lock it in with preserved transformations
            const finalizedLayer = {
                ...freshestLayer,
                url: assetUrl,
                isUploading: false,
                ...(stillImageFilename ? { stillImage: stillImageFilename } : {})
            };

            useEditorStore.getState().upsertLayer(finalizedLayer);
            engine.setPlayback(numericId, defaultPlayback);

            engine.sendJSON({
                type: 'upsert_layer',
                origin: 'editor:handle_upload',
                layer: {
                    numericId,
                    type: finalizedLayer.type,
                    playback: defaultPlayback,
                    url: assetUrl,
                    config: freshestLayer.config
                } as LayerWithEditorState
            });
            URL.revokeObjectURL(localUrl);

            // Asset record is created server-side in onUploadFinish
            uppy.destroy();
        });

        uppy.on('error', (err) => {
            console.error('Upload failure', err);
            useEditorStore.getState().removeLayer(numericId);
            toast.error(err instanceof Error ? err.message : 'Upload failed');
            uppy.destroy();
        });

        uppy.upload();
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleTransform = (
        e: Pick<KonvaEventObject<Event>, 'target' | 'evt'>,
        numericId: number
    ) => {
        const node = e.target as Konva.Shape;
        const layer = layersRef.current.get(numericId);
        if (!node || !layer) return;

        const isTransformerActive = trRef.current?.isTransforming() ?? false;
        if (node.isDragging() || isTransformerActive) {
            autoScrollStageDuringDrag(e.evt);
        }

        const activeAnchor = trRef.current?.getActiveAnchor() ?? null;
        node.setAttr('lastActiveAnchor', activeAnchor);

        if (layer.type === 'text') {
            const textAnchor = activeAnchor ?? '';
            const isHorizontalEdge = textAnchor === 'middle-left' || textAnchor === 'middle-right';
            const isVerticalEdge = textAnchor === 'top-center' || textAnchor === 'bottom-center';
            const isReflowEdge = isHorizontalEdge || isVerticalEdge;
            const mode: 'reflow' | 'corner' = isReflowEdge ? 'reflow' : 'corner';
            node.setAttr('textTransformMode', mode);

            if (mode === 'reflow') {
                const oldAbsTransform = node.getAbsoluteTransform().copy();
                const originWorld = oldAbsTransform.point({ x: 0, y: 0 });
                const oldScaleX = layer.config.scaleX || 1;
                const oldScaleY = layer.config.scaleY || 1;
                let nextWidth = node.width();
                let nextHeight = node.height();

                if (isHorizontalEdge) {
                    const effectiveScaleX = node.scaleX();
                    nextWidth = Math.max(
                        MIN_LAYER_DIMENSION,
                        (node.width() * effectiveScaleX) / oldScaleX
                    );
                }
                if (isVerticalEdge) {
                    const effectiveScaleY = node.scaleY();
                    nextHeight = Math.max(
                        MIN_LAYER_DIMENSION,
                        (node.height() * effectiveScaleY) / oldScaleY
                    );
                }

                node.width(nextWidth);
                node.height(nextHeight);
                node.offsetX(nextWidth / 2);
                node.offsetY(nextHeight / 2);
                node.scaleX(oldScaleX);
                node.scaleY(oldScaleY);

                const newAbsTransform = node.getAbsoluteTransform().copy();
                const newOriginWorld = newAbsTransform.point({ x: 0, y: 0 });
                const dx = originWorld.x - newOriginWorld.x;
                const dy = originWorld.y - newOriginWorld.y;
                const parent = node.getParent();
                if (parent) {
                    const parentTransform = parent.getAbsoluteTransform().copy();
                    parentTransform.invert();
                    const localDelta = parentTransform.point({ x: dx, y: dy });
                    node.position({ x: node.x() + localDelta.x, y: node.y() + localDelta.y });
                }

                // TODO See if this can be further optimised so that we can propagate to the other editors too
                // It is s goo compromise for now
                // Immediate local mirror update for live reflow while dragging.
                // We still broadcast binary updates so all peers stay in sync.
                const mirroredConfig: Layer['config'] = {
                    ...layer.config,
                    cx: Math.round(node.x()),
                    cy: Math.round(node.y()),
                    width: Math.max(MIN_LAYER_DIMENSION, Math.round(node.width())),
                    height: Math.max(MIN_LAYER_DIMENSION, Math.round(node.height())),
                    scaleX: oldScaleX,
                    scaleY: oldScaleY,
                    rotation: Math.round(node.rotation())
                };
                layer.config = mirroredConfig;
                useEditorStore.setState((s) => {
                    const current = s.layers.get(numericId);
                    if (!current || current.type !== 'text') return s;
                    const newLayers = new Map(s.layers);
                    newLayers.set(numericId, { ...current, config: mirroredConfig });
                    return { layers: newLayers };
                });
            }

            node.getLayer()?.batchDraw();
        }

        // Scale baking for image/map layers
        if (
            layer.type === 'image' ||
            layer.type === 'map' ||
            layer.type === 'shape' ||
            layer.type === 'web'
        ) {
            const scaleX = node.scaleX();
            const scaleY = node.scaleY();

            const oldAbsTransform = node.getAbsoluteTransform().copy();
            const originWorld = oldAbsTransform.point({ x: 0, y: 0 });

            const newWidth = node.width() * scaleX;
            const newHeight = node.height() * scaleY;
            node.width(newWidth);
            node.height(newHeight);
            node.scale({ x: 1, y: 1 });
            node.offsetX(newWidth / 2);
            node.offsetY(newHeight / 2);

            const newAbsTransform = node.getAbsoluteTransform().copy();
            const newOriginWorld = newAbsTransform.point({ x: 0, y: 0 });

            const dx = originWorld.x - newOriginWorld.x;
            const dy = originWorld.y - newOriginWorld.y;

            const parent = node.getParent();
            if (parent) {
                const parentTransform = parent.getAbsoluteTransform().copy();
                parentTransform.invert();
                const localDelta = parentTransform.point({ x: dx, y: dy });
                node.position({ x: node.x() + localDelta.x, y: node.y() + localDelta.y });
            } else {
                node.position({ x: node.x(), y: node.y() });
            }
        }

        engine?.broadcastBinaryMove(
            numericId,
            Math.round(node.x()),
            Math.round(node.y()),
            Math.round(node.width()),
            Math.round(node.height()),
            Math.round(node.scaleX() * 1000) / 1000,
            Math.round(node.scaleY() * 1000) / 1000,
            Math.round(node.rotation())
        );
    };

    const handleTransformEnd = useCallback(
        (e: Pick<KonvaEventObject<Event>, 'target' | 'type'>, numericId: number) => {
            if (!engine) return;
            const node = e.target as Konva.Shape;

            // Must use layersRef — has binary-updated positions
            const layerToUpdate = layersRef.current.get(numericId);
            if (!layerToUpdate) return;
            const textMode = node.getAttr('textTransformMode') as 'reflow' | 'corner' | undefined;

            if (isSnapping && layerToUpdate.type !== 'line') {
                const rotation = normalizeRotationToQuadrant(node.rotation());

                // Drag end: snap a stable visual reference (top-left of AABB) to the grid.
                if (e.type === 'dragend') {
                    const left = node.x() - node.width() / 2;
                    const top = node.y() - node.height() / 2;
                    const snappedLeft = snapToGrid(left, SNAP_GRID);
                    const snappedTop = snapToGrid(top, SNAP_GRID);
                    node.position({
                        x: snappedLeft + node.width() / 2,
                        y: snappedTop + node.height() / 2
                    });
                }

                // Transform end: snap only moved edges and keep pinned edges/corner stable.
                if (e.type === 'transformend' && isCardinalRotation(rotation)) {
                    const anchor = node.getAttr('lastActiveAnchor') as string | null;
                    const left = node.x() - node.width() / 2;
                    const right = node.x() + node.width() / 2;
                    const top = node.y() - node.height() / 2;
                    const bottom = node.y() + node.height() / 2;

                    let nextLeft = left;
                    let nextRight = right;
                    let nextTop = top;
                    let nextBottom = bottom;

                    if (anchor?.includes('left')) {
                        // Moving the left edge -> keep right edge pinned
                        nextLeft = snapToGrid(left, SNAP_GRID);
                    } else if (anchor?.includes('right')) {
                        // Moving the right edge -> keep left edge pinned
                        nextRight = snapToGrid(right, SNAP_GRID);
                    } else {
                        // No horizontal handle (e.g. top-center/bottom-center): snap by position
                        const snappedLeft = snapToGrid(left, SNAP_GRID);
                        const deltaX = snappedLeft - left;
                        nextLeft += deltaX;
                        nextRight += deltaX;
                    }

                    if (anchor?.includes('top')) {
                        // Moving the top edge -> keep bottom edge pinned
                        nextTop = snapToGrid(top, SNAP_GRID);
                    } else if (anchor?.includes('bottom')) {
                        // Moving the bottom edge -> keep top edge pinned
                        nextBottom = snapToGrid(bottom, SNAP_GRID);
                    } else {
                        // No vertical handle (e.g. middle-left/middle-right): snap by position
                        const snappedTop = snapToGrid(top, SNAP_GRID);
                        const deltaY = snappedTop - top;
                        nextTop += deltaY;
                        nextBottom += deltaY;
                    }

                    const nextWidth = Math.max(MIN_LAYER_DIMENSION, nextRight - nextLeft);
                    const nextHeight = Math.max(MIN_LAYER_DIMENSION, nextBottom - nextTop);

                    node.width(nextWidth);
                    node.height(nextHeight);
                    node.offsetX(nextWidth / 2);
                    node.offsetY(nextHeight / 2);
                    node.position({
                        x: nextLeft + nextWidth / 2,
                        y: nextTop + nextHeight / 2
                    });
                }
                node.getLayer()?.batchDraw();
            }

            const updatedConfig: Layer['config'] = {
                ...layerToUpdate.config,
                cx: Math.round(node.x()),
                cy: Math.round(node.y()),
                width: Math.round(node.width()),
                height: Math.round(node.height()),
                scaleX:
                    layerToUpdate.type === 'text' && textMode === 'reflow'
                        ? layerToUpdate.config.scaleX
                        : Math.round(node.scaleX() * 1000) / 1000,
                scaleY:
                    layerToUpdate.type === 'text' && textMode === 'reflow'
                        ? layerToUpdate.config.scaleY
                        : Math.round(node.scaleY() * 1000) / 1000,
                rotation: Math.round(node.rotation())
            };

            if (layerToUpdate.type === 'text' && textMode === 'reflow') {
                node.scaleX(updatedConfig.scaleX);
                node.scaleY(updatedConfig.scaleY);
            }

            const prevConfig = layerToUpdate.config;
            const configChanged =
                prevConfig.cx !== updatedConfig.cx ||
                prevConfig.cy !== updatedConfig.cy ||
                prevConfig.width !== updatedConfig.width ||
                prevConfig.height !== updatedConfig.height ||
                prevConfig.scaleX !== updatedConfig.scaleX ||
                prevConfig.scaleY !== updatedConfig.scaleY ||
                prevConfig.rotation !== updatedConfig.rotation;
            if (!configChanged) {
                node.setAttr('textTransformMode', undefined);
                node.setAttr('lastActiveAnchor', undefined);
                return;
            }

            // Always broadcast the final authoritative transform after local snapping/baking.
            // This prevents walls from remaining on the last pre-snap binary frame.
            engine.broadcastBinaryMove(
                numericId,
                updatedConfig.cx,
                updatedConfig.cy,
                updatedConfig.width,
                updatedConfig.height,
                updatedConfig.scaleX,
                updatedConfig.scaleY,
                updatedConfig.rotation
            );

            // Shadow mutation for binary fast-path
            layerToUpdate.config = updatedConfig;
            node.setAttr('textTransformMode', undefined);
            node.setAttr('lastActiveAnchor', undefined);

            const store = useEditorStore.getState();
            store.updateLayerConfig(numericId, updatedConfig);

            // Sync to server
            engine.sendJSON({
                type: 'upsert_layer',
                origin: 'editor:handle_transform_end',
                layer: { ...layerToUpdate, config: updatedConfig }
            });
        },
        [engine, isSnapping]
    );

    const flushNodeState = (idToFlush: string) => {
        if (!trRef.current) return;
        const stage = trRef.current.getStage();
        const node = stage?.findOne<Konva.Shape>(`#${idToFlush}`);
        if (node)
            handleTransformEnd(
                { target: node, type: 'transformend' } as Pick<
                    KonvaEventObject<Event>,
                    'target' | 'type'
                >,
                parseInt(idToFlush)
            );
    };

    const handleStageInteractionStart = (e: KonvaEventObject<TouchEvent | MouseEvent>) => {
        const currentSelectedIds = useEditorStore.getState().selectedLayerIds;
        const isTwoFingerTouch = e.evt instanceof TouchEvent && e.evt.touches?.length === 2;
        if (isDrawing && isTwoFingerTouch) {
            setCurrentLine([]);
        }
        if (isErasing) {
            if (isTwoFingerTouch) setCurrentEraserPath([]);
            return;
        }
        if (
            (e.evt instanceof TouchEvent && e.evt.touches?.length === 1) ||
            (e.evt instanceof MouseEvent && e.type === 'mousedown' && e.evt.button === 0)
        ) {
            const clickedOnEmpty = e.target === e.target.getStage();
            if (clickedOnEmpty && currentSelectedIds.length) {
                flushNodeState(currentSelectedIds[0]);
                deselectAllLayers();
            }
            if (!isDrawing) return;
        }
        if (
            e.evt instanceof TouchEvent &&
            e.evt.touches?.length === 2 &&
            currentSelectedIds.length > 0
        ) {
            flushNodeState(currentSelectedIds[0]);
            setIsPinching(true);
            const stage = trRef.current?.getStage();
            if (!stage) return;
            const t1 = e.evt.touches[0];
            const t2 = e.evt.touches[1];
            const p1 = touchToStagePoint(stage, t1);
            const p2 = touchToStagePoint(stage, t2);
            lastDist.current = getDistance(p1, p2);
            lastAngle.current = getAngle(p1, p2);
            lastCenter.current = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
            return;
        }
        if (e.evt instanceof TouchEvent && e.evt.touches?.length === 2) {
            lastX.current = e.evt.touches[0].clientX;
            if (stageSlot.current) {
                stageLastX.current = stageSlot.current.scrollLeft;
            }
            return;
        }
    };

    const handleTouchMove = (e: KonvaEventObject<TouchEvent | MouseEvent>) => {
        e.evt.preventDefault();
        const currentSelectedIds = useEditorStore.getState().selectedLayerIds;
        const isTwoFingerTouch = e.evt instanceof TouchEvent && e.evt.touches.length >= 2;
        if (isErasing) {
            if (!isTwoFingerTouch) {
                if (e.evt instanceof MouseEvent && e.evt.buttons !== 1) return;
                const stage = e.target.getStage();
                const point = stage?.getPointerPosition();
                if (!point) return;
                setCurrentEraserPath((path) =>
                    appendInterpolatedPathPoint(
                        path,
                        point.x / stageScaleFactor,
                        point.y / stageScaleFactor
                    )
                );
                return;
            } else {
                setCurrentEraserPath([]);
            }
        }
        if (isDrawing) {
            if (!isTwoFingerTouch) {
                if (e.evt instanceof MouseEvent && e.evt.buttons !== 1) return;
                const stage = e.target.getStage();
                const point = stage?.getPointerPosition();
                if (!point) return;
                setCurrentLine((line) =>
                    appendInterpolatedPathPoint(
                        line,
                        point.x / stageScaleFactor,
                        point.y / stageScaleFactor
                    )
                );
                return;
            } else {
                setCurrentLine([]);
            }
        }
        if (
            e.evt instanceof TouchEvent &&
            e.evt.touches.length === 2 &&
            currentSelectedIds.length > 0 &&
            trRef.current
        ) {
            const stage = trRef.current.getStage();
            const node = stage?.findOne(`#${currentSelectedIds[0]}`);
            if (!node) return;
            if (node.isDragging()) node.stopDrag();

            const t1 = e.evt.touches[0];
            const t2 = e.evt.touches[1];
            const p1 = touchToStagePoint(stage!, t1);
            const p2 = touchToStagePoint(stage!, t2);
            const dist = getDistance(p1, p2);
            const angle = getAngle(p1, p2);
            const center = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };

            if (!lastDist.current || !lastAngle.current || !lastCenter.current) return;
            const scaleBy = dist / lastDist.current;
            const angleDelta = getAngleDelta(angle, lastAngle.current);
            const prevCenter = lastCenter.current;
            const radians = (angleDelta * Math.PI) / 180;
            const cos = Math.cos(radians);
            const sin = Math.sin(radians);
            const fromPrevCenterX = node.x() - prevCenter.x;
            const fromPrevCenterY = node.y() - prevCenter.y;
            const rotatedScaledX = (fromPrevCenterX * cos - fromPrevCenterY * sin) * scaleBy;
            const rotatedScaledY = (fromPrevCenterX * sin + fromPrevCenterY * cos) * scaleBy;
            const newX = center.x + rotatedScaledX;
            const newY = center.y + rotatedScaledY;

            const newScaleX = Math.round(node.scaleX() * scaleBy * 1000) / 1000;
            const newScaleY = Math.round(node.scaleY() * scaleBy * 1000) / 1000;
            const canApplyScale =
                newScaleX > 0.1 && newScaleX < 10 && newScaleY > 0.1 && newScaleY < 10;
            if (canApplyScale) {
                node.scaleX(newScaleX);
                node.x(newX);
                node.scaleY(newScaleY);
                node.y(newY);
            }
            node.rotation(node.rotation() + angleDelta);
            trRef.current.getLayer()?.batchDraw();
            engine?.broadcastBinaryMove(
                parseInt(currentSelectedIds[0]),
                Math.round(node.x()),
                Math.round(node.y()),
                Math.round(node.width()),
                Math.round(node.height()),
                Math.round(node.scaleX() * 1000) / 1000,
                Math.round(node.scaleY() * 1000) / 1000,
                Math.round(node.rotation())
            );

            lastDist.current = dist;
            lastAngle.current = angle;
            lastCenter.current = center;
            return;
        }
        if (e.evt instanceof TouchEvent && e.evt.touches.length === 2) {
            if (e.evt.targetTouches && e.evt.targetTouches.length > 1) {
                const currentX = e.evt.touches[0].screenX;
                const deltaX = currentX - lastX.current;
                if (stageSlot.current) {
                    stageSlot.current.scrollLeft = stageLastX.current - deltaX;
                }
                return;
            }
        }
    };

    const handleTouchEnd = (e: KonvaEventObject<TouchEvent | MouseEvent>) => {
        if (e.evt instanceof TouchEvent && e.evt.touches.length < 2) setIsPinching(false);
        const currentSelectedIds = useEditorStore.getState().selectedLayerIds;
        const shouldFinalizeFromStage = e.evt instanceof TouchEvent && isPinching;
        if (shouldFinalizeFromStage && currentSelectedIds.length && trRef.current) {
            const stage = trRef.current.getStage();
            const node = stage?.findOne<Konva.Shape>(`#${currentSelectedIds[0]}`);
            if (node)
                handleTransformEnd(
                    { target: node, type: 'transformend' } as Pick<
                        KonvaEventObject<Event>,
                        'target' | 'type'
                    >,
                    parseInt(currentSelectedIds[0])
                );
        }
        if (currentEraserPath.length >= 4) {
            eraseSelectedLineLayer(currentEraserPath);
        }
        setCurrentEraserPath([]);

        // Without enough point this is probably a missfire
        if (currentLine.length > 4) {
            addLineLayer(currentLine);
        }
        setCurrentLine([]);
        lastDist.current = null;
        lastAngle.current = null;
        lastCenter.current = null;
    };

    const handleStageWheel = useCallback((e: KonvaEventObject<WheelEvent>) => {
        const slot = stageSlot.current;
        if (!slot) return;
        const delta = e.evt.deltaX + e.evt.deltaY;
        if (delta === 0) return;
        e.evt.preventDefault();
        slot.scrollLeft += delta;
    }, []);

    useEffect(() => {
        if (selectedLayerIds.length === 1 && trRef.current) {
            const node = trRef.current.getStage()?.findOne(`#${selectedLayerIds[0]}`);
            if (node) {
                trRef.current.nodes([node]);
                trRef.current.getLayer()?.batchDraw();
            } else {
                trRef.current.nodes([]);
                trRef.current.getLayer()?.batchDraw();
            }
        } else if (trRef.current) {
            trRef.current.nodes([]);
            trRef.current.getLayer()?.batchDraw();
        }
    }, [selectedLayerIds]);

    return (
        <>
            <EditorToolbar
                fileInputRef={fileInputRef}
                onUpload={handleUpload}
                // onEditText={setEditingTextLayerId}
            />
            <SlatePreview
                stageSlot={stageSlot}
                stageInstance={stageInstance}
                stageScaleFactor={stageScaleFactor}
            />
            <div ref={stageWrapper} className="flex min-h-0 grow flex-col overflow-hidden">
                <div
                    ref={stageSlot}
                    id="slate"
                    onDragOver={handleStageDragOver}
                    onDrop={handleStageDrop}
                    className="min-h-0 grow overflow-x-auto overflow-y-hidden border-b border-border bg-black"
                >
                    <Stage
                        ref={stageInstance}
                        width={COLS * SCREEN_W * stageScaleFactor}
                        height={ROWS * SCREEN_H * stageScaleFactor}
                        onMouseDown={handleStageInteractionStart}
                        onMouseMove={handleTouchMove}
                        onMouseUp={handleTouchEnd}
                        onMouseLeave={handleTouchEnd}
                        onWheel={handleStageWheel}
                        onTouchStart={handleStageInteractionStart}
                        onTouchMove={handleTouchMove}
                        onTouchEnd={handleTouchEnd}
                        scaleX={stageScaleFactor}
                        scaleY={stageScaleFactor}
                    >
                        <FastLayer listening={false}>
                            {backgroundLayer ? (
                                <KonvaBackgroundLayer
                                    key={`bg_${backgroundLayer.numericId}`}
                                    layer={backgroundLayer}
                                    previewScale={stageScaleFactor}
                                />
                            ) : null}
                        </FastLayer>
                        <KonvaLayer>
                            {/* {Array.from({ length: COLS * ROWS }).map((_, i) => {
                            const col = i % COLS;
                            const row = Math.floor(i / COLS);
                            return (
                                <Group key={`screen-${i}`}>
                                    <Rect
                                        x={col * SCREEN_W}
                                        y={row * SCREEN_H}
                                        width={SCREEN_W}
                                        height={SCREEN_H}
                                        stroke="rgba(255, 255, 255, 0.2)"
                                        strokeWidth={10}
                                        listening={false}
                                    />
                                    <Text
                                        x={col * SCREEN_W + 50}
                                        y={row * SCREEN_H + 50}
                                        text={`Screen C:${col} R:${row}`}
                                        fontSize={100}
                                        fill="rgba(255, 255, 255, 0.3)"
                                        listening={false}
                                    />
                                </Group>
                            );
                        })} */}

                            {/* oxlint-disable-next-line react-hooks-js/refs */}
                            {foregroundLayers.map((layer) => {
                                const isHidden = !layer.config.visible;
                                const isSelected = selectedLayerIdSet.has(
                                    layer.numericId.toString()
                                );
                                if (isHidden && !isSelected) return null;

                                const hiddenOpacity = isHidden ? 0.3 : 1;

                                const props = {
                                    listening: !isDrawing && !isErasing,
                                    isDrawing,
                                    isErasing,
                                    isPinching,
                                    opacity: hiddenOpacity,
                                    onSelect: (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
                                        if (e.evt instanceof MouseEvent && e.evt.button !== 0)
                                            return;
                                        toggleLayerSelection(
                                            layer.numericId.toString(),
                                            e.evt.shiftKey,
                                            e.evt.ctrlKey || e.evt.metaKey
                                        );
                                    },
                                    onTransform: (e: KonvaEventObject<Event>) =>
                                        handleTransform(e, layer.numericId),
                                    onTransformEnd: (e: KonvaEventObject<Event>) =>
                                        handleTransformEnd(e, layer.numericId)
                                };

                                if (layer.type === 'image') {
                                    return (
                                        <KonvaStaticImage
                                            key={`spi_${layer.numericId}`}
                                            layer={layer}
                                            {...props}
                                        />
                                    );
                                }
                                if (layer.type === 'video')
                                    return (
                                        <KonvaVideo
                                            key={`vid_${layer.numericId}`}
                                            layer={layer}
                                            {...props}
                                        />
                                    );
                                if (layer.type === 'text') {
                                    return (
                                        <KonvaTextLayer
                                            key={`txt_${layer.numericId}`}
                                            layer={layer}
                                            isDrawing={props.isDrawing}
                                            isPinching={props.isPinching}
                                            opacity={hiddenOpacity}
                                            onSelect={props.onSelect}
                                            onDblClick={() => startTextEditing(layer.numericId)}
                                            onTransform={props.onTransform}
                                            onTransformEnd={props.onTransformEnd}
                                        />
                                    );
                                }
                                if (layer.type === 'map') {
                                    return (
                                        <Rect
                                            key={`map_${layer.numericId}`}
                                            layer={layer}
                                            fill={'#f00'}
                                            id={layer.numericId.toString()}
                                            x={layer.config.cx}
                                            y={layer.config.cy}
                                            width={layer.config.width}
                                            height={layer.config.height}
                                            scaleX={layer.config.scaleX}
                                            scaleY={layer.config.scaleY}
                                            offsetX={layer.config.width / 2}
                                            offsetY={layer.config.height / 2}
                                            rotation={layer.config.rotation}
                                            opacity={hiddenOpacity}
                                            listening={props.listening}
                                            draggable={
                                                !props.isDrawing &&
                                                !props.isErasing &&
                                                !props.isPinching
                                            }
                                            onClick={props.onSelect}
                                            onTap={props.onSelect}
                                            onDragMove={props.onTransform}
                                            onTransform={props.onTransform}
                                            onDragEnd={props.onTransformEnd}
                                            onTransformEnd={props.onTransformEnd}
                                        />
                                    );
                                }
                                if (layer.type === 'web') {
                                    return (
                                        <KonvaWebLayer
                                            key={`web_${layer.numericId}`}
                                            layer={layer}
                                            {...props}
                                        />
                                    );
                                }
                                if (layer.type === 'shape') {
                                    const commonProps = {
                                        id: layer.numericId.toString(),
                                        x: layer.config.cx,
                                        y: layer.config.cy,
                                        rotation: layer.config.rotation,
                                        scaleX: layer.config.scaleX,
                                        scaleY: layer.config.scaleY,
                                        opacity: hiddenOpacity,
                                        listening: props.listening,
                                        draggable:
                                            !props.isDrawing &&
                                            !props.isErasing &&
                                            !props.isPinching,
                                        onClick: props.onSelect,
                                        onTap: props.onSelect,
                                        onDragMove: props.onTransform,
                                        onTransform: props.onTransform,
                                        onDragEnd: props.onTransformEnd,
                                        onTransformEnd: props.onTransformEnd,
                                        fill: layer.fill,
                                        stroke: layer.strokeColor,
                                        strokeWidth: layer.strokeWidth
                                    };

                                    if (layer.shape === 'rectangle') {
                                        return (
                                            <Rect
                                                key={`shape_${layer.numericId}`}
                                                {...commonProps}
                                                width={layer.config.width}
                                                height={layer.config.height}
                                                offsetX={layer.config.width / 2}
                                                offsetY={layer.config.height / 2}
                                                dash={layer.strokeDash}
                                                dashOffset={(layer.strokeDash[0] ?? 0) / 2}
                                                lineCap="round"
                                                lineJoin="round"
                                            />
                                        );
                                    }
                                    if (layer.shape === 'circle') {
                                        return (
                                            <Circle
                                                key={`shape_${layer.numericId}`}
                                                {...commonProps}
                                                offsetX={layer.config.width / 2}
                                                offsetY={layer.config.height / 2}
                                                radius={layer.config.width / 2}
                                                dash={layer.strokeDash}
                                                lineCap="round"
                                                lineJoin="round"
                                            />
                                        );
                                    }
                                }
                                if (layer.type === 'line') {
                                    const segments = layer.segments ?? [layer.line];
                                    return segments
                                        .filter((segment) => segment.length >= 4)
                                        .map((segment, segmentIndex) => (
                                            <Line
                                                key={`lin_${layer.numericId}_${segmentIndex}`}
                                                listening={props.listening}
                                                opacity={hiddenOpacity}
                                                points={segment}
                                                stroke={layer.strokeColor}
                                                strokeWidth={layer.strokeWidth}
                                                dash={layer.strokeDash}
                                                dashEnabled={true}
                                                tension={0.4}
                                                shadowForStrokeEnabled={
                                                    selectedLayerIds[0] ===
                                                    layer.numericId.toString()
                                                }
                                                shadowColor="#00a1ff"
                                                shadowBlur={10}
                                                shadowOffsetY={20}
                                                shadowOffsetX={20}
                                                shadowOpacity={1}
                                                lineCap="round"
                                                lineJoin="round"
                                            />
                                        ));
                                }
                                return null;
                            })}
                            {currentLine.length > 3 && (
                                <Line
                                    key="new-line"
                                    points={currentLine}
                                    stroke={strokeColor}
                                    strokeWidth={strokeWidth}
                                    dash={strokeDash}
                                    dashEnabled={true}
                                    tension={0.5}
                                    lineCap="round"
                                    lineJoin="round"
                                />
                            )}
                            {currentEraserPath.length > 3 && (
                                <Line
                                    key="eraser-preview"
                                    points={currentEraserPath}
                                    stroke="rgba(255, 255, 255, 0.45)"
                                    strokeWidth={eraserWidth}
                                    dashEnabled={false}
                                    tension={0.5}
                                    lineCap="round"
                                    lineJoin="round"
                                    listening={false}
                                />
                            )}
                            {selectedOutlineLayers.length > 1
                                ? selectedOutlineLayers.map((layer) => (
                                      <Rect
                                          key={`selbox_${layer.numericId}`}
                                          x={layer.config.cx}
                                          y={layer.config.cy}
                                          width={layer.config.width}
                                          height={layer.config.height}
                                          offsetX={layer.config.width / 2}
                                          offsetY={layer.config.height / 2}
                                          rotation={layer.config.rotation}
                                          scaleX={layer.config.scaleX}
                                          scaleY={layer.config.scaleY}
                                          stroke="#00a1ff"
                                          strokeWidth={6}
                                          opacity={1}
                                          listening={false}
                                      />
                                  ))
                                : null}
                            {showGrid && getDOGridLines(COLS * SCREEN_W, ROWS * SCREEN_H, 20)}
                            <Transformer
                                ref={trRef}
                                flipEnabled={false}
                                anchorCornerRadius={10}
                                anchorSize={20}
                                enabledAnchors={(() => {
                                    const selectedId = selectedLayerIds[0];
                                    if (!selectedId) return undefined;
                                    const selected = layers.get(parseInt(selectedId, 10));
                                    if (selected?.type !== 'text') return undefined;
                                    return [
                                        'top-left',
                                        'top-center',
                                        'top-right',
                                        'middle-left',
                                        'middle-right',
                                        'bottom-left',
                                        'bottom-center',
                                        'bottom-right'
                                    ] as const;
                                })()}
                                boundBoxFunc={(oldBox, newBox) => {
                                    if (Math.abs(newBox.width) < 5 || Math.abs(newBox.height) < 5)
                                        return oldBox;
                                    return newBox;
                                }}
                            />
                        </KonvaLayer>
                    </Stage>
                </div>
            </div>
        </>
    );
}

// --- VITE HMR DEFENSE STRATEGY ---
if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        if (typeof window !== 'undefined') {
            window.__EDITOR_RELOADING__ = true;
        }
    });
}
