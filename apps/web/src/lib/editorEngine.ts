'use client';

import { throttle } from '@tanstack/pacer';
import { toast } from 'sonner';

import { BusClient } from './busClient';
import { type ConnectionStatus } from './reconnectingWs';
import { GSMessageSchema, type GSMessage, type Layer } from './types';

/** How often the local pointer is put on the wire while it keeps moving. */
export const POINTER_BROADCAST_INTERVAL_MS = 100;
/**
 * Repeat rate for a pointer that is resting on the stage. Movement alone would
 * stop the throttle firing, and peers would age out someone who is simply
 * holding still over the thing they are talking about.
 */
export const POINTER_HEARTBEAT_INTERVAL_MS = 1000;

type SaveResponseCallback = (data: Extract<GSMessage, { type: 'stage_save_response' }>) => void;
type ServerMessageCallback = (data: GSMessage) => void;
type BinaryMessageCallback = (
    id: number,
    cx: number,
    cy: number,
    width: number,
    height: number,
    scaleX: number,
    scaleY: number,
    rotation: number
) => void;

export interface LayerBinaryMove {
    numericId: number;
    x: number;
    y: number;
    width: number;
    height: number;
    scaleX: number;
    scaleY: number;
    rotation: number;
}
type PlaybackCallback = (
    id: number,
    playback: Extract<Layer, { type: 'video' }>['playback']
) => void;
type PointerCallback = (data: Extract<GSMessage, { type: 'pointer' }>) => void;
type ConnectionStatusCallback = (status: ConnectionStatus) => void;
type BindOverrideResultCallback = (
    data: Extract<GSMessage, { type: 'bind_override_result' }>
) => void;

/** How long to wait for the server to confirm a layer reached the commit. */
const LAYER_CREATE_ACK_TIMEOUT_MS = 15_000;

export class EditorEngine {
    private bus: BusClient;
    private pendingLayerCreates = new Map<
        string,
        { numericId: number; timer: ReturnType<typeof setTimeout> }
    >();
    private messageCallbacks = new Set<ServerMessageCallback>();
    private binaryCallbacks = new Set<BinaryMessageCallback>();
    private playbackCallbacks = new Set<PlaybackCallback>();
    private playbackStates = new Map<number, Extract<Layer, { type: 'video' }>['playback']>();
    private pointerCallbacks = new Set<PointerCallback>();
    private saveCallbacks = new Set<SaveResponseCallback>();
    private connectionStatusCallbacks = new Set<ConnectionStatusCallback>();
    private bindOverrideResultCallbacks = new Set<BindOverrideResultCallback>();
    private bufferedHydration: Extract<GSMessage, { type: 'hydrate' }> | null = null;
    private hydrateResolver: ((data: Extract<GSMessage, { type: 'hydrate' }>) => void) | null =
        null;
    private clockOffset = 0;
    private bestRTT = Infinity;
    private pingTimer: ReturnType<typeof setTimeout> | null = null;
    private currentProjectId: string | null = null;
    private currentCommitId: string | null = null;
    private currentSlideId: string | null = null;

    private constructor() {
        this.bus = new BusClient({
            auth: { kind: 'editor' },
            onOpen: () => {
                console.log('Editor Engine: Connected to Server');
                // Reset clock sync state on every (re)connect
                this.clockOffset = 0;
                this.bestRTT = Infinity;
                if (this.pingTimer) clearTimeout(this.pingTimer);
                this.startClockSync();

                // Re-join the scope if we were already in one (reconnection case)
                if (this.currentProjectId && this.currentCommitId && this.currentSlideId) {
                    this.joinScope(
                        this.currentProjectId,
                        this.currentCommitId,
                        this.currentSlideId
                    );
                }
            },
            onMessage: (event) => this.handleMessage(event)
        });

        this.bus.onSocketStateChange((status) => {
            this.connectionStatusCallbacks.forEach((cb) => cb(status));
        });
        this.bus.onReady(() => {
            if (!this.currentProjectId || !this.currentCommitId || !this.currentSlideId) return;
            this.sendJSON({
                type: 'switch_scope',
                projectId: this.currentProjectId,
                commitId: this.currentCommitId,
                slideId: this.currentSlideId
            });
            if (this.boundWallId) {
                const requestId = this.makeBindRequestId();
                this.lastBindRequestId = requestId;
                this.sendJSON({
                    type: 'request_bind_wall',
                    requestId,
                    wallId: this.boundWallId,
                    projectId: this.currentProjectId,
                    commitId: this.currentCommitId,
                    slideId: this.currentSlideId
                });
            }
        });
    }

