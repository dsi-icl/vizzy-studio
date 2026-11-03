import { $listAssets } from '~/server/projects.fns';

import { EditorEngine } from './editorEngine';
import {
    createEditorPlacementSession,
    createImagePlacementDraft,
    withPlacementAbort,
    waitForImageReady,
    type EditorPlacementSession
} from './editorPlacementSession';
import { useEditorStore } from './editorStore';
import { fitSizeToViewport } from './fitSizeToViewport';
import {
    canPlaceAsset,
    isAssetProcessing,
    createImageDeepZoomLayerDescriptor,
    isFontAsset,
    makeUniqueMediaLayerName,
    toLibraryAsset,
    prepareMediaAsset,
    type AssetLibraryAsset,
    type MediaDimensions
} from './mediaUtils';
import type { LayerWithEditorState } from './types';

export async function readAvailableAssets(projectId: string) {
    // Asset broadcasts invalidate the library query and cancel its current fetch.
    // Placement needs its own fresh, authorized read that survives those updates.
    const assets = await $listAssets({ data: { projectId } });
    return assets.map(toLibraryAsset);
}

function readMediaDimensions(url: string, isVideo: boolean, signal: AbortSignal) {
    return new Promise<MediaDimensions>((resolve, reject) => {
        const media = isVideo ? document.createElement('video') : new window.Image();
        const fallback = { width: 800, height: 600, duration: 0 };
        const finish = (aborted = false) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            media.removeEventListener(isVideo ? 'loadedmetadata' : 'load', loaded);
            media.removeEventListener('error', failed);
            const dimensions =
                media instanceof HTMLVideoElement
                    ? {
                          width: media.videoWidth,
                          height: media.videoHeight,
                          duration: media.duration || 0
                      }
                    : { width: media.naturalWidth, height: media.naturalHeight, duration: 0 };
            media.removeAttribute('src');
            if (media instanceof HTMLVideoElement) media.load();
            if (aborted) reject(signal.reason);
            else resolve(dimensions.width && dimensions.height ? dimensions : fallback);
        };
        const abort = () => finish(true);
        const loaded = () => finish();
        const failed = () => finish();
        const timer = setTimeout(failed, 30_000);
        signal.addEventListener('abort', abort, { once: true });
        media.addEventListener(isVideo ? 'loadedmetadata' : 'load', loaded, { once: true });
        media.addEventListener('error', failed, { once: true });
        media.crossOrigin = 'anonymous';
        if (signal.aborted) abort();
        else media.src = url;
    });
}

/** Click/drop accept ready resources or an editable processing preview. */
export async function placeAssetInEditor(input: {
    assetId: string;
    origin: string;
    point?: { x: number; y: number };
    session?: EditorPlacementSession;
    projectId?: string;
}) {
    const session = input.session ?? createEditorPlacementSession(useEditorStore);
    try {
        session.assertCurrent();
        if (input.projectId && input.projectId !== session.projectId) return;
        // Re-read through existing project/public access rules. Drag payloads and
        // stale cards must not place a deleted, failed or unavailable asset.
        const asset = (
            await withPlacementAbort(readAvailableAssets(session.projectId), session.signal)
        ).find((a) => a.id === input.assetId);
        session.assertCurrent();
        if (!asset) throw new Error('This asset is no longer available in Media.');
        if (isFontAsset(asset)) return;
        if (isAssetProcessing(asset) && canPlaceAsset(asset, { allowProcessing: true })) {
            const placement = startImagePlacement(session, {
                name: asset.name,
                url: `/api/assets/${asset.previewUrl}`,
                blurhash: asset.blurhash,
                dimensions: asset.deepZoom,
                point: input.point
            });
            try {
                return await finishImagePlacement(placement, session, input.origin, async () =>
                    (await readAvailableAssets(session.projectId)).find(
                        (item) => item.id === asset.id
                    )
                );
            } finally {
                placement.dispose();
            }
        }
        const url = `/api/assets/${asset.url}`;
        const media = await prepareMediaAsset(asset, (isVideo) =>
            readMediaDimensions(url, isVideo, session.signal)
        );
        session.assertCurrent();
        const store = useEditorStore.getState();
        const engine = EditorEngine.getInstance();
        const numericId = store.allocateId();
        const point = input.point ?? session.insertionCenter;
        const size = fitSizeToViewport(
            media.width,
            media.height,
            session.insertionViewport.width,
            session.insertionViewport.height
        );
        const base = {
            numericId,
            name: makeUniqueMediaLayerName(asset.name, store.layers.values()),
            url,
            blurhash: asset.blurhash ?? '',
            config: {
                cx: point.x,
                cy: point.y,
                ...size,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                zIndex: store.allocateZIndex(),
                visible: true
            },
            isUploading: false,
            progress: 100
        };
        const layer: LayerWithEditorState = media.isVideo
            ? {
                  ...base,
                  type: 'video',
                  playback: {
                      status: 'paused',
                      anchorMediaTime: 0,
                      anchorServerTime: engine.getServerTime()
                  },
                  duration: media.duration,
                  loop: true,
                  rvfcActive: false,
                  ...(asset.previewUrl ? { stillImage: asset.previewUrl } : {})
              }
            : { ...base, type: 'image', ...(media.deepZoom ? { deepZoom: media.deepZoom } : {}) };
        store.upsertLayer(layer);
        store.toggleLayerSelection(String(numericId), false, false);
        engine.createLayer(input.origin, layer);
        store.markDirty();
        return layer;
    } finally {
        if (!input.session) session.dispose();
    }
}

