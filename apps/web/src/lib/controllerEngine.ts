'use client';

import { DEFAULT_STAGE_LAYOUT, type StageLayout } from '@repo/db/schema';

import { BusClient } from './busClient';
import { GSMessageSchema, type GSMessage } from './types';

type BindingStatus = {
    bound: boolean;
    projectId?: string;
    commitId?: string;
    slideId?: string;
    customRenderUrl?: string;
    boundSource?: 'live' | 'gallery';
};

type BindingCallback = (status: BindingStatus) => void;
type HydrateCallback = (payload: Extract<GSMessage, { type: 'hydrate' }>) => void;
type SlidesUpdatedCallback = (payload: {
    commitId: string;
    slides: Array<{
        id: string;
        order: number;
        name: string;
    }>;
}) => void;
type ServerMessageCallback = (data: GSMessage) => void;

type HydrateLayer = Extract<GSMessage, { type: 'hydrate' }>['layers'][number];

export interface ControllerSnapshotSlide {
    id: string;
    name: string;
    order: number;
    layers: HydrateLayer[];
    layerCount: number;
}

export interface ControllerSnapshot {
    binding: BindingStatus;
    hasHydration: boolean;
    slides: ControllerSnapshotSlide[];
    commitId: string | null;
    layout: StageLayout;
}

type SnapshotCallback = (snapshot: ControllerSnapshot) => void;

const TEMP_BOUND_SLIDE_ID = '__bound-current__';

export class ControllerEngine {
    private bus: BusClient;
    public wallId: string;
    public portalToken: string | null;
    private bindingCallbacks = new Set<BindingCallback>();
    private hydrateCallbacks = new Set<HydrateCallback>();
    private slidesUpdatedCallbacks = new Set<SlidesUpdatedCallback>();
    private messageCallbacks = new Set<ServerMessageCallback>();
    private snapshotCallbacks = new Set<SnapshotCallback>();
    private lastBindSignature: string | null = null;

    private reconciledBinding: BindingStatus = { bound: false };
    private hydratedSlideId: string | null = null;
    private hasHydration = false;
    private layersBySlideId = new Map<string, HydrateLayer[]>();
    private slideMetaById = new Map<string, { id: string; order: number; name: string }>();
    private orderedSlideIds: string[] = [];
    private latestCommitId: string | null = null;
    private latestLayout: StageLayout = { ...DEFAULT_STAGE_LAYOUT };
    private emitScheduled = false;
    private lastSnapshotSignature: string | null = null;

    private constructor(wallId: string, portalToken: string | null = null) {
        this.wallId = wallId;
        this.portalToken = portalToken;
        this.bus = new BusClient({
            auth: {
                kind: 'controller',
                wallId: this.wallId,
                portalToken: this.portalToken
            },
            onOpen: () => {
                console.log('Controller Engine: Connected to Server');
                this.lastBindSignature = null;
            },
            onMessage: (event) => {
                if (typeof event.data !== 'string') return;
                const data = GSMessageSchema.parse(JSON.parse(event.data));
                this.messageCallbacks.forEach((cb) => cb(data));
                this.reconcileMessage(data);
            }
        });

        // On disconnect: notify UI that binding state is unknown
        this.bus.onSocketStateChange((status) => {
            if (status === 'reconnecting' || status === 'disconnected') {
                this.reconciledBinding = { bound: false };
                this.bindingCallbacks.forEach((cb) => cb({ bound: false }));
                this.scheduleEmit();
            }
        });
    }

    public static getInstance(wallId: string, portalToken: string | null = null): ControllerEngine {
        if (typeof window === 'undefined') {
            throw new Error('ControllerEngine can only be used in the browser');
        }
        if (
            !window.__CONTROLLER_ENGINE__ ||
            window.__CONTROLLER_ENGINE__.wallId !== wallId ||
            window.__CONTROLLER_ENGINE__.portalToken !== portalToken
        ) {
            window.__CONTROLLER_ENGINE__?.destroy();
            window.__CONTROLLER_ENGINE__ = new ControllerEngine(wallId, portalToken);
        }
        return window.__CONTROLLER_ENGINE__;
    }

