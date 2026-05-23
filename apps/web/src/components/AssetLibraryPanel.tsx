import { CaretDownIcon, ImageIcon } from '@phosphor-icons/react';
import { useCallback } from 'react';

import { EditorEngine } from '~/lib/editorEngine';
import { useEditorStore } from '~/lib/editorStore';
import { fitSizeToViewport } from '~/lib/fitSizeToViewport';
import { stripFileExtension, makeUniqueLayerName } from '~/lib/mediaUtils';
import type { Layer, LayerWithEditorState } from '~/lib/types';
import { $deleteAsset } from '~/server/projects.fns';

import { AssetLibrary, type AssetLibraryAsset } from './AssetLibrary';

interface AssetLibraryPanelProps {
    projectId: string;
    titleBarSize?: number;
    collapsed?: boolean;
    onCollapse?: () => void;
    onExpand?: () => void;
}

export function AssetLibraryPanel({
    projectId,
    titleBarSize = 40,
    collapsed = false,
    onCollapse,
    onExpand
}: AssetLibraryPanelProps) {
    const addAssetAsLayer = useCallback(async (asset: AssetLibraryAsset) => {
        const isVideo =
            asset.mimeType?.startsWith('video/') ||
            /\.(mp4|mov|webm|avi|mkv)$/i.test(asset.name) ||
            /\.(mp4|mov|webm|avi|mkv)$/i.test(asset.url);

        const store = useEditorStore.getState();
        const engine = EditorEngine.getInstance();
        const numericId = store.allocateId();
        const zIndex = store.allocateZIndex();
        const { x: insertionX, y: insertionY } = store.insertionCenter;

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
                // use defaults
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
                // use defaults
            }
        }

        const fitted = fitSizeToViewport(
            mediaWidth,
            mediaHeight,
            store.insertionViewport.width,
            store.insertionViewport.height
        );

        const config: Layer['config'] = {
            cx: insertionX,
            cy: insertionY,
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

        const layerName = makeUniqueLayerName(
            stripFileExtension(asset.name),
            Array.from(store.layers.values()).map((layer) => layer.name)
        );

        const layerBase = {
            numericId,
            name: layerName,
            url: `/api/assets/${asset.url}`,
            config,
            isUploading: false,
            progress: 100
        };

        let layer:
            | Extract<LayerWithEditorState, { type: 'image' }>
            | Extract<LayerWithEditorState, { type: 'video' }>;
        if (isVideo) {
            layer = {
                type: 'video',
                playback: defaultPlayback,
                rvfcActive: false,
                duration,
                loop: true,
                blurhash: asset.blurhash ?? '',
                ...layerBase
            };
        } else {
            layer = {
                type: 'image',
                blurhash: asset.blurhash ?? '',
                ...layerBase
            };
        }

        store.upsertLayer(layer);
        store.toggleLayerSelection(numericId.toString(), false, false);

        engine.sendJSON({
            type: 'upsert_layer',
            origin: 'editor:asset_library',
            layer
        });
        store.markDirty();
    }, []);

    const deleteAsset = useCallback(async (asset: AssetLibraryAsset) => {
        const store = useEditorStore.getState();
        const assetUrl = asset.url;
        const prefixedUrl = `/api/assets/${assetUrl}`;
        for (const layer of store.layers.values()) {
            if (
                (layer.type === 'image' || layer.type === 'video') &&
                (layer.url === assetUrl || layer.url === prefixedUrl)
            ) {
                store.removeLayer(layer.numericId);
            }
        }
        await $deleteAsset({ data: { id: asset.id } });
    }, []);

    const toggleCollapse = () => {
        if (collapsed) onExpand?.();
        else onCollapse?.();
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-muted/30">
            <button
                onClick={toggleCollapse}
                className="flex shrink-0 cursor-pointer items-center justify-between border-b border-border bg-muted/50 px-4"
                style={{ height: titleBarSize }}
            >
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <ImageIcon size={18} weight="bold" /> Media
                </h2>
                <CaretDownIcon
                    size={14}
                    weight="bold"
                    className={`text-muted-foreground transition-transform ${collapsed ? '' : 'rotate-180'}`}
                />
            </button>

            {!collapsed ? (
                <div className="min-h-0 flex-1">
                    <AssetLibrary
                        projectId={projectId}
                        onSelectAsset={addAssetAsLayer}
                        onDeleteAsset={deleteAsset}
                    />
                </div>
            ) : null}
        </div>
    );
}
