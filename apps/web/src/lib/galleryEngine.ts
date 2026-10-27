'use client';

import { BusClient } from './busClient';
import { useGalleryStore } from './galleryStore';
import { GSMessageSchema, type GSMessage } from './types';

type GalleryState = Extract<GSMessage, { type: 'gallery_state' }>;
type WallBindingChanged = Extract<GSMessage, { type: 'wall_binding_changed' }>;
type WallUnbound = Extract<GSMessage, { type: 'wall_unbound' }>;
type ProjectsChanged = Extract<GSMessage, { type: 'projects_changed' }>;
type BindOverrideRequested = Extract<GSMessage, { type: 'bind_override_requested' }>;
type BindOverrideResult = Extract<GSMessage, { type: 'bind_override_result' }>;
type ServerMessageCallback = (data: GSMessage) => void;

type WallBindingChangedCallback = (data: WallBindingChanged) => void;
type WallUnboundCallback = (data: WallUnbound) => void;
type ProjectsChangedCallback = (data: ProjectsChanged) => void;
type BindOverrideRequestedCallback = (data: BindOverrideRequested) => void;
type BindOverrideResultCallback = (data: BindOverrideResult) => void;
type GalleryStateCallback = (state: GalleryState) => void;

export class GalleryEngine {
    private bus: BusClient;
    public wallId: string | null;
    private messageCallbacks = new Set<ServerMessageCallback>();
    private wallBindingChangedCallbacks = new Set<WallBindingChangedCallback>();
    private wallUnboundCallbacks = new Set<WallUnboundCallback>();
    private projectsChangedCallbacks = new Set<ProjectsChangedCallback>();
    private bindOverrideRequestedCallbacks = new Set<BindOverrideRequestedCallback>();
    private bindOverrideResultCallbacks = new Set<BindOverrideResultCallback>();
    private galleryStateCallbacks = new Set<GalleryStateCallback>();

    private constructor() {
        this.wallId = useGalleryStore.getState().wallId;
        this.bus = new BusClient({
            auth: {
                kind: 'gallery',
                ...(this.wallId ? { wallId: this.wallId } : {})
            },
            onOpen: () => {
                console.log('Gallery Engine: Connected to Server');
                useGalleryStore.getState().setDeviceEnrollmentId(null);
                useGalleryStore.getState().setIsEnrolledDevice(false);
            },
            onMessage: (event) => {
                if (typeof event.data !== 'string') return;
                const data = GSMessageSchema.parse(JSON.parse(event.data));
                this.messageCallbacks.forEach((cb) => cb(data));

                if (data.type === 'reboot') {
                    window.location.reload();
                    return;
                }

                if (data.type === 'device_enrollment') {
                    useGalleryStore.getState().setDeviceEnrollmentId(data.id);
                    return;
                }

                if (data.type === 'gallery_state') {
                    if (data.wallId) {
                        const store = useGalleryStore.getState();
                        if (store.wallId !== data.wallId) {
                            store.setWallId(data.wallId);
                        }
                        if (!store.deviceEnrollmentId) {
                            store.setIsEnrolledDevice(true);
                        }
                    }
                    this.galleryStateCallbacks.forEach((cb) => cb(data));
                    return;
                }

                if (data.type === 'wall_binding_changed') {
                    this.wallBindingChangedCallbacks.forEach((cb) => cb(data));
                    return;
                }

                if (data.type === 'wall_unbound') {
                    this.wallUnboundCallbacks.forEach((cb) => cb(data));
                    return;
                }

                if (data.type === 'projects_changed') {
                    this.projectsChangedCallbacks.forEach((cb) => cb(data));
                    return;
                }

                if (data.type === 'bind_override_requested') {
                    this.bindOverrideRequestedCallbacks.forEach((cb) => cb(data));
                    return;
                }

                if (data.type === 'bind_override_result') {
                    this.bindOverrideResultCallbacks.forEach((cb) => cb(data));
                }
            }
        });
    }

    public static getInstance(): GalleryEngine {
        if (typeof window === 'undefined') {
            throw new Error('GalleryEngine can only be used in the browser');
        }
        const wallId = useGalleryStore.getState().wallId;
        if (!window.__GALLERY_ENGINE__ || window.__GALLERY_ENGINE__.wallId !== wallId) {
            window.__GALLERY_ENGINE__?.destroy();
            window.__GALLERY_ENGINE__ = new GalleryEngine();
        }
        return window.__GALLERY_ENGINE__;
    }

    public destroy() {
        console.log('Gallery Engine: Assassinating ghost instance...');
        this.bus.destroy();
        this.messageCallbacks.clear();
        this.wallBindingChangedCallbacks.clear();
        this.wallUnboundCallbacks.clear();
        this.projectsChangedCallbacks.clear();
        this.bindOverrideRequestedCallbacks.clear();
        this.bindOverrideResultCallbacks.clear();
        this.galleryStateCallbacks.clear();
    }

    public sendJSON = (data: GSMessage) => {
        return this.bus.sendJSON(data);
    };

    public waitUntilReady = (timeoutMs?: number) => this.bus.waitUntilReady(timeoutMs);

    public decideBindOverride(requestId: string, wallId: string, allow: boolean) {
        this.sendJSON({
            type: 'bind_override_decision',
            requestId,
            wallId,
            allow
        });
    }

    public unbindWall(wallId: string) {
        this.sendJSON({
            type: 'unbind_wall',
            wallId
        });
    }

    public onGalleryState(cb: GalleryStateCallback) {
        this.galleryStateCallbacks.add(cb);
        return () => this.galleryStateCallbacks.delete(cb);
    }

    public onWallBindingChanged(cb: WallBindingChangedCallback) {
        this.wallBindingChangedCallbacks.add(cb);
        return () => this.wallBindingChangedCallbacks.delete(cb);
    }

    public onWallUnbound(cb: WallUnboundCallback) {
        this.wallUnboundCallbacks.add(cb);
        return () => this.wallUnboundCallbacks.delete(cb);
    }

    public onProjectsChanged(cb: ProjectsChangedCallback) {
        this.projectsChangedCallbacks.add(cb);
        return () => this.projectsChangedCallbacks.delete(cb);
    }

    public onBindOverrideRequested(cb: BindOverrideRequestedCallback) {
        this.bindOverrideRequestedCallbacks.add(cb);
        return () => this.bindOverrideRequestedCallbacks.delete(cb);
    }

    public onBindOverrideResult(cb: BindOverrideResultCallback) {
        this.bindOverrideResultCallbacks.add(cb);
        return () => this.bindOverrideResultCallbacks.delete(cb);
    }

    public onMessage(cb: ServerMessageCallback) {
        this.messageCallbacks.add(cb);
        return () => this.messageCallbacks.delete(cb);
    }
}

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        if (typeof window !== 'undefined' && window.__GALLERY_ENGINE__) {
            window.__GALLERY_ENGINE__.destroy();
            window.__GALLERY_ENGINE__ = undefined;
        }
    });
}
