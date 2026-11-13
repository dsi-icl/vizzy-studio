'use client';

import { create } from 'zustand';

export interface GalleryStoreState {
    wallId: string | null;
    isEnrolledDevice: boolean;
    deviceEnrollmentId: string | null;
    enrollmentModeEnabled: boolean;

    setWallId: (wallId: string | null) => void;
    setIsEnrolledDevice: (enrolled: boolean) => void;
    setDeviceEnrollmentId: (id: string | null) => void;
    setEnrollmentModeEnabled: (enabled: boolean) => void;
}

export type GalleryStateCreator = ReturnType<ReturnType<typeof create<GalleryStoreState>>>;

function createGalleryStore() {
    return create<GalleryStoreState>()((set) => ({
        wallId: null,
        isEnrolledDevice: false,
        deviceEnrollmentId: null,
        enrollmentModeEnabled: false,

        setWallId: (wallId) => set({ wallId }),
        setIsEnrolledDevice: (isEnrolledDevice) => set({ isEnrolledDevice }),
        setDeviceEnrollmentId: (deviceEnrollmentId) => set({ deviceEnrollmentId }),
        setEnrollmentModeEnabled: (enrollmentModeEnabled) => set({ enrollmentModeEnabled })
    }));
}

export const useGalleryStore: GalleryStateCreator =
    typeof window !== 'undefined' && window.__GALLERY_STORE__
        ? window.__GALLERY_STORE__
        : createGalleryStore();

if (typeof window !== 'undefined') window.__GALLERY_STORE__ = useGalleryStore;

const ENROLLED_GALLERY_URL_KEY = 'vizzy_gallery_enrolled_url';

export function rememberEnrolledGalleryUrl() {
    try {
        sessionStorage.setItem(ENROLLED_GALLERY_URL_KEY, `/gallery${window.location.search}`);
    } catch {
        // no-op: private mode or blocked storage
    }
}

export function forgetEnrolledGalleryUrl() {
    try {
        sessionStorage.removeItem(ENROLLED_GALLERY_URL_KEY);
    } catch {
        // no-op: private mode or blocked storage
    }
}

export function readEnrolledGalleryUrl(): string | null {
    try {
        return sessionStorage.getItem(ENROLLED_GALLERY_URL_KEY);
    } catch {
        return null;
    }
}

export function initGalleryStore(params: {
    wallId: string | null;
    enrollmentModeEnabled: boolean;
}) {
    const state = useGalleryStore.getState();
    if (state.wallId !== params.wallId) state.setWallId(params.wallId);
    if (state.enrollmentModeEnabled !== params.enrollmentModeEnabled)
        state.setEnrollmentModeEnabled(params.enrollmentModeEnabled);
}

if (import.meta.hot) {
    import.meta.hot.accept();
    import.meta.hot.dispose((data) => {
        data.galleryState = useGalleryStore.getState();
    });
    if (import.meta.hot.data.galleryState) {
        try {
            useGalleryStore.setState(import.meta.hot.data.galleryState);
        } catch (e) {
            console.error('[HMR]: Failed to rehydrate gallery store:', e);
        }
    }
}
