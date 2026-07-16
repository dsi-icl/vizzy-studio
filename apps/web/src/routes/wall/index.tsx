'use client';

import { TriangleDashedIcon } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import QRCode from 'qrcode';
import { useEffect, useState, useMemo, useRef, type CSSProperties } from 'react';

import { MapWrapper } from '~/components/MapWrapper';
import { WallBackgroundCanvas } from '~/components/WallBackgroundCanvas';
import { getOrCreateDeviceIdentity } from '~/lib/deviceIdentity';
import { toCssFilterString } from '~/lib/layerFilters';
import { signedFetch } from '~/lib/signedFetch';
import { COLS, ROWS, SCREEN_H, SCREEN_W } from '~/lib/stageConstants';
import { getCullingPadding, getLineBounds } from '~/lib/stageGeometry';
import { TEXT_BASE_STYLE } from '~/lib/textRenderConfig';
import type { LayerWithWallComponentState } from '~/lib/types';
import { WallEngine, type Viewport } from '~/lib/wallEngine';

const HYDRATE_FADE_MS = 1000;
const HYDRATE_IFRAME_TIMEOUT_MS = 2000;
const WALL_MEDIA_COOKIE_REFRESH_MS = 60 * 60 * 1000;
const warmedImageUrls = new Set<string>();
type HydrateScopeContext = {
    projectId?: string;
    commitId?: string;
    slideId?: string;
};
type HydrateStagePayload = {
    layers: LayerWithWallComponentState[];
    customRenderUrl?: string;
    customRenderCompat: boolean;
    customRenderProxy: boolean;
} & HydrateScopeContext;

export const Route = createFileRoute('/wall/')({
    head: () => ({
        meta: [{ title: 'Wall Display · Vizzy Studio' }]
    }),
    component: WallApp
});

