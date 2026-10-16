import { CaretDownIcon, ImageIcon } from '@phosphor-icons/react';
import { useCallback } from 'react';
import { toast } from 'sonner';

import { placeAssetInEditor } from '~/lib/editorMediaPlacement';
import { useEditorStore } from '~/lib/editorStore';
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
    const addAssetAsLayer = useCallback(
        async (asset: AssetLibraryAsset) => {
            try {
                await placeAssetInEditor({
                    assetId: asset.id,
                    projectId,
                    origin: 'editor:asset_library'
                });
            } catch (error) {
                if (error instanceof Error && error.name === 'AbortError') return;
                toast.error(error instanceof Error ? error.message : 'Unable to add this asset');
            }
        },
        [projectId]
    );

    const deleteAsset = useCallback(async (asset: AssetLibraryAsset) => {
        if (asset.deepZoom) {
            await $deleteAsset({ data: { id: asset.id } });
            return;
        }
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