    public destroy() {
        console.log('Controller Engine: Assassinating ghost instance...');
        this.bus.destroy();
        this.bindingCallbacks.clear();
        this.hydrateCallbacks.clear();
        this.slidesUpdatedCallbacks.clear();
        this.messageCallbacks.clear();
        this.snapshotCallbacks.clear();
    }

    public sendJSON = (data: GSMessage) => {
        this.bus.sendJSON(data);
    };

    /** Navigate the bound wall to a different slide */
    public bindSlide(projectId: string, commitId: string, slideId: string) {
        const signature = `${projectId}:${commitId}:${slideId}`;
        if (this.lastBindSignature === signature) return;
        this.lastBindSignature = signature;
        this.sendJSON({
            type: 'bind_wall',
            wallId: this.wallId,
            projectId,
            commitId,
            slideId
        });
    }

    public onBindingStatus(cb: BindingCallback) {
        this.bindingCallbacks.add(cb);
        return () => {
            this.bindingCallbacks.delete(cb);
        };
    }

    public onHydrate(cb: HydrateCallback) {
        this.hydrateCallbacks.add(cb);
        return () => {
            this.hydrateCallbacks.delete(cb);
        };
    }

    public onSlidesUpdated(cb: SlidesUpdatedCallback) {
        this.slidesUpdatedCallbacks.add(cb);
        return () => {
            this.slidesUpdatedCallbacks.delete(cb);
        };
    }

    public onMessage(cb: ServerMessageCallback) {
        this.messageCallbacks.add(cb);
        return () => {
            this.messageCallbacks.delete(cb);
        };
    }

    public onSnapshot(cb: SnapshotCallback) {
        this.snapshotCallbacks.add(cb);
        cb(this.buildSnapshot());
        return () => {
            this.snapshotCallbacks.delete(cb);
        };
    }

    private reconcileMessage(data: GSMessage) {
        if (data.type === 'reboot') {
            window.location.reload();
            return;
        }

        if (data.type === 'wall_binding_status') {
            this.reconciledBinding = {
                bound: data.bound,
                projectId: data.projectId,
                commitId: data.commitId,
                slideId: data.slideId,
                customRenderUrl: data.customRenderUrl ?? undefined,
                boundSource: data.boundSource ?? this.reconciledBinding.boundSource
            };
            this.latestCommitId = data.commitId ?? this.latestCommitId;

            if (!data.bound) {
                this.hydratedSlideId = null;
                this.hasHydration = false;
                this.layersBySlideId.clear();
                this.slideMetaById.clear();
                this.orderedSlideIds = [];
            } else if (data.slideId) {
                if (this.layersBySlideId.has(TEMP_BOUND_SLIDE_ID)) {
                    const tempLayers = this.layersBySlideId.get(TEMP_BOUND_SLIDE_ID) ?? [];
                    this.layersBySlideId.delete(TEMP_BOUND_SLIDE_ID);
                    if (!this.layersBySlideId.has(data.slideId)) {
                        this.layersBySlideId.set(data.slideId, tempLayers);
                    }
                }
                this.hydratedSlideId = data.slideId;
                if (!this.slideMetaById.has(data.slideId)) {
                    this.slideMetaById.set(data.slideId, {
                        id: data.slideId,
                        order: this.orderedSlideIds.length,
                        name: '<Unknown>'
                    });
                    this.orderedSlideIds.push(data.slideId);
                }
            }

            this.bindingCallbacks.forEach((cb) => cb(this.reconciledBinding));
            this.scheduleEmit();
            return;
        }

        if (data.type === 'hydrate') {
            if (data.layout) this.latestLayout = data.layout;
            const targetSlideId =
                this.reconciledBinding.slideId ?? this.hydratedSlideId ?? TEMP_BOUND_SLIDE_ID;
            this.hydratedSlideId = targetSlideId;
            this.hasHydration = true;
            this.layersBySlideId.set(targetSlideId, data.layers);
            if (!this.slideMetaById.has(targetSlideId)) {
                this.slideMetaById.set(targetSlideId, {
                    id: targetSlideId,
                    order: this.orderedSlideIds.length,
                    name: 'Bound slide'
                });
                this.orderedSlideIds.push(targetSlideId);
            }

            this.hydrateCallbacks.forEach((cb) => cb(data));
            this.scheduleEmit();
            return;
        }

        if (data.type === 'slides_updated') {
            this.latestCommitId = data.commitId;
            const sorted = [...data.slides].sort((a, b) => a.order - b.order);
            this.slideMetaById.clear();
            this.orderedSlideIds = [];
            for (const slide of sorted) {
                this.slideMetaById.set(slide.id, {
                    id: slide.id,
                    order: slide.order,
                    name: slide.name
                });
                this.orderedSlideIds.push(slide.id);
            }

            const hydratedOnlyIds = Array.from(this.layersBySlideId.keys()).filter(
                (id) => !this.slideMetaById.has(id)
            );
            for (const hydratedId of hydratedOnlyIds) {
                this.slideMetaById.set(hydratedId, {
                    id: hydratedId,
                    order: this.orderedSlideIds.length,
                    name: hydratedId === TEMP_BOUND_SLIDE_ID ? 'Bound slide' : '<Unknown>'
                });
                this.orderedSlideIds.push(hydratedId);
            }

            this.slidesUpdatedCallbacks.forEach((cb) =>
                cb({ commitId: data.commitId, slides: data.slides })
            );
            this.scheduleEmit();
            return;
        }

        if (data.type === 'upsert_layer' || data.type === 'delete_layer') {
            const targetSlideId =
                this.reconciledBinding.slideId ?? this.hydratedSlideId ?? TEMP_BOUND_SLIDE_ID;
            const layers = [...(this.layersBySlideId.get(targetSlideId) ?? [])];

            if (data.type === 'upsert_layer') {
                const idx = layers.findIndex((layer) => layer.numericId === data.layer.numericId);
                if (idx >= 0) {
                    layers[idx] = data.layer;
                } else {
                    layers.push(data.layer);
                }
            } else {
                const idx = layers.findIndex((layer) => layer.numericId === data.numericId);
                if (idx >= 0) layers.splice(idx, 1);
            }

            this.layersBySlideId.set(targetSlideId, layers);
            if (!this.slideMetaById.has(targetSlideId)) {
                this.slideMetaById.set(targetSlideId, {
                    id: targetSlideId,
                    order: this.orderedSlideIds.length,
                    name: targetSlideId === TEMP_BOUND_SLIDE_ID ? 'Bound slide' : '<Unknown>'
                });
                this.orderedSlideIds.push(targetSlideId);
            }
            this.scheduleEmit();
        }
    }

