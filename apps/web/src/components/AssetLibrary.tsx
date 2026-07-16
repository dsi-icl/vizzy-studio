import {
    CheckIcon,
    DownloadIcon,
    EyeIcon,
    ImageIcon,
    TrashIcon,
    UploadSimpleIcon
} from '@phosphor-icons/react';
import { Button } from '@repo/ui/components/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogTitle
} from '@repo/ui/components/dialog';
import { ProjectImage } from '@repo/ui/components/project-image';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState, type DragEvent } from 'react';
import { toast } from 'sonner';

import { isFontAsset } from '~/lib/mediaUtils';
import { $deleteAsset } from '~/server/projects.fns';
import {
    projectAssetsQueryOptions,
    projectPickerSelectedAssetsQueryOptions
} from '~/server/projects.queries';

import { AssetPreviewPortal, downloadAsset, isVideoAsset } from './AssetPreviewOverlay';
import { UploadDialog } from './UploadDialog';

interface AssetLibraryProps {
    projectId: string;
    mode?: 'editor' | 'picker';
    pickerFilter?: 'image' | 'media';
    selectedAssetUrls?: string[];
    includeSelectedSoftDeletedInPicker?: boolean;
    onSelectAsset?: (asset: AssetLibraryAsset) => void;
    onDeleteAsset?: (asset: AssetLibraryAsset) => Promise<void> | void;
}

export type AssetLibraryAsset = {
    id: string;
    name: string;
    url: string;
    public?: boolean;
    mimeType?: string;
    blurhash?: string;
    sizes?: number[];
    previewUrl?: string;
};

const ASSET_DRAG_MIME = 'application/x-vizzy-asset';

export function getAssetDragMimeType() {
    return ASSET_DRAG_MIME;
}

