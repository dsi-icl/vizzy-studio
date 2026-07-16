import { CircleNotchIcon, SlideshowIcon, TriangleDashedIcon } from '@phosphor-icons/react';
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup
} from '@repo/ui/components/resizable';
import { cn } from '@repo/ui/lib/utils';
import { createFileRoute, useLocation } from '@tanstack/react-router';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import QRCode from 'qrcode';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer as KonvaLayer, Rect, Circle, Line } from 'react-konva';
import { useShallow } from 'zustand/react/shallow';

import { ControllerToolbar } from '~/components/ControllerToolbar';
import { KonvaBackgroundLayer } from '~/components/KonvaBackgroundLayer';
import { ReadOnlyMediaLayer, ReadOnlyTextLayer } from '~/components/ReadOnlyLayers';
import { ViewerSlatePreview } from '~/components/ViewerSlatePreview';
import { ControllerEngine } from '~/lib/controllerEngine';
import { useControllerStore } from '~/lib/controllerStore';
import { getOrCreateDeviceIdentity } from '~/lib/deviceIdentity';
import { COLS, ROWS, SCREEN_H, SCREEN_W } from '~/lib/stageConstants';
import type { LayerWithEditorState } from '~/lib/types';

const DEFAULT_STAGE_SCALE_FACTOR = 0.15;
const BINDING_SIGNAL_TIMEOUT_MS = 1500;
const HYDRATE_TIMEOUT_MS = 2000;
const TEMP_BOUND_SLIDE_ID = '__bound-current__';

export const Route = createFileRoute('/controller/')({
    head: () => ({
        meta: [{ title: 'Controller · Vizzy Studio' }]
    }),
    component: Controller
});

interface BindingStatus {
    bound: boolean;
    projectId?: string;
    commitId?: string;
    slideId?: string;
    customRenderUrl?: string;
    boundSource?: 'live' | 'gallery';
}

interface SlideEntry {
    id: string;
    name: string;
    order: number;
    layers: LayerWithEditorState[];
    layerCount: number;
}

interface RenderState {
    hydrationReady: boolean;
    customRenderUrl?: string;
}

function buildLineLayer(
    line: number[],
    strokeColor: string,
    strokeWidth: number,
    strokeDash: number[],
    existingLayers: LayerWithEditorState[]
): LayerWithEditorState | null {
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
    const width = Math.max(1, Math.round(rawWidth));
    const height = Math.max(1, Math.round(rawHeight));
    const cx = Math.round(minX + rawWidth / 2);
    const cy = Math.round(minY + rawHeight / 2);

    const nextNumericId =
        existingLayers.reduce((max, layer) => Math.max(max, layer.numericId), 0) + 10;
    const nextZIndex =
        existingLayers.reduce((max, layer) => Math.max(max, layer.config.zIndex), 0) + 5;

    return {
        numericId: nextNumericId,
        type: 'line',
        config: {
            cx,
            cy,
            width,
            height,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            zIndex: nextZIndex,
            visible: true
        },
        line: line.map((p) => Math.round(p)),
        strokeColor,
        strokeWidth,
        strokeDash
    };
}