    private scheduleEmit() {
        if (this.emitScheduled) return;
        this.emitScheduled = true;
        queueMicrotask(() => {
            this.emitScheduled = false;
            const snapshot = this.buildSnapshot();
            const signature = JSON.stringify({
                binding: snapshot.binding,
                hasHydration: snapshot.hasHydration,
                commitId: snapshot.commitId,
                layout: snapshot.layout,
                slides: snapshot.slides.map((slide) => [
                    slide.id,
                    slide.order,
                    slide.name,
                    slide.layerCount
                ])
            });
            if (signature === this.lastSnapshotSignature) return;
            this.lastSnapshotSignature = signature;
            this.snapshotCallbacks.forEach((cb) => cb(snapshot));
        });
    }

    private buildSnapshot(): ControllerSnapshot {
        const ids = [...this.orderedSlideIds];
        for (const id of this.layersBySlideId.keys()) {
            if (!ids.includes(id)) ids.push(id);
        }

        const slides = ids
            .map((id, index) => {
                const meta = this.slideMetaById.get(id);
                const layers = this.layersBySlideId.get(id) ?? [];
                return {
                    id,
                    name: meta?.name ?? '<Unknown>',
                    order: meta?.order ?? index,
                    layers,
                    layerCount: layers.length
                };
            })
            .sort((a, b) => a.order - b.order);

        return {
            binding: this.reconciledBinding,
            hasHydration: this.hasHydration,
            slides,
            commitId: this.latestCommitId,
            layout: this.latestLayout
        };
    }
}

// --- VITE HMR DEFENSE STRATEGY ---
if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        if (typeof window !== 'undefined' && window.__CONTROLLER_ENGINE__) {
            window.__CONTROLLER_ENGINE__.destroy();
            window.__CONTROLLER_ENGINE__ = undefined;
        }
    });
}