export function AssetLibrary({
    projectId,
    mode = 'editor',
    pickerFilter = 'media',
    selectedAssetUrls = [],
    includeSelectedSoftDeletedInPicker = false,
    onSelectAsset,
    onDeleteAsset
}: AssetLibraryProps) {
    const isPicker = mode === 'picker';
    const normalizeAssetUrl = (url: string) => url.replace(/^\/api\/assets\//, '');
    const { data: assets = [] } = useQuery(projectAssetsQueryOptions(projectId));
    const normalizedSelectedUrls = useMemo(
        () =>
            Array.from(
                new Set(selectedAssetUrls.map((url) => url.replace(/^\/api\/assets\//, '')))
            ),
        [selectedAssetUrls]
    );
    const { data: selectedFallbackAssets = [] } = useQuery({
        ...projectPickerSelectedAssetsQueryOptions(projectId, normalizedSelectedUrls),
        enabled: isPicker && includeSelectedSoftDeletedInPicker && normalizedSelectedUrls.length > 0
    });
    const sortedAssets = useMemo(() => {
        const media: typeof assets = [];
        const fonts: typeof assets = [];
        for (const asset of assets) {
            if (isFontAsset(asset)) fonts.push(asset);
            else media.push(asset);
        }
        const sorted = [...media, ...fonts].map((asset) => ({
            id: asset.id,
            name: asset.name,
            url: asset.url,
            public: asset.public ?? false,
            mimeType: asset.mimeType ?? undefined,
            blurhash: asset.blurhash ?? undefined,
            sizes: asset.sizes ?? undefined,
            previewUrl: asset.previewUrl ?? undefined
        }));
        if (!isPicker) return sorted;
        const filteredSorted =
            pickerFilter === 'image'
                ? sorted.filter(
                      (asset) =>
                          !isFontAsset(asset) &&
                          !isVideoAsset(asset as { name: string; mimeType?: string })
                  )
                : sorted.filter((asset) => !isFontAsset(asset));

        if (!includeSelectedSoftDeletedInPicker || normalizedSelectedUrls.length === 0) {
            return filteredSorted;
        }

        const mergedByUrl = new Map(
            filteredSorted.map((asset) => [normalizeAssetUrl(asset.url), asset] as const)
        );
        const fallbackByUrl = new Map(
            selectedFallbackAssets.map((asset) => [
                normalizeAssetUrl(asset.url),
                {
                    id: asset.id,
                    name: asset.name,
                    url: asset.url,
                    public: asset.public ?? false,
                    mimeType: asset.mimeType ?? undefined,
                    blurhash: asset.blurhash ?? undefined,
                    sizes: asset.sizes ?? undefined,
                    previewUrl: asset.previewUrl ?? undefined
                } satisfies AssetLibraryAsset
            ])
        );
        for (const selectedUrl of normalizedSelectedUrls) {
            if (mergedByUrl.has(selectedUrl)) continue;
            const fallback = fallbackByUrl.get(selectedUrl);
            if (fallback) {
                mergedByUrl.set(selectedUrl, fallback);
                continue;
            }
            mergedByUrl.set(selectedUrl, {
                id: `missing:${selectedUrl}`,
                name: selectedUrl,
                url: selectedUrl,
                public: false,
                mimeType: undefined,
                blurhash: undefined,
                sizes: undefined,
                previewUrl: undefined
            });
        }

        return Array.from(mergedByUrl.values());
    }, [
        assets,
        includeSelectedSoftDeletedInPicker,
        isPicker,
        normalizedSelectedUrls,
        pickerFilter,
        selectedFallbackAssets
    ]);
    const queryClient = useQueryClient();
    const [deleteTarget, setDeleteTarget] = useState<{
        id: string;
        name: string;
        asset: AssetLibraryAsset;
    } | null>(null);
    const [preview, setPreview] = useState<{
        src: string;
        name: string;
        isVideo: boolean;
        blurhash?: string;
        sizes?: number[];
    } | null>(null);

    const deleteAssetMutation = useMutation({
        mutationFn: async (asset: AssetLibraryAsset) => {
            if (onDeleteAsset) {
                await onDeleteAsset(asset);
                return;
            }
            await $deleteAsset({ data: { id: asset.id } });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: projectAssetsQueryOptions(projectId).queryKey
            });
            toast.success('Asset deleted');
            setDeleteTarget(null);
        },
        onError: (e) => toast.error(e.message)
    });

    const handleDeleteClick = useCallback((asset: AssetLibraryAsset) => {
        setDeleteTarget({ id: asset.id, name: asset.name, asset });
    }, []);

    const handleUploadComplete = useCallback(() => {
        queryClient.invalidateQueries({
            queryKey: projectAssetsQueryOptions(projectId).queryKey
        });
    }, [projectId, queryClient]);

    const handleAssetDragStart = (e: DragEvent<HTMLDivElement>, asset: AssetLibraryAsset) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData(ASSET_DRAG_MIME, JSON.stringify(asset));
        // Fallback for environments that strip custom MIME types.
        e.dataTransfer.setData('text/plain', asset.url);
    };

    const uploadTrigger = (
        <button className="group relative flex aspect-square w-full max-w-25 cursor-pointer flex-col justify-center overflow-hidden rounded-md border border-border bg-background text-center align-middle transition-colors hover:border-primary">
            <UploadSimpleIcon size={16} className="w-full" />
            <span className="text-xs">Upload</span>
        </button>
    );

    const emptyTrigger = (
        <button className="flex flex-1 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-4 text-muted-foreground transition-colors hover:border-primary hover:text-primary">
            <UploadSimpleIcon size={24} />
            <span className="text-xs">Drop files or click to upload</span>
        </button>
    );

    return (
        <div className="flex h-full flex-col overflow-hidden bg-muted/30">
            <div className="flex flex-1 flex-col overflow-y-auto p-2">
                {sortedAssets.length === 0 &&
                    (isPicker ? (
                        <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
                            No assets available
                        </div>
                    ) : (
                        <UploadDialog
                            projectId={projectId}
                            trigger={emptyTrigger}
                            onUploadComplete={handleUploadComplete}
                        />
                    ))}

                {sortedAssets.length > 0 && (
                    <>
                        <div
                            className="grid gap-1.5"
                            style={{
                                gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))'
                            }}
                        >
                            {!isPicker ? (
                                <UploadDialog
                                    key={'upload-dialog'}
                                    projectId={projectId}
                                    trigger={uploadTrigger}
                                    onUploadComplete={handleUploadComplete}
                                />
                            ) : null}
                            {sortedAssets.map((asset, idx) => {
                                const isVideo =
                                    asset.mimeType?.startsWith('video/') ||
                                    /\.(mp4|mov|webm|avi|mkv)$/i.test(asset.name);
                                const isFont = isFontAsset(asset);
                                const isSelected =
                                    isPicker &&
                                    selectedAssetUrls
                                        .map(normalizeAssetUrl)
                                        .includes(normalizeAssetUrl(asset.url));
                                const thumbIdentifier = isVideo
                                    ? (asset.previewUrl ?? asset.url)
                                    : asset.url;

                                const cardContent = (
                                    <>
                                        {isFont ? (
                                            <div className="flex aspect-square flex-col items-center justify-center gap-1 bg-muted text-muted-foreground [--checker-size:10px]">
                                                <span className="rounded bg-background px-1.5 py-0.5 text-[9px] font-semibold tracking-wide">
                                                    WOFF2
                                                </span>
                                                <span className="max-w-[90%] truncate text-[10px]">
                                                    {asset.name.replace(/\.woff2$/i, '')}
                                                </span>
                                            </div>
                                        ) : thumbIdentifier ? (
                                            <ProjectImage
                                                src={thumbIdentifier}
                                                blurhash={asset.blurhash}
                                                sizes={asset.sizes}
                                                alt={asset.name}
                                                className="aspect-square w-full [--checker-size:10px]"
                                                imgClassName="object-cover"
                                            />
                                        ) : (
                                            <div className="flex aspect-square items-center justify-center bg-muted">
                                                <ImageIcon
                                                    size={24}
                                                    className="text-muted-foreground"
                                                />
                                            </div>
                                        )}
                                        <div className="absolute inset-x-0 bottom-0 z-20 bg-linear-to-t from-black/60 to-transparent px-1 pt-3 pb-0.5 opacity-0 transition-opacity group-hover:opacity-100 touch-only:opacity-100 last-touch:opacity-100">
                                            <span className="block truncate text-[10px] text-white">
                                                {asset.name}
                                            </span>
                                        </div>
                                        {isPicker ? (
                                            isSelected ? (
                                                <span className="absolute top-0.5 right-0.5 z-20 rounded-full bg-primary p-1 text-primary-foreground">
                                                    <CheckIcon size={11} />
                                                </span>
                                            ) : null
                                        ) : (
                                            <div className="absolute top-0.5 right-0.5 z-20 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 touch-only:opacity-100 last-touch:opacity-100">
                                                {!isFont ? (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setPreview({
                                                                src: `/api/assets/${asset.url}`,
                                                                name: asset.name,
                                                                isVideo: isVideoAsset(asset),
                                                                blurhash: asset.blurhash,
                                                                sizes: asset.sizes
                                                            });
                                                        }}
                                                        className="flex h-5 w-5 cursor-pointer items-center justify-center rounded bg-black/60 text-white hover:bg-black/80"
                                                        title="Preview"
                                                    >
                                                        <EyeIcon size={12} />
                                                    </button>
                                                ) : null}
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        downloadAsset(
                                                            `/api/assets/${asset.url}`,
                                                            asset.name
                                                        );
                                                    }}
                                                    className="flex h-5 w-5 cursor-pointer items-center justify-center rounded bg-black/60 text-white hover:bg-black/80"
                                                    title="Download"
                                                >
                                                    <DownloadIcon size={12} />
                                                </button>
                                                {!asset.public ? (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleDeleteClick(asset);
                                                        }}
                                                        className="flex h-5 w-5 cursor-pointer items-center justify-center rounded bg-black/60 text-white hover:bg-destructive"
                                                        title="Delete asset"
                                                    >
                                                        <TrashIcon size={12} />
                                                    </button>
                                                ) : null}
                                            </div>
                                        )}
                                    </>
                                );

                                if (isFont) {
                                    return (
                                        <div
                                            key={asset.id}
                                            className="bg-checkerboard group relative max-w-25 cursor-default overflow-hidden rounded-md border border-border bg-background opacity-90"
                                            title={asset.name}
                                            tabIndex={idx}
                                        >
                                            {cardContent}
                                        </div>
                                    );
                                }

                                return (
                                    <div
                                        key={asset.id}
                                        onClick={() => {
                                            onSelectAsset?.(asset);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault();
                                                onSelectAsset?.(asset);
                                            }
                                        }}
                                        className={`bg-checkerboard group relative max-w-25 cursor-pointer overflow-hidden rounded-md border bg-background transition-colors hover:border-primary ${
                                            isSelected
                                                ? 'border-primary ring-2 ring-primary/40'
                                                : 'border-border'
                                        }`}
                                        title={asset.name}
                                        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
                                        role="button"
                                        tabIndex={idx}
                                        draggable={!isPicker}
                                        onDragStart={(e) => {
                                            if (isPicker) return;
                                            handleAssetDragStart(e, asset);
                                        }}
                                    >
                                        {cardContent}
                                    </div>
                                );
                            })}
                        </div>
                    </>
                )}
            </div>

            {!isPicker ? (
                <AssetPreviewPortal preview={preview} onClose={() => setPreview(null)} />
            ) : null}

            {!isPicker ? (
                <Dialog
                    open={deleteTarget !== null}
                    onOpenChange={(open) => {
                        if (!open) setDeleteTarget(null);
                    }}
                >
                    <DialogContent className="w-80 p-5">
                        <DialogTitle>Delete asset</DialogTitle>
                        <DialogDescription className="mt-1">
                            Are you sure you want to delete <strong>{deleteTarget?.name}</strong>?
                        </DialogDescription>
                        <div className="mt-4 flex justify-end gap-2">
                            <DialogClose>
                                <Button variant="outline" size="sm">
                                    Cancel
                                </Button>
                            </DialogClose>
                            <Button
                                variant="destructive"
                                size="sm"
                                disabled={deleteAssetMutation.isPending}
                                onClick={() => {
                                    if (deleteTarget) {
                                        deleteAssetMutation.mutate(deleteTarget.asset);
                                    }
                                }}
                            >
                                {deleteAssetMutation.isPending ? 'Deleting...' : 'Delete'}
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            ) : null}
        </div>
    );
}