function Controller() {
    const lastX = useRef(0);
    const stageLastX = useRef(0);

    const stageSlot = useRef<HTMLDivElement>(null);
    const stageInstance = useRef<Konva.Stage>(null);
    const [stageScaleFactor, setStageScaleFactor] = useState(DEFAULT_STAGE_SCALE_FACTOR);
    const [activeSlideId, setActiveSlideId] = useState<string | null>(null);
    const [requestedSlideId, setRequestedSlideId] = useState<string | null>(null);
    const searchStr = useLocation({
        select: (location) => location.searchStr
    });
    const { wallId, mountLocation, portalToken } = useMemo(() => {
        const params = new URLSearchParams(searchStr);
        return {
            wallId: params.get('w')?.trim(),
            mountLocation: params.get('l')?.trim(),
            portalToken: params.get('_gem_t')?.trim() ?? params.get('_viz_t')?.trim()
        };
    }, [searchStr]);

    const showHideHeadAndFoot = mountLocation === 'gallery';

    const engine = useMemo(
        () =>
            typeof window !== 'undefined' && wallId
                ? ControllerEngine.getInstance(wallId, portalToken)
                : null,
        [wallId, portalToken]
    );
    const [binding, setBinding] = useState<BindingStatus>({ bound: false });
    const [deviceEnrollmentId, setDeviceEnrollmentId] = useState<string | null>(null);
    const [enrollmentQrDataUrl, setEnrollmentQrDataUrl] = useState<string | null>(null);
    const [renderState, setRenderState] = useState<RenderState>({ hydrationReady: false });
    const [hasBindingSignal, setHasBindingSignal] = useState(false);
    const [slides, setSlides] = useState<SlideEntry[]>([]);
    const [pendingSlideId, setPendingSlideId] = useState<string | null>(null);
    const slidesRef = useRef<SlideEntry[]>([]);
    const lastRequestedBindRef = useRef<string | null>(null);
    const lastBoundScopeRef = useRef<string | null>(null);
    const boundSlideIdRef = useRef<string | null>(null);
    const pendingSlideIdRef = useRef<string | null>(null);
    const pendingSlideTimeoutRef = useRef<number | null>(null);
    const {
        isDrawing,
        strokeColor,
        setStrokeColor,
        strokeWidth,
        setStrokeWidth,
        strokeDash,
        setStrokeDash,
        currentLine,
        setDrawing,
        toggleDrawing,
        startLine,
        appendLinePoint,
        clearCurrentLine,
        consumeCurrentLine
    } = useControllerStore(
        useShallow((s) => ({
            isDrawing: s.isDrawing,
            strokeColor: s.strokeColor,
            setStrokeColor: s.setStrokeColor,
            strokeWidth: s.strokeWidth,
            setStrokeWidth: s.setStrokeWidth,
            strokeDash: s.strokeDash,
            setStrokeDash: s.setStrokeDash,
            currentLine: s.currentLine,
            setDrawing: s.setDrawing,
            toggleDrawing: s.toggleDrawing,
            startLine: s.startLine,
            appendLinePoint: s.appendLinePoint,
            clearCurrentLine: s.clearCurrentLine,
            consumeCurrentLine: s.consumeCurrentLine
        }))
    );

    useEffect(() => {
        if (!engine) return;
        return engine.onMessage((data) => {
            if (data.type === 'device_enrollment') {
                setDeviceEnrollmentId(data.id);
            }
        });
    }, [engine]);

    useEffect(() => {
        const deviceId = deviceEnrollmentId?.trim();
        if (!deviceId) return;
        let cancelled = false;
        Promise.resolve()
            .then(async () => {
                const identity = await getOrCreateDeviceIdentity('controller');
                const signature = await identity.signPayload(deviceId);
                const payload = JSON.stringify({
                    // schema: 'gem://',
                    // kind: 'wall',
                    did: deviceId,
                    sig: signature
                });
                return QRCode.toDataURL(payload, {
                    margin: 0,
                    width: 240,
                    errorCorrectionLevel: 'L',
                    color: {
                        dark: '#939393FF',
                        light: '#00000000'
                    }
                });
            })
            .then((url) => {
                if (!cancelled) setEnrollmentQrDataUrl(url);
            })
            .catch(() => {
                if (!cancelled) setEnrollmentQrDataUrl(null);
            });
        return () => {
            cancelled = true;
        };
    }, [deviceEnrollmentId]);

    useEffect(() => {
        if (!engine) return;
        setHasBindingSignal(false);
        return engine.onSnapshot((snapshot) => {
            setHasBindingSignal(true);
            boundSlideIdRef.current = snapshot.binding.slideId ?? null;
            setBinding((prev) => {
                if (
                    prev.bound === snapshot.binding.bound &&
                    prev.projectId === snapshot.binding.projectId &&
                    prev.commitId === snapshot.binding.commitId &&
                    prev.slideId === snapshot.binding.slideId &&
                    prev.customRenderUrl === snapshot.binding.customRenderUrl &&
                    prev.boundSource === snapshot.binding.boundSource
                ) {
                    return prev;
                }
                return snapshot.binding;
            });
            setSlides(snapshot.slides as SlideEntry[]);
            if (snapshot.binding.bound && snapshot.binding.customRenderUrl) {
                setRenderState({
                    hydrationReady: true,
                    customRenderUrl: snapshot.binding.customRenderUrl
                });
            } else if (!snapshot.binding.bound) {
                setRenderState({ hydrationReady: true, customRenderUrl: undefined });
            } else if (snapshot.hasHydration) {
                setRenderState({ hydrationReady: true, customRenderUrl: undefined });
            }
        });
    }, [engine]);

    // Public/controller fallback: do not stay blocked forever when bus status cannot be reached.
    useEffect(() => {
        if (!engine) {
            setHasBindingSignal(true);
            return;
        }
        if (hasBindingSignal) return;
        const timeout = window.setTimeout(() => {
            setHasBindingSignal(true);
            setBinding((prev) => (prev.bound ? prev : { bound: false }));
        }, BINDING_SIGNAL_TIMEOUT_MS);
        return () => window.clearTimeout(timeout);
    }, [engine, hasBindingSignal]);

    // Hydrate metadata from bus is authoritative for custom render config.
    // Reset readiness when binding changes so we don't flash stale content.
    useEffect(() => {
        setRenderState((prev) => {
            if (!hasBindingSignal) {
                return { hydrationReady: false };
            }

            if (!binding.bound) {
                return { hydrationReady: true, customRenderUrl: undefined };
            }

            if (binding.customRenderUrl) {
                return { hydrationReady: true, customRenderUrl: binding.customRenderUrl };
            }

            // Non-custom controller mode:
            // keep hydrationReady stable across slide changes and normal scope sync.
            // Only force a new hydrate cycle when switching away from custom render.
            if (prev.customRenderUrl) {
                return { hydrationReady: false, customRenderUrl: undefined };
            }
            return prev;
        });
    }, [
        hasBindingSignal,
        binding.bound,
        binding.projectId,
        binding.commitId,
        binding.customRenderUrl
    ]);

    // If bound but hydrate never arrives (network/proxy hiccup), fail open to avoid infinite spinner.
    useEffect(() => {
        if (!hasBindingSignal || !binding.bound || renderState.hydrationReady) return;
        const timeout = window.setTimeout(() => {
            setRenderState((prev) =>
                prev.hydrationReady ? prev : { ...prev, hydrationReady: true }
            );
        }, HYDRATE_TIMEOUT_MS);
        return () => window.clearTimeout(timeout);
    }, [hasBindingSignal, binding.bound, renderState.hydrationReady]);

    useEffect(() => {
        const nextScope =
            binding.bound && binding.projectId && binding.commitId
                ? `${binding.projectId}:${binding.commitId}`
                : null;
        const prevScope = lastBoundScopeRef.current;
        const scopeChanged = prevScope !== nextScope;
        lastBoundScopeRef.current = nextScope;

        if (!binding.bound) {
            setSlides([]);
            setActiveSlideId(null);
            setRequestedSlideId(null);
            setPendingSlideId(null);
            lastRequestedBindRef.current = null;
            return;
        }

        if (scopeChanged) {
            // Bound scope changed (different project/commit): drop stale local slide cache.
            setSlides([]);
            setActiveSlideId(null);
            setRequestedSlideId(binding.slideId ?? null);
            setPendingSlideId(null);
        }

        if (binding.projectId && binding.commitId && binding.slideId) {
            // Keep dedupe signature aligned with authoritative server state.
            // This prevents stale local signatures from blocking legitimate rebinds
            // after another controller has moved the wall.
            lastRequestedBindRef.current = `${binding.projectId}:${binding.commitId}:${binding.slideId}`;
        } else {
            lastRequestedBindRef.current = null;
        }
    }, [binding.bound, binding.projectId, binding.commitId, binding.slideId]);

    useEffect(() => {
        slidesRef.current = slides;
    }, [slides]);
    useEffect(() => {
        pendingSlideIdRef.current = pendingSlideId;
    }, [pendingSlideId]);

    useEffect(() => {
        if (pendingSlideTimeoutRef.current !== null) {
            window.clearTimeout(pendingSlideTimeoutRef.current);
            pendingSlideTimeoutRef.current = null;
        }

        if (!pendingSlideId) return;
        pendingSlideTimeoutRef.current = window.setTimeout(() => {
            setPendingSlideId((current) => (current === pendingSlideId ? null : current));
        }, 4000);

        return () => {
            if (pendingSlideTimeoutRef.current !== null) {
                window.clearTimeout(pendingSlideTimeoutRef.current);
                pendingSlideTimeoutRef.current = null;
            }
        };
    }, [pendingSlideId]);

    const upsertLayerOnSlide = useCallback((slideId: string, nextLayer: LayerWithEditorState) => {
        setSlides((prev) =>
            prev.map((slide) => {
                if (slide.id !== slideId) return slide;
                const existingIndex = slide.layers.findIndex(
                    (l) => l.numericId === nextLayer.numericId
                );
                const nextLayers = [...slide.layers];
                if (existingIndex >= 0) {
                    nextLayers[existingIndex] = nextLayer;
                } else {
                    nextLayers.push(nextLayer);
                }
                return {
                    ...slide,
                    layers: nextLayers,
                    layerCount: nextLayers.length
                };
            })
        );
    }, []);

    // HMR rehydrate
    useEffect(() => {
        if (window.__CONTROLLER_RELOADING__) {
            setTimeout(() => {
                engine?.sendJSON({ type: 'rehydrate_please' });
            }, 500);
            window.__CONTROLLER_RELOADING__ = false;
        }
    }, [engine]);

    // Default to first slide
    useEffect(() => {
        if (!activeSlideId && slides.length > 0) {
            setActiveSlideId(slides[0].id);
            setRequestedSlideId(slides[0].id);
        }
    }, [activeSlideId, slides]);

    useEffect(() => {
        const authoritativeSlideId = binding.slideId;
        if (!authoritativeSlideId) return;

        setSlides((prev) => {
            const tempIndex = prev.findIndex((slide) => slide.id === TEMP_BOUND_SLIDE_ID);
            if (tempIndex < 0) return prev;
            if (prev.some((slide) => slide.id === authoritativeSlideId)) {
                // Real slide entry already exists; drop temporary shell.
                return prev.filter((slide) => slide.id !== TEMP_BOUND_SLIDE_ID);
            }

            const next = [...prev];
            next[tempIndex] = { ...next[tempIndex], id: authoritativeSlideId };
            return next;
        });

        setActiveSlideId((prev) => (prev === TEMP_BOUND_SLIDE_ID ? authoritativeSlideId : prev));
        setRequestedSlideId((prev) => (prev === TEMP_BOUND_SLIDE_ID ? authoritativeSlideId : prev));
    }, [binding.slideId]);

    useEffect(() => {
        if (!activeSlideId) return;
        const hasActiveSlide = slides.some((slide) => slide.id === activeSlideId);
        if (hasActiveSlide) return;

        const preferredSlideId =
            (binding.slideId && slides.some((slide) => slide.id === binding.slideId)
                ? binding.slideId
                : null) ??
            slides[0]?.id ??
            null;
        setActiveSlideId(preferredSlideId);
        setRequestedSlideId(preferredSlideId);
    }, [activeSlideId, slides, binding.slideId]);

    useEffect(() => {
        const boundSlideId = binding.slideId;
        if (!boundSlideId) return;
        setActiveSlideId((prev) => (prev === boundSlideId ? prev : boundSlideId));
        setRequestedSlideId((prev) => (prev === boundSlideId ? prev : boundSlideId));
    }, [binding.slideId]);

    useEffect(() => {
        clearCurrentLine();
    }, [activeSlideId, requestedSlideId, binding.slideId, binding.bound, clearCurrentLine]);

    useEffect(() => {
        if (binding.bound) return;
        setDrawing(false);
    }, [binding.bound, setDrawing]);

    useEffect(() => {
        if (!pendingSlideId) return;
        if (binding.slideId !== pendingSlideId) return;
        setPendingSlideId(null);
    }, [binding.slideId, pendingSlideId]);

    const activeLayers = useMemo(() => {
        const slide = slides.find((s) => s.id === activeSlideId);
        return (slide?.layers ?? []) as LayerWithEditorState[];
    }, [slides, activeSlideId]);

    const sortedLayers = useMemo(
        () => [...activeLayers].sort((a, b) => a.config.zIndex - b.config.zIndex),
        [activeLayers]
    );
    const backgroundLayer = useMemo(
        () =>
            sortedLayers.find(
                (layer): layer is Extract<LayerWithEditorState, { type: 'background' }> =>
                    layer.type === 'background' && layer.config.visible
            ) ?? null,
        [sortedLayers]
    );
    const foregroundLayers = useMemo(
        () => sortedLayers.filter((layer) => layer.type !== 'background'),
        [sortedLayers]
    );
    const sortedSlides = useMemo(() => [...slides].sort((a, b) => a.order - b.order), [slides]);
    const videoLayers = useMemo(
        () => activeLayers.filter((l) => l.type === 'video'),
        [activeLayers]
    );
    const canDraw = Boolean(engine && binding.bound && activeSlideId);

    const handleSlideSelect = useCallback(
        (slideId: string) => {
            const isAlreadyBound = binding.slideId === slideId;
            const isSelectedSlide = activeSlideId === slideId || requestedSlideId === slideId;
            const isLoadingSlide = pendingSlideId !== null;
            setRequestedSlideId(slideId);

            // Re-click on currently selected slide triggers a refresh bind,
            // but only when no slide change is already in flight.
            if (isSelectedSlide && !isLoadingSlide) {
                setPendingSlideId(slideId);
                if (!engine || !binding.projectId || !binding.commitId) return;
                lastRequestedBindRef.current = null;
                engine.bindSlide(binding.projectId, binding.commitId, slideId);
                return;
            }

            if (isAlreadyBound) {
                setActiveSlideId((prev) => (prev === slideId ? prev : slideId));
                setPendingSlideId(null);
                return;
            }

            setPendingSlideId(slideId);

            if (!engine || !binding.projectId || !binding.commitId) {
                return;
            }

            const bindKey = `${binding.projectId}:${binding.commitId}:${slideId}`;
            if (lastRequestedBindRef.current === bindKey) return;
            lastRequestedBindRef.current = bindKey;
            engine.bindSlide(binding.projectId, binding.commitId, slideId);
        },
        [
            engine,
            binding.slideId,
            binding.projectId,
            binding.commitId,
            activeSlideId,
            requestedSlideId,
            pendingSlideId
        ]
    );

    const handleVideoCommand = useCallback(
        (cmd: 'play' | 'pause' | 'rewind') => {
            if (!engine) return;
            const now = Date.now();
            for (const layer of videoLayers) {
                if (cmd === 'play') {
                    engine.sendJSON({
                        type: 'video_play',
                        numericId: layer.numericId,
                        issuedAt: now
                    });
                } else if (cmd === 'pause') {
                    engine.sendJSON({
                        type: 'video_pause',
                        numericId: layer.numericId,
                        issuedAt: now
                    });
                } else {
                    engine.sendJSON({
                        type: 'video_seek',
                        numericId: layer.numericId,
                        mediaTime: 0,
                        issuedAt: now
                    });
                }
            }
        },
        [engine, videoLayers]
    );

    const addLineLayer = useCallback(
        (line: number[]) => {
            if (!engine || !activeSlideId || line.length < 6) return;
            const currentSlides = slidesRef.current;
            const targetSlide = currentSlides.find((slide) => slide.id === activeSlideId);
            if (!targetSlide) return;
            const nextLayer = buildLineLayer(
                line,
                strokeColor,
                strokeWidth,
                strokeDash,
                targetSlide.layers
            );
            if (!nextLayer) return;

            upsertLayerOnSlide(activeSlideId, nextLayer);
            engine.sendJSON({
                type: 'upsert_layer',
                origin: 'controller:add_line_layer',
                layer: nextLayer
            });
        },
        [engine, activeSlideId, strokeColor, strokeWidth, strokeDash, upsertLayerOnSlide]
    );

    const getStagePoint = useCallback(
        (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
            const stage = e.target.getStage();
            const point = stage?.getPointerPosition();
            if (!point) return null;
            return {
                x: point.x / stageScaleFactor,
                y: point.y / stageScaleFactor
            };
        },
        [stageScaleFactor]
    );

    const handleDrawStart = useCallback(
        (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
            if (!canDraw || !isDrawing) return;
            if (e.evt instanceof TouchEvent && e.evt.touches.length >= 2) return;
            const point = getStagePoint(e);
            if (!point) return;
            startLine(point.x, point.y);
        },
        [canDraw, isDrawing, getStagePoint, startLine]
    );

    const handleDrawMove = useCallback(
        (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
            if (!canDraw || !isDrawing || currentLine.length < 2) return;
            if (e.evt instanceof TouchEvent && e.evt.touches.length >= 2) {
                clearCurrentLine();
                return;
            }
            if (e.evt instanceof MouseEvent && e.evt.buttons !== 1) return;
            const point = getStagePoint(e);
            if (!point) return;
            appendLinePoint(point.x, point.y);
        },
        [canDraw, isDrawing, currentLine.length, getStagePoint, appendLinePoint, clearCurrentLine]
    );

    const handleDrawEnd = useCallback(() => {
        if (!canDraw || !isDrawing) return;
        const line = consumeCurrentLine();
        if (line.length > 4) {
            addLineLayer(line);
        }
        clearCurrentLine();
    }, [canDraw, isDrawing, consumeCurrentLine, addLineLayer, clearCurrentLine]);

    const handleTouchStart = useCallback(
        (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
            if (e.evt instanceof TouchEvent && e.evt.touches?.length === 2) {
                lastX.current = e.evt.touches[0].clientX;
                if (stageSlot.current) {
                    stageLastX.current = stageSlot.current.scrollLeft;
                }
                return;
            }
            handleDrawStart(e);
        },
        [handleDrawStart]
    );

    const handleTouchMove = useCallback(
        (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
            e.evt.preventDefault();
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
            handleDrawMove(e);
        },
        [handleDrawMove]
    );

    const handleTouchEnd = useCallback(
        (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
            if (e.evt instanceof TouchEvent && e.evt.touches.length >= 1) return;
            handleDrawEnd();
        },
        [handleDrawEnd]
    );

    const handleStageWheel = useCallback((e: KonvaEventObject<WheelEvent>) => {
        const slot = stageSlot.current;
        if (!slot) return;
        const delta = e.evt.deltaX + e.evt.deltaY;
        if (delta === 0) return;
        e.evt.preventDefault();
        slot.scrollLeft += delta;
    }, []);

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

    if (!wallId)
        return (
            <div
                className={cn(
                    'container flex h-full max-h-full min-h-0 min-w-full flex-col items-center justify-center gap-2 overflow-hidden bg-background text-center',
                    showHideHeadAndFoot
                        ? 'fixed inset-0 top-0 right-0 bottom-0 left-0 z-1000! p-0'
                        : 'pt-18 pb-13'
                )}
            >
                <h2 className="text-lg font-semibold">Controller unavailable</h2>
                <p className="max-w-md text-sm text-muted-foreground">
                    Missing wall id in URL. Open this page with <code>?w=&lt;wallId&gt;</code>.
                </p>
            </div>
        );

    if (deviceEnrollmentId)
        return (
            <div
                className={cn(
                    'container flex h-full max-h-full min-h-0 min-w-full flex-col items-center justify-center gap-5 overflow-hidden bg-background px-4 text-center text-neutral-500',
                    showHideHeadAndFoot
                        ? 'fixed inset-0 top-0 right-0 bottom-0 left-0 z-1000! p-0'
                        : 'pt-18 pb-13'
                )}
            >
                <TriangleDashedIcon size={56} weight="thin" />
                <p className="text-center text-xl font-medium">
                    This controller hasn't been registered yet
                </p>
                <div className="flex flex-col items-center p-10">
                    {enrollmentQrDataUrl ? (
                        <img
                            src={enrollmentQrDataUrl}
                            alt="Device enrollment QR code"
                            loading="eager"
                            fetchPriority="high"
                            decoding="async"
                            width={200}
                            height={200}
                        />
                    ) : null}
                </div>
            </div>
        );

    if (!renderState.hydrationReady)
        return (
            <div
                className={cn(
                    'container flex h-full max-h-full min-h-0 min-w-full flex-col items-center justify-center overflow-hidden bg-background',
                    showHideHeadAndFoot
                        ? 'fixed inset-0 top-0 right-0 bottom-0 left-0 z-1000! p-0'
                        : 'pt-18 pb-13'
                )}
            >
                <div className="flex items-center gap-3 rounded-lg bg-card px-5 py-3 shadow-lg">
                    <CircleNotchIcon className="h-5 w-5 animate-spin text-muted-foreground" />
                    <span className="text-sm font-medium text-muted-foreground">
                        Connecting to wall...
                    </span>
                </div>
            </div>
        );

    if (!binding.bound)
        return (
            <div
                className={cn(
                    'container flex h-full max-h-full min-h-0 min-w-full flex-col items-center justify-center gap-4 overflow-hidden bg-background px-4 text-center',
                    showHideHeadAndFoot
                        ? 'fixed inset-0 top-0 right-0 bottom-0 left-0 z-1000! p-0'
                        : 'pt-18 pb-13'
                )}
            >
                <h2 className="text-xl font-semibold">Nothing to control just yet</h2>
                <p className="max-w-md text-muted-foreground">
                    This wall is currently idle. Start a project from the gallery and this
                    controller will spring to life automatically.
                </p>
            </div>
        );

    if (binding.bound && binding.boundSource === 'live')
        return (
            <div
                className={cn(
                    'container flex h-full max-h-full min-h-0 min-w-full flex-col items-center justify-center gap-4 overflow-hidden bg-background text-center',
                    showHideHeadAndFoot
                        ? 'fixed inset-0 top-0 right-0 bottom-0 left-0 z-1000! p-0'
                        : 'pt-18 pb-13'
                )}
            >
                <h2 className="text-xl font-semibold">Vizzy Controller Unavailable</h2>
                <p className="max-w-md text-muted-foreground">
                    This wall is currently in a live editing session. The gallery controller is
                    disabled while live control is active.
                </p>
            </div>
        );

    if (renderState.customRenderUrl)
        return (
            <div
                className={cn(
                    'container flex h-full max-h-full min-h-0 min-w-full flex-col items-center justify-center gap-4 overflow-hidden bg-background text-center',
                    showHideHeadAndFoot
                        ? 'fixed inset-0 top-0 right-0 bottom-0 left-0 z-1000! p-0'
                        : 'pt-18 pb-13'
                )}
            >
                <h2 className="text-xl font-semibold">Vizzy Controller Unavailable</h2>
                <p className="max-w-md text-muted-foreground">
                    This project uses a custom render URL and cannot be controlled with the built-in
                    controller. Set your custom control URL in the project settings.
                </p>
            </div>
        );

    if (binding.bound && slides.length === 0)
        return (
            <div
                className={cn(
                    'container flex h-full max-h-full min-h-0 min-w-full flex-col items-center justify-center overflow-hidden bg-background',
                    showHideHeadAndFoot
                        ? 'fixed inset-0 top-0 right-0 bottom-0 left-0 z-1000! p-0'
                        : 'pt-18 pb-13'
                )}
            >
                <div className="flex items-center gap-3 rounded-lg bg-card px-5 py-3 shadow-lg">
                    <CircleNotchIcon className="h-5 w-5 animate-spin text-muted-foreground" />
                    <span className="text-sm font-medium text-muted-foreground">
                        Loading slides...
                    </span>
                </div>
            </div>
        );

    return (
        <div
            className={cn(
                'container flex h-full max-h-full min-h-0 min-w-full flex-col overflow-hidden bg-background',
                showHideHeadAndFoot
                    ? 'fixed inset-0 top-0 right-0 bottom-0 left-0 z-1000! p-0'
                    : 'pt-18 pb-13'
            )}
        >
            <ResizablePanelGroup
                orientation="horizontal"
                className="h-full min-h-0 w-full overflow-hidden font-sans text-foreground"
            >
                <ResizablePanel className="min-h-0 overflow-hidden">
                    <div className="flex h-full min-h-0 flex-col overflow-hidden">
                        <div className="flex min-h-0 flex-1 overflow-hidden">
                            {/* Canvas area */}
                            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                                <ControllerToolbar
                                    isDrawing={isDrawing}
                                    canDraw={canDraw}
                                    onToggleDrawing={toggleDrawing}
                                    strokeColor={strokeColor}
                                    setStrokeColor={setStrokeColor}
                                    strokeWidth={strokeWidth}
                                    setStrokeWidth={setStrokeWidth}
                                    strokeDash={strokeDash}
                                    setStrokeDash={setStrokeDash}
                                    hasVideoLayers={videoLayers.length > 0}
                                    onVideoCommand={handleVideoCommand}
                                />

                                <ViewerSlatePreview
                                    stageSlot={stageSlot}
                                    stageInstance={stageInstance}
                                    stageScaleFactor={stageScaleFactor}
                                    layers={sortedLayers}
                                />
                                <div
                                    ref={stageSlot}
                                    className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden bg-black"
                                >
                                    <Stage
                                        ref={stageInstance}
                                        width={COLS * SCREEN_W * stageScaleFactor}
                                        height={ROWS * SCREEN_H * stageScaleFactor}
                                        onMouseDown={handleDrawStart}
                                        onMouseMove={handleDrawMove}
                                        onMouseUp={handleDrawEnd}
                                        onMouseLeave={handleDrawEnd}
                                        onWheel={handleStageWheel}
                                        onTouchStart={handleTouchStart}
                                        onTouchMove={handleTouchMove}
                                        onTouchEnd={handleTouchEnd}
                                        scaleX={stageScaleFactor}
                                        scaleY={stageScaleFactor}
                                    >
                                        <KonvaLayer>
                                            {backgroundLayer ? (
                                                <KonvaBackgroundLayer
                                                    key={`bg_${backgroundLayer.numericId}`}
                                                    layer={backgroundLayer}
                                                    previewScale={1}
                                                />
                                            ) : null}
                                            {foregroundLayers
                                                .filter((layer) => layer.config.visible)
                                                .map((layer) => {
                                                    if (layer.type === 'image') {
                                                        return (
                                                            <ReadOnlyMediaLayer
                                                                key={`img_${layer.numericId}`}
                                                                layer={layer}
                                                            />
                                                        );
                                                    }
                                                    if (layer.type === 'video') {
                                                        return (
                                                            <ReadOnlyMediaLayer
                                                                key={`vid_${layer.numericId}`}
                                                                layer={layer}
                                                            />
                                                        );
                                                    }
                                                    if (layer.type === 'web') {
                                                        return (
                                                            <ReadOnlyMediaLayer
                                                                key={`web_${layer.numericId}`}
                                                                layer={layer}
                                                            />
                                                        );
                                                    }
                                                    if (layer.type === 'text') {
                                                        return (
                                                            <ReadOnlyTextLayer
                                                                key={`txt_${layer.numericId}`}
                                                                layer={layer}
                                                            />
                                                        );
                                                    }
                                                    if (layer.type === 'shape') {
                                                        const common = {
                                                            x: layer.config.cx,
                                                            y: layer.config.cy,
                                                            rotation: layer.config.rotation,
                                                            scaleX: layer.config.scaleX,
                                                            scaleY: layer.config.scaleY,
                                                            fill: layer.fill,
                                                            stroke: layer.strokeColor,
                                                            strokeWidth: layer.strokeWidth,
                                                            lineCap: 'round' as const,
                                                            lineJoin: 'round' as const,
                                                            listening: false as const
                                                        };
                                                        if (layer.shape === 'rectangle') {
                                                            return (
                                                                <Rect
                                                                    key={`shape_${layer.numericId}`}
                                                                    {...common}
                                                                    width={layer.config.width}
                                                                    height={layer.config.height}
                                                                    offsetX={layer.config.width / 2}
                                                                    offsetY={
                                                                        layer.config.height / 2
                                                                    }
                                                                    dash={layer.strokeDash}
                                                                />
                                                            );
                                                        }
                                                        if (layer.shape === 'circle') {
                                                            return (
                                                                <Circle
                                                                    key={`shape_${layer.numericId}`}
                                                                    {...common}
                                                                    offsetX={layer.config.width / 2}
                                                                    offsetY={
                                                                        layer.config.height / 2
                                                                    }
                                                                    radius={layer.config.width / 2}
                                                                    dash={layer.strokeDash}
                                                                />
                                                            );
                                                        }
                                                    }
                                                    if (layer.type === 'line') {
                                                        return (
                                                            <Line
                                                                key={`lin_${layer.numericId}`}
                                                                points={layer.line}
                                                                stroke={layer.strokeColor}
                                                                strokeWidth={layer.strokeWidth}
                                                                dash={layer.strokeDash}
                                                                dashEnabled={true}
                                                                tension={0.4}
                                                                lineCap="round"
                                                                lineJoin="round"
                                                                listening={false}
                                                            />
                                                        );
                                                    }
                                                    if (layer.type === 'map') {
                                                        return (
                                                            <Rect
                                                                key={`map_${layer.numericId}`}
                                                                x={layer.config.cx}
                                                                y={layer.config.cy}
                                                                width={layer.config.width}
                                                                height={layer.config.height}
                                                                scaleX={layer.config.scaleX}
                                                                scaleY={layer.config.scaleY}
                                                                offsetX={layer.config.width / 2}
                                                                offsetY={layer.config.height / 2}
                                                                rotation={layer.config.rotation}
                                                                fill="#1f2937"
                                                                stroke="#334155"
                                                                strokeWidth={2}
                                                                listening={false}
                                                            />
                                                        );
                                                    }
                                                    // Fallback placeholder
                                                    return (
                                                        <Rect
                                                            key={`fallback_${layer.numericId}`}
                                                            x={layer.config.cx}
                                                            y={layer.config.cy}
                                                            width={layer.config.width}
                                                            height={layer.config.height}
                                                            offsetX={layer.config.width / 2}
                                                            offsetY={layer.config.height / 2}
                                                            rotation={layer.config.rotation}
                                                            fill="#555"
                                                            listening={false}
                                                        />
                                                    );
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
                                                    listening={false}
                                                />
                                            )}
                                        </KonvaLayer>
                                    </Stage>
                                </div>
                                {pendingSlideId && (
                                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm">
                                        <div className="flex items-center gap-3 rounded-lg bg-card px-5 py-3 shadow-lg">
                                            <CircleNotchIcon className="h-5 w-5 animate-spin text-muted-foreground" />
                                            <span className="text-sm font-medium text-muted-foreground">
                                                Switching slide...
                                            </span>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </ResizablePanel>
                <ResizableHandle />
                <ResizablePanel
                    defaultSize={300}
                    minSize={200}
                    className="min-h-0 overflow-hidden border-t border-border"
                >
                    {/* Slide list sidebar */}
                    <div className="flex h-full min-h-0 w-full flex-col border-l border-border">
                        <div className="flex h-11 shrink-0 cursor-pointer items-center justify-between border-b border-border bg-muted/50 px-4">
                            <h2 className="flex items-center gap-2 text-sm font-semibold">
                                <SlideshowIcon size={18} weight="bold" /> Slides
                            </h2>
                        </div>
                        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
                            {sortedSlides.map((slide) => (
                                <button
                                    key={slide.id}
                                    onClick={() => handleSlideSelect(slide.id)}
                                    className={`w-full cursor-pointer rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-card/50 ${
                                        activeSlideId === slide.id || requestedSlideId === slide.id
                                            ? 'bg-primary/10 text-primary'
                                            : 'text-muted-foreground hover:bg-accent'
                                    }`}
                                >
                                    <span className="flex items-center justify-between gap-2">
                                        <span className="font-medium">Slide {slide.name}</span>
                                        {pendingSlideId === slide.id ? (
                                            <CircleNotchIcon
                                                size={14}
                                                className="shrink-0 animate-spin"
                                            />
                                        ) : null}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                </ResizablePanel>
            </ResizablePanelGroup>
        </div>
    );
}
