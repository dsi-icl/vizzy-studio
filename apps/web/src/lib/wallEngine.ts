'use client';

import { BusClient } from './busClient';
import {
    GSMessageSchema,
    type GSMessage,
    type LayerWithWallComponentState,
    type LayerWithWallEngineState
} from './types';

const LAYER_ANIMATION_DURATION = 100;

export interface Viewport {
    x: number;
    y: number;
    w: number;
    h: number;
}

type LayoutUpdateCallback = (data: GSMessage) => void;

export class WallEngine {
    private bus: BusClient;
    private pingTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectClearTimer: ReturnType<typeof setTimeout> | null = null;
    private playbackStartRafs = new Map<number, number>();
    private playbackDriftRafs = new Map<number, number>();

    // Clock Sync State
    private clockOffset = 0;
    private bestRTT = Infinity;
    private rttResetTimer: ReturnType<typeof setTimeout> | null = null;

    // Render State
    public layers = new Map<number, LayerWithWallEngineState>();
    private layoutCallbacks = new Set<LayoutUpdateCallback>();
    public viewport: Viewport;
    public wallId: string;
    public customRenderUrl: string | undefined;
    public boundSource: 'live' | 'gallery' | undefined;

    private constructor(wallId: string, viewport: Viewport) {
        this.wallId = wallId;
        this.viewport = viewport;

        this.bus = new BusClient({
            auth: {
                kind: 'wall',
                wallId: this.wallId,
                col: Math.round(viewport.x / 1920),
                row: Math.round(viewport.y / 1080)
            },
            onOpen: () => {
                console.log('Wall Engine: Connected to Master Server');
                // Reset clock sync on every (re)connect
                this.clockOffset = 0;
                this.bestRTT = Infinity;
                if (this.pingTimer) clearTimeout(this.pingTimer);
                this.startClockSync();
            },
            onMessage: (event) => this.handleMessage(event)
        });

        // On reconnecting: avoid immediate full clear/hydrate churn during short network blips.
        // Only clear if disconnect is sustained.
        this.bus.onSocketStateChange((status) => {
            if (status === 'reconnecting') {
                if (this.reconnectClearTimer) clearTimeout(this.reconnectClearTimer);
                this.reconnectClearTimer = setTimeout(() => {
                    if (this.bus.status === 'connected') return;
                    this.layers.clear();
                    this.layoutCallbacks.forEach((cb) => cb({ type: 'hydrate', layers: [] }));
                }, 8_000);
            } else if (status === 'connected') {
                if (this.reconnectClearTimer) {
                    clearTimeout(this.reconnectClearTimer);
                    this.reconnectClearTimer = null;
                }
            }
        });
    }

    /** Access the underlying WebSocket (changes on each reconnect) */
    public get ws(): WebSocket {
        return this.bus.ws;
    }

    public destroy() {
        console.log('Wall Engine: Assassinating ghost instance...');
        if (this.pingTimer) clearTimeout(this.pingTimer);
        if (this.reconnectClearTimer) clearTimeout(this.reconnectClearTimer);
        for (const rafId of this.playbackStartRafs.values()) cancelAnimationFrame(rafId);
        this.playbackStartRafs.clear();
        for (const rafId of this.playbackDriftRafs.values()) cancelAnimationFrame(rafId);
        this.playbackDriftRafs.clear();
        this.bus.destroy();
        this.layoutCallbacks.clear();
    }

    // --- SINGLETON ACCESSOR ---
    public static getInstance(wallId: string, viewport?: Viewport): WallEngine {
        if (typeof window === 'undefined') {
            throw new Error('WallEngine can only be used in the browser');
        }
        // Escape Vite's module scope by anchoring the Singleton to the Window
        if (!window.__WALL_ENGINE__) {
            if (!viewport) throw new Error('Viewport must be provided on first initialization');
            window.__WALL_ENGINE__ = new WallEngine(wallId, viewport);
        }
        return window.__WALL_ENGINE__;
    }

    // --- REACT INTERFACE ---
    public subscribeToLayoutUpdates(callback: LayoutUpdateCallback) {
        this.layoutCallbacks.add(callback);
        return () => this.layoutCallbacks.delete(callback);
    }

    public onReady(callback: () => void) {
        return this.bus.onReady(callback);
    }

