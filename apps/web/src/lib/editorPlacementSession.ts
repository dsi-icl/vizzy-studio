import type { EditorState } from './editorStore.types';
import { fitSizeToViewport } from './fitSizeToViewport';
import { canPlaceAsset, type AssetLibraryAsset } from './mediaUtils';
import type { LayerWithEditorState } from './types';

type PlacementState = Pick<
    EditorState,
    | 'projectId'
    | 'commitId'
    | 'activeSlideId'
    | 'loading'
    | 'placementEpoch'
    | 'insertionCenter'
    | 'insertionViewport'
>;

/** A switch away and back still cancels the old intent, even if ids match again. */
export function createEditorPlacementSession(store: {
    getState: () => PlacementState;
    subscribe: (listener: (state: PlacementState) => void) => () => void;
}) {
    const initial = store.getState();
    if (initial.loading || !initial.projectId || !initial.commitId || !initial.activeSlideId)
        throw new Error('Wait for the slide to finish loading.');
    const { projectId, commitId, activeSlideId } = initial;
    const controller = new AbortController();
    const isCurrent = (state: PlacementState) =>
        !state.loading &&
        state.projectId === projectId &&
        state.commitId === commitId &&
        state.placementEpoch === initial.placementEpoch &&
        state.activeSlideId === activeSlideId;
    const unsubscribe = store.subscribe((state) => {
        if (!isCurrent(state)) controller.abort();
    });
    const cancel = () => {
        controller.abort();
        unsubscribe();
    };
    return {
        projectId,
        insertionCenter: { ...initial.insertionCenter },
        insertionViewport: { ...initial.insertionViewport },
        signal: controller.signal,
        assertCurrent() {
            if (!isCurrent(store.getState())) cancel();
            controller.signal.throwIfAborted();
        },
        cancel,
        dispose: unsubscribe
    };
}

export type EditorPlacementSession = ReturnType<typeof createEditorPlacementSession>;

/** One local layer owns the entire image preparation. Resource updates never replace its edits. */
export function createImagePlacementDraft(
    store: {
        getState: () => Pick<EditorState, 'layers' | 'upsertLayer'>;
        subscribe: (listener: () => void) => () => void;
    },
    session: EditorPlacementSession,
    layer: Extract<LayerWithEditorState, { type: 'image' }>
) {
    const initialConfig = { ...layer.config };
    let sized = false;
    store.getState().upsertLayer(layer);
    const current = () => {
        session.assertCurrent();
        const latest = store.getState().layers.get(layer.numericId);
        if (latest?.type !== 'image' || !latest.isUploading) {
            session.cancel();
            session.signal.throwIfAborted();
            throw new Error('Image placement was removed.');
        }
        return latest;
    };
    const dispose = store.subscribe(() => {
        const latest = store.getState().layers.get(layer.numericId);
        if (latest?.type !== 'image' || !latest.isUploading) session.cancel();
    });
    return {
        current,
        dispose,
        update(
            resource: Partial<Pick<typeof layer, 'url' | 'blurhash' | 'deepZoom' | 'progress'>>,
            dimensions?: { width: number; height: number },
            ready = false
        ) {
            const latest = current();
            let config = latest.config;
            if (!sized && dimensions) {
                // A placeholder learns its aspect ratio once. Never resize over a
                // user's changes, nor refit when preview resolution later changes.
                if (
                    config.width === initialConfig.width &&
                    config.height === initialConfig.height &&
                    config.scaleX === initialConfig.scaleX &&
                    config.scaleY === initialConfig.scaleY
                ) {
                    config = {
                        ...config,
                        ...fitSizeToViewport(
                            dimensions.width,
                            dimensions.height,
                            session.insertionViewport.width,
                            session.insertionViewport.height
                        )
                    };
                }
                sized = true;
            }
            const next = { ...latest, ...resource, config, isUploading: !ready };
            if (ready) dispose();
            store.getState().upsertLayer(next);
            return next;
        }
    };
}

export function withPlacementAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        // Attach handlers even if already aborted, so rejected work is consumed.
        task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
    });
}

export async function waitForImageReady(input: {
    read: () => Promise<AssetLibraryAsset | undefined>;
    signal: AbortSignal;
    onUpdate?: (asset: AssetLibraryAsset) => void;
    intervalMs?: number;
    timeoutMs?: number;
}) {
    const timeout = AbortSignal.timeout(input.timeoutMs ?? 15 * 60_000);
    const signal = AbortSignal.any([input.signal, timeout]);
    let seen = false;
    let missing = 0;
    for (;;) {
        signal.throwIfAborted();
        const asset = await withPlacementAbort(input.read(), signal);
        signal.throwIfAborted();
        if (asset) {
            seen = true;
            missing = 0;
            if (asset.deepZoom?.status === 'failed') throw new Error(asset.deepZoom.error);
            input.onUpdate?.(asset);
            if (canPlaceAsset(asset)) return asset;
        } else if (seen || ++missing >= 3) {
            throw new Error('The uploaded image is no longer available in Media.');
        }
        await new Promise<void>((resolve, reject) => {
            const abort = () => {
                clearTimeout(timer);
                reject(signal.reason);
            };
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', abort);
                resolve();
            }, input.intervalMs ?? 2000);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
        });
    }
}