function WallApp() {
    const [layers, setLayers] = useState<LayerWithWallComponentState[]>([]);
    const [customRenderUrl, setCustomRenderUrl] = useState<string | undefined>();
    const [customRenderCompat, setCustomRenderCompat] = useState(false);
    const [customRenderProxy, setCustomRenderProxy] = useState(false);
    const [blackOverlayOpacity, setBlackOverlayOpacity] = useState(1);
    const [iframeGateCycle, setIframeGateCycle] = useState(0);

    const transitionPhaseRef = useRef<'visible' | 'fadingOut' | 'waitingIframes' | 'fadingIn'>(
        'visible'
    );
    const queuedHydrateRef = useRef<HydrateStagePayload | null>(null);
    const fadeTimerRef = useRef<number | null>(null);
    const iframeGateRef = useRef<{
        cycle: number;
        expected: number;
        loadedKeys: Set<string>;
        timeoutId: number | null;
    } | null>(null);
    const stageHydrateRef = useRef<((next: HydrateStagePayload) => void) | null>(null);
    const lastHydrateContextRef = useRef<{ hasContent: boolean } & HydrateScopeContext>({
        hasContent: false
    });
    const [frameabilityByUrl, setFrameabilityByUrl] = useState<
        Record<string, { ok: boolean; reason?: string; fallback?: string }>
    >({});
    const [deviceEnrollmentId, setDeviceEnrollmentId] = useState<string | null>(null);
    const [enrollmentQrDataUrl, setEnrollmentQrDataUrl] = useState<string | null>(null);
    const isClient = typeof window !== 'undefined';
    const searchParams = useMemo(() => {
        if (!isClient) return null;
        return new URLSearchParams(window.location.search);
    }, [isClient]);
    const wallId = useMemo(() => searchParams?.get('w') ?? null, [searchParams]);
    const hasMissingParams = useMemo(() => {
        if (!searchParams) return true;
        return !searchParams.has('w') || !searchParams.has('c') || !searchParams.has('r');
    }, [searchParams]);
    const showVisualDebugger = useMemo(() => searchParams?.get('m') === 'dev', [searchParams]);

    useEffect(() => {
        const html = document.documentElement;
        const body = document.body;
        const prevHtmlCursor = html.style.cursor;
        const prevBodyCursor = body.style.cursor;
        html.style.cursor = 'none';
        body.style.cursor = 'none';
        return () => {
            html.style.cursor = prevHtmlCursor;
            body.style.cursor = prevBodyCursor;
        };
    }, []);

    const myViewport = useMemo<Viewport>(() => {
        if (!searchParams) return { x: 0, y: 0, w: SCREEN_W, h: SCREEN_H };
        const col = parseInt(searchParams.get('c') || '0');
        const row = parseInt(searchParams.get('r') || '0');

        return { x: col * SCREEN_W, y: row * SCREEN_H, w: SCREEN_W, h: SCREEN_H };
    }, [searchParams]);

    // Initialize Engine with this screen's specific physical location
    const engine = useMemo(
        () => (wallId ? WallEngine.getInstance(wallId, myViewport) : null),
        [wallId, myViewport]
    );

    const clearFadeTimer = () => {
        if (fadeTimerRef.current !== null) {
            window.clearTimeout(fadeTimerRef.current);
            fadeTimerRef.current = null;
        }
    };

    const clearIframeGate = () => {
        const gate = iframeGateRef.current;
        if (gate && gate.timeoutId !== null) {
            window.clearTimeout(gate.timeoutId);
        }
        iframeGateRef.current = null;
    };

    const countExpectedGatedResources = (
        nextLayers: LayerWithWallComponentState[],
        nextCustomRenderUrl?: string
    ) => {
        if (nextCustomRenderUrl) return 1;
        return nextLayers.filter(
            (layer) => layer.config.visible && (layer.type === 'web' || layer.type === 'image')
        ).length;
    };

    const hasHydrateContent = (next: HydrateStagePayload) =>
        !!next.customRenderUrl || next.layers.some((layer) => layer.config.visible);

    const shouldFadeHydrate = (next: HydrateStagePayload) => {
        const prev = lastHydrateContextRef.current;
        const nextHasContent = hasHydrateContent(next);

        if (prev.hasContent !== nextHasContent) return true;
        if (!prev.hasContent && !nextHasContent) return false;

        return prev.projectId !== next.projectId || prev.commitId !== next.commitId;
    };

    const applyHydrateContent = (next: HydrateStagePayload) => {
        engine?.layers.clear();
        setLayers(next.layers);
        setCustomRenderUrl(next.customRenderUrl);
        setCustomRenderCompat(next.customRenderCompat);
        setCustomRenderProxy(next.customRenderProxy);
        lastHydrateContextRef.current = {
            hasContent: hasHydrateContent(next),
            projectId: next.projectId,
            commitId: next.commitId,
            slideId: next.slideId
        };
    };

    const beginFadeIn = () => {
        clearFadeTimer();
        clearIframeGate();
        transitionPhaseRef.current = 'fadingIn';
        setBlackOverlayOpacity(0);
        fadeTimerRef.current = window.setTimeout(() => {
            transitionPhaseRef.current = 'visible';
            const queued = queuedHydrateRef.current;
            if (!queued) return;
            queuedHydrateRef.current = null;
            stageHydrate(queued);
        }, HYDRATE_FADE_MS);
    };

    const stageHydrate = (next: HydrateStagePayload) => {
        if (transitionPhaseRef.current !== 'visible') {
            queuedHydrateRef.current = next;
            return;
        }

        if (!shouldFadeHydrate(next)) {
            clearFadeTimer();
            clearIframeGate();
            transitionPhaseRef.current = 'visible';
            setBlackOverlayOpacity(0);
            applyHydrateContent(next);
            return;
        }

        transitionPhaseRef.current = 'fadingOut';
        setBlackOverlayOpacity(1);
        clearFadeTimer();
        fadeTimerRef.current = window.setTimeout(() => {
            applyHydrateContent(next);
            const expected = countExpectedGatedResources(next.layers, next.customRenderUrl);
            if (expected <= 0) {
                beginFadeIn();
                return;
            }
            const cycle = Date.now();
            setIframeGateCycle(cycle);
            transitionPhaseRef.current = 'waitingIframes';
            clearIframeGate();
            iframeGateRef.current = {
                cycle,
                expected,
                loadedKeys: new Set(),
                timeoutId: window.setTimeout(() => {
                    beginFadeIn();
                }, HYDRATE_IFRAME_TIMEOUT_MS)
            };
        }, HYDRATE_FADE_MS);
    };
    const markIframeReady = (gateKey: string, cycle: number) => {
        const gate = iframeGateRef.current;
        if (!gate || gate.cycle !== cycle) return;
        gate.loadedKeys.add(gateKey);
        if (gate.loadedKeys.size >= gate.expected) {
            beginFadeIn();
        }
    };

    useEffect(() => {
        stageHydrateRef.current = stageHydrate;
    });

    useEffect(() => {
        if (window.__WALL_RELOADING__) {
            setTimeout(() => {
                engine?.sendJSON({ type: 'rehydrate_please' });
            }, 500);
            window.__WALL_RELOADING__ = false;
        }
    }, [engine]);

    useEffect(() => {
        if (!engine || !wallId) return;
        let refreshTimer: number | null = null;
        let cancelled = false;

        const refreshMediaCookie = () => {
            if (cancelled) return;
            if (refreshTimer !== null) {
                window.clearTimeout(refreshTimer);
                refreshTimer = null;
            }
            signedFetch(
                '/api/wall/media-cookie',
                { method: 'POST' },
                { deviceKind: 'wall', wallId }
            )
                .then((res) => {
                    if (!res.ok) throw new Error(`Media cookie refresh failed: ${res.status}`);
                })
                .catch((error) => {
                    console.warn('[Wall] Failed to refresh media auth cookie', error);
                })
                .finally(() => {
                    if (!cancelled) {
                        refreshTimer = window.setTimeout(
                            refreshMediaCookie,
                            WALL_MEDIA_COOKIE_REFRESH_MS
                        );
                    }
                });
        };

        const unsubscribe = engine.onReady(refreshMediaCookie);
        return () => {
            cancelled = true;
            unsubscribe();
            if (refreshTimer !== null) window.clearTimeout(refreshTimer);
        };
    }, [engine, wallId]);

    useEffect(() => {
        const unsubscribe = engine?.subscribeToLayoutUpdates((data) => {
            if (data.type === 'hydrate') {
                // Eagerly warm the browser cache for image URLs before React mounts them
                for (const layer of data.layers) {
                    if (layer.type === 'image' && layer.url && !warmedImageUrls.has(layer.url)) {
                        warmedImageUrls.add(layer.url);
                        const img = new Image();
                        img.src = layer.url;
                    }
                }
                stageHydrateRef.current?.({
                    layers: data.layers,
                    customRenderUrl: data.customRender?.url,
                    customRenderCompat: Boolean(data.customRender?.compat),
                    customRenderProxy: Boolean(data.customRender?.proxy),
                    projectId: data.projectId,
                    commitId: data.commitId,
                    slideId: data.slideId
                });
            } else if (data.type === 'upsert_layer') {
                // Eagerly warm the browser cache for incoming image layers
                if (
                    data.layer.type === 'image' &&
                    data.layer.url &&
                    !warmedImageUrls.has(data.layer.url)
                ) {
                    warmedImageUrls.add(data.layer.url);
                    const img = new Image();
                    img.src = data.layer.url;
                }
                setLayers((prev) => {
                    const existing = prev.find((l) => l.numericId === data.layer.numericId);
                    const nextLayer =
                        existing?.type === 'video' && data.layer.type === 'video'
                            ? { ...data.layer, playback: existing.playback ?? data.layer.playback }
                            : data.layer;
                    return [...prev.filter((l) => l.numericId !== data.layer.numericId), nextLayer];
                });
            } else if (data.type === 'delete_layer') {
                setLayers((prev) => prev.filter((l) => l.numericId !== data.numericId));
            } else if (data.type === 'device_enrollment') {
                setDeviceEnrollmentId(data.id);
            } else if (data.type === 'reboot') {
                setBlackOverlayOpacity(1);
                if (data.immediate) window.location.reload();
                else setTimeout(() => window.location.reload(), Math.random() * 1000 + 2000);
            }
        });
        let frameId: number;
        const loop = () => {
            engine?.layers.forEach((layer) => {
                if (!layer.el) return;
                if (!layer.config.visible) {
                    layer.el.style.opacity = '0';
                    layer.visible = false;
                    return;
                }

                const pos = engine.calculateCurrentPosition(layer);
                const effectivePos =
                    layer.type === 'line'
                        ? (() => {
                              const bounds = getLineBounds(layer.line);
                              if (!bounds) return pos;
                              return {
                                  ...pos,
                                  cx: bounds.cx,
                                  cy: bounds.cy,
                                  width: bounds.width,
                                  height: bounds.height
                              };
                          })()
                        : pos;

                // --- UPGRADED CLIENT-SIDE CULLING MATH (Rotated AABB) ---
                // 1. Get the scaled width and height
                const sw = effectivePos.width * effectivePos.scaleX;
                const sh = effectivePos.height * effectivePos.scaleY;

                // 2. Convert degrees to radians for JS Math functions
                const rad = effectivePos.rotation * (Math.PI / 180);

                // 3. Calculate the true dynamic bounding box of the rotated rectangle
                const cullingPadding = getCullingPadding(layer, effectivePos);
                const isCircleShape = layer.type === 'shape' && layer.shape === 'circle';
                const radiusX = isCircleShape
                    ? Math.max(sw, sh) / 2 + cullingPadding
                    : (sw / 2) * Math.abs(Math.cos(rad)) +
                      (sh / 2) * Math.abs(Math.sin(rad)) +
                      cullingPadding;
                const radiusY = isCircleShape
                    ? Math.max(sw, sh) / 2 + cullingPadding
                    : (sw / 2) * Math.abs(Math.sin(rad)) +
                      (sh / 2) * Math.abs(Math.cos(rad)) +
                      cullingPadding;

                // Protect against network NaN poisoning
                if (isNaN(radiusX) || isNaN(radiusY)) return;

                // 4. Evaluate against the screen viewport
                const cullCx = isCircleShape
                    ? effectivePos.cx - effectivePos.width / 2
                    : effectivePos.cx;
                const cullCy = isCircleShape
                    ? effectivePos.cy - effectivePos.height / 2
                    : effectivePos.cy;
                const isVisible =
                    cullCx + radiusX > myViewport.x &&
                    cullCx - radiusX < myViewport.x + myViewport.w &&
                    cullCy + radiusY > myViewport.y &&
                    cullCy - radiusY < myViewport.y + myViewport.h;

                if (isVisible) {
                    const localX = effectivePos.cx - effectivePos.width / 2 - myViewport.x;
                    const localY = effectivePos.cy - effectivePos.height / 2 - myViewport.y;

                    layer.visible = true;
                    layer.el.style.width = `${effectivePos.width}px`;
                    layer.el.style.height = `${effectivePos.height}px`;
                    layer.el.style.transform = `translate3d(${localX}px, ${localY}px, 0) rotate(${effectivePos.rotation}deg) scale(${effectivePos.scaleX}, ${effectivePos.scaleY})`;
                    layer.el.style.opacity = '1';
                } else {
                    layer.visible = false;
                    layer.el.style.opacity = '0';
                }
            });
            frameId = requestAnimationFrame(loop);
        };

        frameId = requestAnimationFrame(loop);
        return () => {
            unsubscribe?.();
            cancelAnimationFrame(frameId);
        };
    }, [engine, myViewport]);

    useEffect(() => {
        const deviceId = deviceEnrollmentId?.trim();
        if (!deviceId) return;
        let cancelled = false;
        Promise.resolve()
            .then(async () => {
                const identity = await getOrCreateDeviceIdentity('wall');
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
        return () => {
            clearFadeTimer();
            clearIframeGate();
        };
    }, []);

    useEffect(() => {
        const urlsToCheck = Array.from(
            new Set(
                layers.flatMap((layer) => {
                    if (
                        layer.type !== 'web' ||
                        layer.proxy === true ||
                        typeof layer.url !== 'string' ||
                        !/^https?:\/\//i.test(layer.url)
                    ) {
                        return [];
                    }
                    return [layer.url.trim()];
                })
            )
        ).filter((url) => frameabilityByUrl[url] === undefined);

        if (urlsToCheck.length === 0) return;

        let cancelled = false;
        for (const url of urlsToCheck) {
            signedFetch(
                `/api/proxy?check=1&url=${encodeURIComponent(url)}`,
                undefined,
                wallId ? { deviceKind: 'wall', wallId } : undefined
            )
                .then((res) => res.json())
                .then((data: { ok?: boolean; reason?: string; fallback?: string }) => {
                    if (cancelled) return;
                    setFrameabilityByUrl((prev) => {
                        if (prev[url] !== undefined) return prev;
                        return {
                            ...prev,
                            [url]: {
                                ok: data.ok === true,
                                reason: data.reason,
                                fallback: data.fallback
                            }
                        };
                    });
                })
                .catch(() => {
                    if (cancelled) return;
                    setFrameabilityByUrl((prev) => {
                        if (prev[url] !== undefined) return prev;
                        return {
                            ...prev,
                            [url]: {
                                ok: false,
                                reason: 'network_error',
                                fallback: '/web-nonet?l=wall'
                            }
                        };
                    });
                });
        }

        return () => {
            cancelled = true;
        };
    }, [layers, frameabilityByUrl, wallId]);

    if (deviceEnrollmentId) {
        return (
            <div className="flex h-screen w-screen flex-col items-center justify-center gap-5 bg-neutral-900 px-6 text-neutral-500">
                <TriangleDashedIcon size={56} weight="thin" />
                <p className="text-center text-xl font-medium">
                    This screen hasn't been registered yet
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
    }

    if (isClient && hasMissingParams)
        return (
            <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-neutral-900 text-neutral-400">
                <TriangleDashedIcon size={64} weight="thin" />
                <p className="text-lg">This screen hasn't been assigned a position yet</p>
            </div>
        );

    const stage = layers
        .filter((layer) => layer.config.visible)
        .map((layer) => {
            // Share the exact same spatial and registry logic across both media types
            const commonProps = {
                ref: (el: HTMLElement | null) => {
                    if (el) engine?.registerLayer(layer, el);
                },
                style: {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    transformOrigin: '50% 50%',
                    // transition: 'all .1s ease-out',
                    width: `${layer.config.width}px`,
                    height: `${layer.config.height}px`,
                    filter: toCssFilterString(layer.config.filters),
                    zIndex: layer.config.zIndex
                } as CSSProperties
            };

            if (layer.type === 'image')
                return (
                    <div key={layer.numericId} {...commonProps}>
                        <img
                            src={layer.url}
                            alt={`Layer ${layer.numericId}`}
                            loading="eager"
                            fetchPriority="high"
                            width="100%"
                            height="100%"
                            decoding="async"
                            className="block h-full w-full object-fill"
                            onLoad={() =>
                                markIframeReady(`img:${layer.numericId}`, iframeGateCycle)
                            }
                            onError={() =>
                                markIframeReady(`img:${layer.numericId}`, iframeGateCycle)
                            }
                        />
                    </div>
                );

            if (layer.type === 'text') {
                return (
                    <div
                        key={layer.numericId}
                        {...commonProps}
                        style={{
                            ...commonProps.style,
                            ...TEXT_BASE_STYLE,
                            overflow: 'hidden'
                        }}
                        dangerouslySetInnerHTML={{ __html: layer.textHtml }}
                    />
                );
            }

            if (layer.type === 'map') {
                return <MapWrapper key={layer.numericId} {...commonProps} layer={layer} />;
            }

            if (layer.type === 'web') {
                const webScale = layer.scale || 1;
                const shouldProxy =
                    layer.proxy === true && !!layer.url && /^https?:\/\//i.test(layer.url);
                const normalizedUrl = (layer.url ?? '').trim();
                const hasUsableUrl = !!normalizedUrl && /^https?:\/\//i.test(normalizedUrl);
                const frameability =
                    hasUsableUrl && layer.proxy !== true
                        ? (frameabilityByUrl[normalizedUrl] ?? null)
                        : null;
                const fallbackFromPrecheck =
                    frameability && !frameability.ok
                        ? (frameability.fallback ?? '/web-nonet?l=wall')
                        : null;
                const iframeSrc = shouldProxy
                    ? `/api/proxy?url=${encodeURIComponent(normalizedUrl)}`
                    : hasUsableUrl && frameability === null
                      ? '/web-placeholder?l=wall'
                      : hasUsableUrl && frameability?.ok === true
                        ? normalizedUrl
                        : (fallbackFromPrecheck ?? '/web-nonet?l=wall');
                const iframeProps = {
                    ref: commonProps.ref,
                    style: {
                        ...commonProps.style,
                        width: `${layer.config.width / webScale}px`,
                        height: `${layer.config.height / webScale}px`,
                        cursor: 'none',
                        pointerEvents: 'none' as const,
                        transform: `scale(${webScale})`,
                        transformOrigin: '0 0'
                    }
                };
                return (
                    <iframe
                        key={`${layer.numericId}:${iframeGateCycle}`}
                        {...iframeProps}
                        src={iframeSrc}
                        title={`Web layer ${layer.numericId}`}
                        sandbox="allow-scripts allow-same-origin"
                        onLoad={() => {
                            markIframeReady(`web:${layer.numericId}`, iframeGateCycle);
                        }}
                        onError={(e) => {
                            markIframeReady(`web:${layer.numericId}`, iframeGateCycle);
                            const iframe = e.currentTarget;
                            if (
                                !iframe.src.includes('/web-nonet') &&
                                !iframe.src.includes('/web-corsissue')
                            ) {
                                iframe.src = '/web-nonet?l=wall';
                            }
                        }}
                        className="bg-background"
                    />
                );
            }

            if (layer.type === 'video')
                return (
                    <video
                        key={layer.numericId}
                        {...commonProps}
                        src={layer.url}
                        preload="auto"
                        muted
                        playsInline
                        loop={layer.loop ?? true}
                        className="object-cover"
                    />
                );

            if (layer.type === 'line') {
                const bounds = getLineBounds(layer.line);
                if (!bounds) return null;
                let svgPoints = [];
                for (let i = 0; i < layer.line.length; i += 2)
                    svgPoints.push(
                        `${Math.round(layer.line[i] - bounds.cx + bounds.width / 2)},${Math.round(layer.line[i + 1] - bounds.cy + bounds.height / 2)}`
                    );
                return (
                    <div
                        key={layer.numericId}
                        {...commonProps}
                        className="origin-top-left"
                        style={{
                            ...commonProps.style,
                            width: `${bounds.width}px`,
                            height: `${bounds.height}px`
                        }}
                    >
                        <svg
                            width={bounds.width}
                            height={bounds.height}
                            className="overflow-visible"
                            xmlns="http://www.w3.org/2000/svg"
                        >
                            <polyline
                                points={svgPoints.join(' ')}
                                fill="none"
                                stroke={layer.strokeColor}
                                strokeWidth={layer.strokeWidth}
                                strokeDasharray={layer.strokeDash.join(' ')}
                                strokeDashoffset={(layer.strokeDash[0] ?? 0) / 2}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        </svg>
                    </div>
                );
            }

            if (layer.type === 'shape') {
                if (layer.shape === 'rectangle')
                    return (
                        <div key={layer.numericId} {...commonProps}>
                            <svg
                                width={layer.config.width}
                                height={layer.config.height}
                                className="overflow-visible"
                                xmlns="http://www.w3.org/2000/svg"
                            >
                                <rect
                                    x={0}
                                    y={0}
                                    width={layer.config.width}
                                    height={layer.config.height}
                                    fill={layer.fill}
                                    stroke={layer.strokeColor}
                                    strokeDasharray={layer.strokeDash.join(' ')}
                                    strokeDashoffset={(layer.strokeDash[0] ?? 0) / 2}
                                    strokeWidth={layer.strokeWidth}
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    overflow="visible"
                                    //    rx=""
                                />
                            </svg>
                        </div>
                    );

                if (layer.shape === 'circle')
                    return (
                        <div key={layer.numericId} {...commonProps}>
                            <svg
                                width={layer.config.width}
                                height={layer.config.height}
                                className="overflow-visible"
                                xmlns="http://www.w3.org/2000/svg"
                            >
                                <circle
                                    r={layer.config.width / 2}
                                    fill={layer.fill}
                                    stroke={layer.strokeColor}
                                    strokeDasharray={layer.strokeDash.join(' ')}
                                    strokeWidth={layer.strokeWidth}
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    overflow="visible"
                                />
                            </svg>
                        </div>
                    );
            }
            return null;
        });

    const stageContent = (() => {
        if (!customRenderUrl) return stage;
        const iframeSrc = new URL(customRenderUrl);
        if (!customRenderCompat) {
            iframeSrc.searchParams.set('c', String(myViewport.x / SCREEN_W));
            iframeSrc.searchParams.set('r', String(myViewport.y / SCREEN_H));
        }
        const finalSrc =
            customRenderProxy && /^https?:\/\//i.test(iframeSrc.toString())
                ? `/api/proxy?url=${encodeURIComponent(iframeSrc.toString())}`
                : iframeSrc.toString();
        const worldWidth = SCREEN_W * COLS;
        const worldHeight = SCREEN_H * ROWS;
        return (
            <iframe
                key={`custom-render:${iframeGateCycle}`}
                title="Custom Render Wall"
                src={finalSrc}
                sandbox="allow-scripts allow-same-origin"
                style={{
                    position: 'absolute',
                    top: customRenderCompat ? `${-myViewport.y}px` : 0,
                    left: customRenderCompat ? `${-myViewport.x}px` : 0,
                    width: customRenderCompat ? `${worldWidth}px` : `${SCREEN_W}px`,
                    height: customRenderCompat ? `${worldHeight}px` : `${SCREEN_H}px`,
                    cursor: 'none',
                    pointerEvents: 'none',
                    border: 'none'
                }}
                allow="autoplay; fullscreen"
                onLoad={() => {
                    markIframeReady('custom-render', iframeGateCycle);
                }}
                onError={() => {
                    markIframeReady('custom-render', iframeGateCycle);
                }}
            />
        );
    })();

    const backgroundLayer = layers.find(
        (l): l is Extract<LayerWithWallComponentState, { type: 'background' }> =>
            l.type === 'background' && l.config.visible
    );

    return (
        <div className="absolute z-50 m-0 block min-h-screen min-w-screen cursor-none overflow-hidden bg-black">
            {/* Visual Debugger: Shows the Screen ID in the corner */}
            {showVisualDebugger ? (
                <div
                    className="min-blend-plus-lighter absolute top-2 left-2 z-1000000 border-2 border-red-800 p-2 font-mono text-gray-500"
                    style={{ width: `${SCREEN_W - 2 * 10}px`, height: `${SCREEN_H - 2 * 10}px` }}
                >
                    SCREEN&gt; C:{myViewport.x / SCREEN_W} R:{myViewport.y / SCREEN_H}
                </div>
            ) : null}
            {backgroundLayer && (
                <WallBackgroundCanvas
                    layer={backgroundLayer}
                    col={myViewport.x / SCREEN_W}
                    row={myViewport.y / SCREEN_H}
                    getNow={engine ? () => engine.getServerTime() : Date.now}
                />
            )}
            {stageContent}
            <div
                className="pointer-events-none absolute inset-0 z-1000001 bg-black"
                style={{
                    opacity: blackOverlayOpacity,
                    transition: `opacity ${HYDRATE_FADE_MS}ms linear`
                }}
            />
        </div>
    );
}

// --- VITE HMR DEFENSE STRATEGY ---
if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        if (typeof window !== 'undefined') {
            window.__WALL_RELOADING__ = true;
        }
    });
}