    public registerLayer(layer: LayerWithWallComponentState, el: HTMLElement) {
        let layerPtr = this.layers.get(layer.numericId);
        if (!layerPtr) {
            layerPtr = {
                ...layer,
                el,
                animDuration: LAYER_ANIMATION_DURATION,
                animStartTime: 0,
                startPos: { ...layer.config },
                targetPos: { ...layer.config }
            };
            this.layers.set(layer.numericId, layerPtr);
        } else {
            // Hydrate can reuse numericIds across slides. Always refresh the cached layer
            // payload so stale visibility/position from a previous slide cannot leak.
            const preservedVideoPlayback =
                layerPtr.type === 'video' && layer.type === 'video'
                    ? (layerPtr.playback ?? layer.playback)
                    : null;

            Object.assign(layerPtr, layer);
            layerPtr.startPos = { ...layer.config };
            layerPtr.targetPos = { ...layer.config };
            layerPtr.animStartTime = 0;
            layerPtr.animDuration = LAYER_ANIMATION_DURATION;

            if (layer.type === 'video' && preservedVideoPlayback && layerPtr.type === 'video') {
                layerPtr.playback = preservedVideoPlayback;
            }
        }
        layerPtr.el = el; // Update ref if React re-rendered
        if (layerPtr.type !== 'video' || layer.type !== 'video') return;
        layerPtr.playback = layer.playback; // Ensure we have the latest state

        // Evaluate the timeline and start playing/seeking immediately
        this.handlePlaybackStateChange(layerPtr);
    }

    // --- CLOCK SYNC ---
    public getServerTime(): number {
        return Date.now() + this.clockOffset;
    }

    private startClockSync() {
        const sendPing = () => {
            const buffer = new ArrayBuffer(9);
            const view = new DataView(buffer);
            view.setUint8(0, 0x08);
            view.setFloat64(1, Date.now(), true);
            this.bus.sendRaw(buffer);
            this.pingTimer = setTimeout(sendPing, 2000);
        };
        sendPing();
    }

    private handlePong(data: Omit<Extract<GSMessage, { type: 'pong' }>, 'type'>) {
        const rtt = Date.now() - data.t0 - (data.t2 - data.t1);
        if (rtt < this.bestRTT) {
            this.bestRTT = rtt;
            this.clockOffset = (data.t1 - data.t0 + (data.t2 - Date.now())) / 2;
        }
        // Periodically reset bestRTT to allow network environment changes to register.
        if (this.rttResetTimer) clearTimeout(this.rttResetTimer);
        this.rttResetTimer = setTimeout(() => {
            this.bestRTT = Infinity;
        }, 5000);
    }