    /** Access the underlying WebSocket (changes on each reconnect) */
    public get ws(): WebSocket {
        return this.bus.ws;
    }

    private handleMessage(event: MessageEvent) {
        // --- BINARY FAST-PATH PARSER ---
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

            if (opcode === 0x05) {
                const count = view.getUint16(1, true);
                let offset = 3;
                for (let i = 0; i < count; i++) {
                    const id = view.getUint16(offset, true);
                    const cx = view.getFloat32(offset + 2, true);
                    const cy = view.getFloat32(offset + 6, true);
                    const width = view.getFloat32(offset + 10, true);
                    const height = view.getFloat32(offset + 14, true);
                    const scaleX = view.getFloat32(offset + 18, true);
                    const scaleY = view.getFloat32(offset + 22, true);
                    const rotation = view.getFloat32(offset + 26, true);

                    this.binaryCallbacks.forEach((cb) =>
                        cb(id, cx, cy, width, height, scaleX, scaleY, rotation)
                    );
                    offset += 30;
                }
            }
            return;
        }

        // --- JSON SLOW-PATH ---
        if (typeof event.data === 'string') {
            let data: GSMessage;
            try {
                data = GSMessageSchema.parse(JSON.parse(event.data));
            } catch (err) {
                console.warn('[EditorEngine] Failed to parse message:', err, event.data);
                return;
            }

            if (data.type === 'video_sync' || data.type === 'video_seek') {
                const nextPlayback = data.playback ??
                    this.playbackStates.get(data.numericId) ?? {
                        status: 'paused',
                        anchorMediaTime: data.type === 'video_seek' ? data.mediaTime : 0,
                        anchorServerTime: 0
                    };
                this.playbackStates.set(data.numericId, nextPlayback);
                this.playbackCallbacks.forEach((cb) => cb(data.numericId, nextPlayback));
                return;
            }

            if (data.type === 'pointer') {
                // Kept off the generic channel: subscribing there consumes any
                // buffered hydrate, and presence must never disturb loading.
                this.pointerCallbacks.forEach((cb) => cb(data));
                return;
            }

            if (data.type === 'stage_save_response') {
                this.saveCallbacks.forEach((cb) => cb(data));
                return;
            }

            if (data.type === 'bind_override_result') {
                this.bindOverrideResultCallbacks.forEach((cb) => cb(data));
                return;
            }

            if (data.type === 'auth_denied') {
                toast.error('Session expired. Reconnect after signing in again.');
                return;
            }

            if (data.type === 'layer_create_response') {
                this.settleLayerCreate(data);
                return;
            }

            if (data.type === 'hydrate') {
                this.bufferedHydration = data;
                data.layers.forEach((l) => {
                    if (l.type === 'video' && l.playback && !this.playbackStates.has(l.numericId))
                        this.playbackStates.set(l.numericId, l.playback);
                });
                if (this.hydrateResolver) {
                    this.hydrateResolver(data);
                    this.hydrateResolver = null;
                }
            }

            this.messageCallbacks.forEach((cb) => cb(data));
        }
    }

    /**
     * Resolve a pending layer creation. A failed write means the layer exists
     * only in this browser, so we tell the user and reload the slide rather
     * than let them keep editing something that was never saved.
     */
    private settleLayerCreate(
        response: Extract<GSMessage, { type: 'layer_create_response' }>
    ): void {
        const pending = this.pendingLayerCreates.get(response.createRequestId);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingLayerCreates.delete(response.createRequestId);
        }
        if (response.success) return;

        toast.error(
            response.error ??
                `Layer ${response.numericId} was not saved. Reloading the slide to avoid losing work.`
        );
        this.sendJSON({ type: 'rehydrate_please' });
    }

    /** Track a layer creation until the server confirms it reached the commit. */
    private trackLayerCreate(createRequestId: string, numericId: number): void {
        const timer = setTimeout(() => {
            this.failLayerCreate(
                createRequestId,
                `Layer ${numericId} was not confirmed as saved. Reloading the slide to avoid losing work.`
            );
        }, LAYER_CREATE_ACK_TIMEOUT_MS);
        this.pendingLayerCreates.set(createRequestId, { numericId, timer });
    }

    /** Abandon a pending creation and recover the slide from the server. */
    private failLayerCreate(createRequestId: string, message: string): void {
        const pending = this.pendingLayerCreates.get(createRequestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingLayerCreates.delete(createRequestId);
        toast.error(message);
        this.sendJSON({ type: 'rehydrate_please' });
    }

    public static getInstance(): EditorEngine {
        if (typeof window === 'undefined') {
            throw new Error('EditorEngine can only be used in the browser');
        }
        if (!window.__EDITOR_ENGINE__) {
            window.__EDITOR_ENGINE__ = new EditorEngine();
        }
        return window.__EDITOR_ENGINE__;
    }

    public destroy() {
        console.log('Editor Engine: Assassinating ghost instance...');
        if (this.pingTimer) clearTimeout(this.pingTimer);
        this.stopPointerBroadcast();
        // Otherwise these fire after teardown and toast about a slide the user
        // has already navigated away from.
        for (const pending of this.pendingLayerCreates.values()) clearTimeout(pending.timer);
        this.pendingLayerCreates.clear();
        this.bus.destroy();
        this.messageCallbacks.clear();
        this.binaryCallbacks.clear();
        this.pointerCallbacks.clear();
        this.playbackCallbacks.clear();
        this.connectionStatusCallbacks.clear();
        this.bindOverrideResultCallbacks.clear();
    }

    /**
     * Returns a promise that resolves with the next hydrate message.
     * If a hydrate was already buffered (from joinScope), resolves immediately.
     * Call clearBufferedHydration() before joinScope to ensure a fresh wait.
     */
    public waitForHydrate(): Promise<Extract<GSMessage, { type: 'hydrate' }>> {
        if (this.bufferedHydration) {
            const data = this.bufferedHydration;
            this.bufferedHydration = null;
            return Promise.resolve(data);
        }
        return new Promise((resolve) => {
            this.hydrateResolver = resolve;
        });
    }

    /** Clear any buffered hydration so the next waitForHydrate waits for a fresh message. */
    public clearBufferedHydration() {
        this.bufferedHydration = null;
        this.hydrateResolver = null;
    }

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
            this.pingTimer = setTimeout(sendPing, 3000);
        };
        sendPing();
    }

    private handlePong(data: Omit<Extract<GSMessage, { type: 'pong' }>, 'type'>) {
        const rtt = Date.now() - data.t0 - (data.t2 - data.t1);
        if (rtt < this.bestRTT) {
            this.bestRTT = rtt;
            this.clockOffset = (data.t1 - data.t0 + (data.t2 - Date.now())) / 2;
        }
    }

    public subscribeToJson(cb: ServerMessageCallback) {
        this.messageCallbacks.add(cb);
        if (this.bufferedHydration) {
            cb(this.bufferedHydration);
            this.bufferedHydration = null;
        }
        return () => {
            this.messageCallbacks.delete(cb);
        };
    }

    public subscribeToBinary(cb: BinaryMessageCallback) {
        this.binaryCallbacks.add(cb);
        return () => {
            this.binaryCallbacks.delete(cb);
        };
    }

    /** Subscribe to co-editor pointer positions for the current slide. */
    public subscribeToPointer(cb: PointerCallback) {
        this.pointerCallbacks.add(cb);
        return () => {
            this.pointerCallbacks.delete(cb);
        };
    }

    public subscribeToPlayback(cb: PlaybackCallback) {
        this.playbackCallbacks.add(cb);
        return () => {
            this.playbackCallbacks.delete(cb);
        };
    }

    public getPlayback(id: number) {
        return this.playbackStates.get(id);
    }

    public setPlayback(id: number, pb: Extract<Layer, { type: 'video' }>['playback']) {
        this.playbackStates.set(id, pb);
    }

    /** Wall currently bound to this editor session (if any) */
    public boundWallId: string | null = null;
    private lastBindRequestId: string | null = null;

    /** Join a project/commit/slide scope. Re-sends hello if already connected. */
    public joinScope(projectId: string, commitId: string, slideId: string) {
        this.currentProjectId = projectId;
        this.currentCommitId = commitId;
        this.currentSlideId = slideId;
        // Playback cache is scope-local; avoid cross-scope numericId collisions.
        this.playbackStates.clear();

        if (this.bus.ready) {
            this.sendJSON({
                type: 'switch_scope',
                projectId,
                commitId,
                slideId
            });
        }

        // Auto-rebind the wall to the new slide when navigating
        if (this.boundWallId && this.bus.ready) {
            const requestId = this.makeBindRequestId();
            this.lastBindRequestId = requestId;
            this.sendJSON({
                type: 'request_bind_wall',
                requestId,
                wallId: this.boundWallId,
                projectId,
                commitId,
                slideId
            });
        }
    }

    /** Bind a wall to follow this editor's current scope */
    public bindWall(wallId: string, projectId: string, commitId: string, slideId: string) {
        this.boundWallId = wallId;
        const requestId = this.makeBindRequestId();
        this.lastBindRequestId = requestId;
        this.sendJSON({
            type: 'request_bind_wall',
            requestId,
            wallId,
            projectId,
            commitId,
            slideId
        });
    }

    /** Unbind the currently bound wall */
    public unbindWall() {
        if (this.boundWallId) {
            this.sendJSON({
                type: 'unbind_wall',
                wallId: this.boundWallId
            });
            this.boundWallId = null;
        }
    }

    public leaveScope() {
        if (!this.currentProjectId) return;
        this.sendJSON({ type: 'leave_scope' });
        this.currentProjectId = null;
        this.currentCommitId = null;
        this.currentSlideId = null;
        this.playbackStates.clear();
    }

    /** Request the bus to save the current scope state */
    public requestSave(message: string, isAutoSave = false) {
        this.sendJSON({ type: 'stage_save', message, isAutoSave });
    }

    /** Notify the bus that the scope is dirty */
    public sendDirty() {
        this.sendJSON({ type: 'stage_dirty' });
    }

    // Trailing edge matters: without it, the position you stop on is never sent
    // and peers keep pointing at wherever the last tick happened to land.
    private sendPointerThrottled = throttle(
        (x: number, y: number) => {
            this.sendJSON({ type: 'pointer', x, y });
        },
        { wait: POINTER_BROADCAST_INTERVAL_MS }
    );

    private lastPointer: { x: number; y: number } | null = null;
    private pointerHeartbeat: ReturnType<typeof setInterval> | null = null;

    /** Broadcast the local stage pointer to co-editors on the same slide. */
    public sendPointer(x: number, y: number) {
        if (!this.currentSlideId) return;
        this.lastPointer = { x, y };
        this.sendPointerThrottled(x, y);

        if (this.pointerHeartbeat) return;
        this.pointerHeartbeat = setInterval(() => {
            if (!this.lastPointer || !this.currentSlideId) return;
            this.sendPointerThrottled(this.lastPointer.x, this.lastPointer.y);
        }, POINTER_HEARTBEAT_INTERVAL_MS);
    }

    /**
     * Stop advertising a pointer position, e.g. once it leaves the stage.
     * Peers then simply age the cursor out; no departure message is needed.
     */
    public stopPointerBroadcast() {
        if (this.pointerHeartbeat) {
            clearInterval(this.pointerHeartbeat);
            this.pointerHeartbeat = null;
        }
        this.lastPointer = null;
    }

    public subscribeToSaveResponse(cb: SaveResponseCallback) {
        this.saveCallbacks.add(cb);
        return () => {
            this.saveCallbacks.delete(cb);
        };
    }

    /** Subscribe to connection status changes (connecting, connected, reconnecting, disconnected) */
    public onConnectionStatusChange(cb: ConnectionStatusCallback) {
        this.connectionStatusCallbacks.add(cb);
        return () => {
            this.connectionStatusCallbacks.delete(cb);
        };
    }

    public onBindOverrideResult(cb: BindOverrideResultCallback) {
        this.bindOverrideResultCallbacks.add(cb);
        return () => {
            this.bindOverrideResultCallbacks.delete(cb);
        };
    }

    public getLastBindRequestId() {
        return this.lastBindRequestId;
    }

    /** Current connection status */
    public get connectionStatus(): ConnectionStatus {
        return this.bus.status;
    }

    private makeBindRequestId(): string {
        const rand = Math.random().toString(36).slice(2, 10);
        return `bind_${Date.now()}_${rand}`;
    }

    /**
     * Send an upsert for a newly created layer and wait for the server to
     * confirm it reached the commit. Use this instead of sendJSON whenever a
     * layer is created, so a failed write cannot pass silently.
     */
    public createLayer = (origin: string, layer: Layer): void => {
        const createRequestId = `create_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        this.trackLayerCreate(createRequestId, layer.numericId);

        const message = {
            type: 'upsert_layer',
            origin,
            layer,
            createRequestId
        } as GSMessage;

        if (this.sendJSON(message)) return;

        // Socket not ready: wait for a reconnect rather than dropping the
        // message and letting the acknowledgement time out.
        void this.bus.waitUntilReady().then((ready) => {
            if (!this.pendingLayerCreates.has(createRequestId)) return;
            if (ready && this.sendJSON(message)) return;
            this.failLayerCreate(
                createRequestId,
                `Layer ${layer.numericId} could not be sent. Reloading the slide to avoid losing work.`
            );
        });
    };

    /** Returns whether the message reached the socket. */
    public sendJSON = (data: GSMessage): boolean => {
        // Protocol discipline:
        // Editor upsert_layer for video should never carry playback timeline fields.
        if (data.type === 'upsert_layer' && data.layer.type === 'video') {
            const { playback: _playback, ...layerWithoutPlayback } = data.layer;
            return this.bus.sendRaw(JSON.stringify({ ...data, layer: layerWithoutPlayback }));
        }
        return this.bus.sendJSON(data);
    };

    public broadcastBinaryMove = throttle(
        (
            numericId: number,
            x: number,
            y: number,
            width: number,
            height: number,
            scaleX: number,
            scaleY: number,
            rotation: number
        ) => {
            const buffer = new ArrayBuffer(33);
            const view = new DataView(buffer);
            view.setUint8(0, 0x05);
            view.setUint16(1, 1, true);
            view.setUint16(3, numericId, true);
            view.setFloat32(5, x, true);
            view.setFloat32(9, y, true);
            view.setFloat32(13, width, true);
            view.setFloat32(17, height, true);
            view.setFloat32(21, scaleX, true);
            view.setFloat32(25, scaleY, true);
            view.setFloat32(29, rotation, true);
            this.bus.sendRaw(buffer);
        },
        { wait: 16 }
    );

    public broadcastBinaryMoves = throttle(
        (moves: LayerBinaryMove[]) => {
            if (moves.length === 0) return;
            const buffer = new ArrayBuffer(3 + 30 * moves.length);
            const view = new DataView(buffer);
            view.setUint8(0, 0x05);
            view.setUint16(1, moves.length, true);
            let offset = 3;
            for (const m of moves) {
                view.setUint16(offset, m.numericId, true);
                view.setFloat32(offset + 2, m.x, true);
                view.setFloat32(offset + 6, m.y, true);
                view.setFloat32(offset + 10, m.width, true);
                view.setFloat32(offset + 14, m.height, true);
                view.setFloat32(offset + 18, m.scaleX, true);
                view.setFloat32(offset + 22, m.scaleY, true);
                view.setFloat32(offset + 26, m.rotation, true);
                offset += 30;
            }
            this.bus.sendRaw(buffer);
        },
        { wait: 16 }
    );
}

// --- VITE HMR DEFENSE STRATEGY ---
if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        if (typeof window !== 'undefined' && window.__EDITOR_ENGINE__) {
            window.__EDITOR_ENGINE__.destroy();
            window.__EDITOR_ENGINE__ = undefined;
        }
    });
}