/** Media click and drag share one draft, cleanup and ready handoff. */
function startImagePlacement(
    session: EditorPlacementSession,
    input: {
        name: string;
        url?: string;
        blurhash?: string;
        point?: { x: number; y: number };
        dimensions?: { width: number; height: number };
    }
) {
    session.assertCurrent();
    const store = useEditorStore.getState();
    const numericId = store.allocateId();
    const draft = createImagePlacementDraft(useEditorStore, session, {
        type: 'image',
        numericId,
        name: makeUniqueMediaLayerName(input.name, store.layers.values()),
        url: input.url ?? '',
        ...(input.blurhash ? { blurhash: input.blurhash } : {}),
        config: {
            cx: (input.point ?? session.insertionCenter).x,
            cy: (input.point ?? session.insertionCenter).y,
            ...fitSizeToViewport(
                input.dimensions?.width ?? 800,
                input.dimensions?.height ?? 600,
                session.insertionViewport.width,
                session.insertionViewport.height
            ),
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            zIndex: store.allocateZIndex(),
            visible: true
        },
        isUploading: true,
        progress: 0
    });
    store.toggleLayerSelection(String(numericId), false, false);
    return {
        draft,
        dispose() {
            draft.dispose();
            const state = useEditorStore.getState();
            // Remove only our unfinished draft in its original scope. Ready or
            // remotely replaced layers must survive this local cleanup.
            if (
                state.projectId === store.projectId &&
                state.commitId === store.commitId &&
                state.activeSlideId === store.activeSlideId &&
                state.placementEpoch === store.placementEpoch &&
                state.layers.get(numericId)?.isUploading
            )
                state.removeLayer(numericId);
        }
    };
}

async function finishImagePlacement(
    placement: ReturnType<typeof startImagePlacement>,
    session: EditorPlacementSession,
    origin: string,
    read: () => Promise<AssetLibraryAsset | undefined>
) {
    const { draft } = placement;
    const asset = await waitForImageReady({
        signal: session.signal,
        read,
        onUpdate: (asset) => {
            if (!asset.deepZoom) return;
            // Source pixels stay on the server throughout preparation.
            draft.update(
                {
                    ...(asset.previewUrl ? { url: `/api/assets/${asset.previewUrl}` } : {}),
                    ...(asset.blurhash ? { blurhash: asset.blurhash } : {})
                },
                asset.deepZoom
            );
        }
    });
    const url = `/api/assets/${asset.url}`;
    const deepZoom = createImageDeepZoomLayerDescriptor(asset);
    const dimensions = deepZoom ?? (await readMediaDimensions(url, false, session.signal));
    // Read the latest draft synchronously: never allocate again or restore an
    // old transform, even when a drag/pinch is still in progress.
    const layer = draft.update(
        {
            url,
            ...(deepZoom ? { deepZoom } : {}),
            ...(asset.blurhash ? { blurhash: asset.blurhash } : {}),
            progress: 100
        },
        dimensions,
        true
    );
    EditorEngine.getInstance().createLayer(origin, layer);
    useEditorStore.getState().markDirty();
    return layer;
}