    // --- MESSAGE ROUTING ---
    private handleMessage(event: MessageEvent) {
        // A. BINARY FAST-PATH (High-Frequency Movement)
        if (event.data instanceof ArrayBuffer) {
            const view = new DataView(event.data);
            const opcode = view.getUint8(0);

            if (opcode === 0x09) {
                const t0 = view.getFloat64(1, true);
                const t1 = view.getFloat64(9, true);
                const t2 = view.getFloat64(17, true);
                this.handlePong({ t0, t1, t2 });
                return;
            }

            // VIDEO_SYNC binary: batched playback state from VSYNC loop
            if (opcode === 0x15) {
                const count = view.getUint16(1, true);
                let offset = 3;
                for (let i = 0; i < count; i++) {
                    const numericId = view.getUint16(offset, true);
                    const status =
                        view.getUint8(offset + 2) === 1
                            ? ('playing' as const)
                            : ('paused' as const);
                    const anchorMediaTime = view.getFloat64(offset + 3, true);
                    const anchorServerTime = view.getFloat64(offset + 11, true);

                    const layer = this.layers.get(numericId);
                    if (layer?.type === 'video') {
                        layer.playback = { status, anchorMediaTime, anchorServerTime };
                        this.handlePlaybackStateChange(layer);
                    }
                    offset += 19;
                }
                return;
            }

            if (opcode === 0x05) {
                // Opcode: Batched Move
                const count = view.getUint16(1, true);
                let offset = 3;
                for (let i = 0; i < count; i++) {
                    const id = view.getUint16(offset, true);
                    const layer = this.layers.get(id);

                    if (layer) {
                        // Set current visual position as the new start, incoming data as the new target
                        layer.startPos = {
                            ...layer.startPos,
                            ...this.calculateCurrentPosition(layer)
                        };
                        layer.targetPos = {
                            ...layer.targetPos,
                            cx: view.getFloat32(offset + 2, true),
                            cy: view.getFloat32(offset + 6, true),
                            width: view.getFloat32(offset + 10, true),
                            height: view.getFloat32(offset + 14, true),
                            scaleX: view.getFloat32(offset + 18, true),
                            scaleY: view.getFloat32(offset + 22, true),
                            rotation: view.getFloat32(offset + 26, true)
                        };
                        layer.animStartTime = this.getServerTime();
                        layer.animDuration = 100; // Matches expected editor broadcast rate
                    }
                    offset += 30;
                }
            }
            return;
        }

        // B. JSON SLOW-PATH (Low-Frequency Events)
        if (typeof event.data === 'string') {
            const data = GSMessageSchema.parse(JSON.parse(event.data));

            if (data.type === 'hydrate') {
                this.customRenderUrl = data.customRender?.url;
                this.boundSource = data.boundSource;
            }

            if (
                data.type === 'hydrate' ||
                data.type === 'upsert_layer' ||
                data.type === 'delete_layer' ||
                data.type === 'reboot' ||
                data.type === 'device_enrollment'
            ) {
                this.layoutCallbacks.forEach((cb) => cb(data));
            } else if (data.type === 'video_sync' || data.type === 'video_seek') {
                const layer = this.layers.get(data.numericId);
                if (layer?.type === 'video') {
                    layer.playback = data.playback ??
                        layer.playback ?? {
                            status: 'paused',
                            anchorMediaTime: data.type === 'video_seek' ? data.mediaTime : 0,
                            anchorServerTime: 0
                        };
                    this.handlePlaybackStateChange(layer);
                }
            }
        }
    }

    // --- PLAYBACK & SYNC LOGIC ---
    private handlePlaybackStateChange(layer: Extract<LayerWithWallEngineState, { type: 'video' }>) {
        const video = layer.el as HTMLVideoElement;
        if (!video || typeof video.play !== 'function') return;
        const layerId = layer.numericId;
        const pendingStartRaf = this.playbackStartRafs.get(layerId);
        if (pendingStartRaf !== undefined) {
            cancelAnimationFrame(pendingStartRaf);
            this.playbackStartRafs.delete(layerId);
        }
        const pendingDriftRaf = this.playbackDriftRafs.get(layerId);
        if (pendingDriftRaf !== undefined) {
            cancelAnimationFrame(pendingDriftRaf);
            this.playbackDriftRafs.delete(layerId);
        }

        // CRITICAL HYDRATION FIX:
        // Wait for the video to parse its headers before attempting to seek
        if (video.readyState === 0) {
            video.addEventListener(
                'loadedmetadata',
                () => {
                    this.handlePlaybackStateChange(layer);
                },
                { once: true }
            );
            return;
        }
        if (video.readyState < 2) {
            // 2 = HAVE_CURRENT_DATA
            video.addEventListener(
                'loadeddata',
                () => {
                    this.handlePlaybackStateChange(layer);
                },
                { once: true }
            );
            return;
        }

        if (layer.playback.status === 'paused') {
            video.pause();
            video.playbackRate = 1.0;
            if (Math.abs(video.currentTime - layer.playback.anchorMediaTime) > 0.05) {
                video.currentTime = layer.playback.anchorMediaTime;
            }
            layer.rvfcActive = false;
        } else if (layer.playback.status === 'playing') {
            const checkTime = () => {
                const now = this.getServerTime();

                if (now >= layer.playback.anchorServerTime) {
                    // If we joined late, calculate exactly where we should be NOW
                    let expectedTime =
                        layer.playback.anchorMediaTime +
                        (now - layer.playback.anchorServerTime) / 1000;
                    if ((layer.loop ?? true) && layer.duration) {
                        expectedTime = expectedTime % layer.duration;
                    }

                    if (Math.abs(video.currentTime - expectedTime) > 0.5) {
                        video.currentTime = expectedTime;
                    }

                    video.play().catch((e) => console.error('Autoplay blocked:', e));

                    // Attach Drift Controller safely
                    if ('requestVideoFrameCallback' in video) {
                        if (!layer.rvfcActive) {
                            layer.rvfcActive = true; // Lock it so it doesn't duplicate
                            video.requestVideoFrameCallback((_n, m) =>
                                this.driftController(m, layer)
                            );
                        }
                    } else {
                        // Fallback for browsers without RVFC: run drift correction at frame rate.
                        const driftLoop = () => {
                            if (layer.playback.status !== 'playing' || !layer.el) {
                                this.playbackDriftRafs.delete(layerId);
                                return;
                            }
                            this.driftController(undefined, layer);
                            const rafId = requestAnimationFrame(driftLoop);
                            this.playbackDriftRafs.set(layerId, rafId);
                        };
                        const rafId = requestAnimationFrame(driftLoop);
                        this.playbackDriftRafs.set(layerId, rafId);
                    }
                    this.playbackStartRafs.delete(layerId);
                } else {
                    const rafId = requestAnimationFrame(checkTime);
                    this.playbackStartRafs.set(layerId, rafId);
                }
            };

            const rafId = requestAnimationFrame(checkTime);
            this.playbackStartRafs.set(layerId, rafId);
        }
    }

    private driftController(
        _metadata: VideoFrameCallbackMetadata | undefined,
        layer: Extract<LayerWithWallEngineState, { type: 'video' }>
    ) {
        if (layer.playback.status !== 'playing' || !layer.el) {
            layer.rvfcActive = false;
            const pendingDriftRaf = this.playbackDriftRafs.get(layer.numericId);
            if (pendingDriftRaf !== undefined) {
                cancelAnimationFrame(pendingDriftRaf);
                this.playbackDriftRafs.delete(layer.numericId);
            }
            return;
        }

        const video = layer.el as HTMLVideoElement;
        const currentServerTime = this.getServerTime();

        // Master timeline formula
        let expectedTime =
            layer.playback.anchorMediaTime +
            (currentServerTime - layer.playback.anchorServerTime) / 1000;
        if ((layer.loop ?? true) && layer.duration) {
            expectedTime = expectedTime % layer.duration;
        }
        // Use element currentTime (same strategy as editor); metadata.mediaTime can diverge
        // across browser implementations and loop boundaries.
        const drift = expectedTime - video.currentTime;

        // Apply drift corrections
        if (drift > 0.5) {
            video.currentTime = expectedTime; // Hard seek if hopelessly lost
        } else if (drift > 0.3) {
            video.playbackRate = 1.05; // Subtly speed up
        } else if (drift < -0.3) {
            video.playbackRate = 0.95; // Subtly slow down
        } else {
            video.playbackRate = 1.0; // Frame locked
        }

        // Loop exactly when the next hardware frame is presented
        if ('requestVideoFrameCallback' in video) {
            video.requestVideoFrameCallback((_n, m) => this.driftController(m, layer));
        }
    }

    // --- MATH & LERP ---
    private lerp(start: number, end: number, t: number): number {
        return start + (end - start) * t;
    }

    public calculateCurrentPosition(layer: LayerWithWallEngineState) {
        if (!layer.animStartTime || layer.animDuration <= 0) return layer.targetPos;

        let t = (this.getServerTime() - layer.animStartTime) / layer.animDuration;
        t = Math.max(0, Math.min(1, t));

        return {
            cx: this.lerp(layer.startPos.cx, layer.targetPos.cx, t),
            cy: this.lerp(layer.startPos.cy, layer.targetPos.cy, t),
            scaleX: this.lerp(layer.startPos.scaleX, layer.targetPos.scaleX, t),
            scaleY: this.lerp(layer.startPos.scaleY, layer.targetPos.scaleY, t),
            rotation: this.lerp(layer.startPos.rotation, layer.targetPos.rotation, t),
            width: this.lerp(layer.startPos.width, layer.targetPos.width, t),
            height: this.lerp(layer.startPos.height, layer.targetPos.height, t),
            zIndex: layer.config.zIndex
        };
    }

    public sendJSON = (data: GSMessage) => {
        this.bus.sendJSON(data);
    };
}

// --- VITE HMR DEFENSE STRATEGY ---
if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        if (typeof window !== 'undefined' && window.__WALL_ENGINE__) {
            window.__WALL_ENGINE__.destroy();
            window.__WALL_ENGINE__ = undefined;
        }
    });
}
