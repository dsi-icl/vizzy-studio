import {
    CaretUpDownIcon,
    DownloadIcon,
    EyeIcon,
    FileIcon,
    FileTextIcon,
    ImageIcon,
    ListIcon,
    RowsIcon,
    SquaresFourIcon,
    TrashIcon,
    VideoCameraIcon
} from '@phosphor-icons/react';
import type { AssetDocument } from '@repo/db/documents';

type Asset = Omit<AssetDocument, '_id' | '_version'>;
import { Button } from '@repo/ui/components/button';
import { DateDisplay } from '@repo/ui/components/date-display';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogTitle
} from '@repo/ui/components/dialog';
import { ProjectImage } from '@repo/ui/components/project-image';
import { useLocalStorageValue } from '@repo/ui/hooks/use-localstorage-value';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getSortedRowModel,
    useReactTable,
    type SortingState
} from '@tanstack/react-table';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { AssetPreviewPortal, downloadAsset, isVideoAsset } from '~/components/AssetPreviewOverlay';
import { FontPlaceholder } from '~/components/FontPlaceholder';
import { UploadDialog } from '~/components/UploadDialog';
import { PUBLIC_ASSET_PROJECT_ID } from '~/lib/constants';
import { isFontAsset, sortAssetsFontsLast } from '~/lib/mediaUtils';
import { useSubHeaderSlot } from '~/lib/subHeaderSlot';
import { $adminDeletePublicAsset, $adminGetUploadToken } from '~/server/admin.fns';
import { adminPublicAssetsQueryOptions } from '~/server/admin.queries';
import { $revokeUploadToken } from '~/server/projects.fns';

const assetColumnHelper = createColumnHelper<Asset>();

export const Route = createFileRoute('/admin/assets')({
    loader: ({ context }) => {
        context.queryClient.ensureQueryData(adminPublicAssetsQueryOptions());
    },
    component: AdminAssetsPage,
    head: () => ({
        meta: [{ title: 'Public Assets · Admin · Vizzy Studio' }]
    })
});

type View = 'list' | 'list-preview' | 'grid';
type KindFilter = 'media' | 'font';

function AdminAssetsSkeleton() {
    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between">
                <div>
                    <div className="h-6 w-40 animate-pulse rounded bg-muted" />
                    <div className="mt-2 h-4 w-80 animate-pulse rounded bg-muted" />
                </div>
                <div className="h-9 w-36 animate-pulse rounded bg-muted" />
            </div>
            <div className="h-64 animate-pulse rounded-2xl border border-border bg-muted/30" />
        </div>
    );
}

function AdminAssetsTab() {
    const { data: assets } = useSuspenseQuery({
        ...adminPublicAssetsQueryOptions(),
        refetchInterval: 5000
    });
    const queryClient = useQueryClient();
    const [view, setView] = useLocalStorageValue<View>('assets-view', 'list');
    const [kindFilter, setKindFilter] = useLocalStorageValue<KindFilter>(
        'admin-assets-kind-filter',
        'media'
    );
    const [sorting, setSorting] = useState<SortingState>([]);
    const [hydrated] = useState(() => typeof window !== 'undefined');
    const [preview, setPreview] = useState<{
        src: string;
        name: string;
        isVideo: boolean;
        blurhash?: string;
        sizes?: number[];
    } | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

    const displayedAssets = useMemo(() => {
        const sorted = sortAssetsFontsLast(assets ?? []);
        return sorted.filter((asset) =>
            kindFilter === 'font' ? isFontAsset(asset) : !isFontAsset(asset)
        );
    }, [assets, kindFilter]);

    const deleteAssetMutation = useMutation({
        mutationFn: (id: string) => $adminDeletePublicAsset({ data: { id } }),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: adminPublicAssetsQueryOptions().queryKey
            });
            toast.success('Asset deleted');
            setDeleteTarget(null);
        },
        onError: (e: any) => toast.error(e.message)
    });

    const handleUploadComplete = useCallback(() => {
        queryClient.invalidateQueries({
            queryKey: adminPublicAssetsQueryOptions().queryKey
        });
    }, [queryClient]);

    const openPreview = (asset: {
        url: string;
        name: string;
        mimeType?: string | null;
        previewUrl?: string | null;
        size: number;
        blurhash?: string | null;
        sizes?: number[] | null;
    }) => {
        if (isFontAsset(asset)) return;
        const isVideo = isVideoAsset(asset);
        setPreview({
            src: `/api/assets/${asset.url}`,
            name: asset.name,
            isVideo,
            blurhash: asset.blurhash ?? undefined,
            sizes: asset.sizes ?? undefined
        });
    };

    const handleDownload = (asset: { url: string; name: string }) => {
        downloadAsset(`/api/assets/${asset.url}`, asset.name);
    };
    const handleDeleteClick = useCallback((asset: { id: string; name: string }) => {
        setDeleteTarget({ id: asset.id, name: asset.name });
    }, []);

    const uploadTrigger = <Button variant="outline">Upload assets</Button>;
    const getAssetTypeLabel = (asset: { mimeType?: string | null; name: string }) =>
        asset.mimeType || (isFontAsset(asset) ? 'font/woff2' : 'application/octet-stream');
    const getAssetTypeIcon = (asset: { mimeType?: string | null; name: string }) => {
        const type = getAssetTypeLabel(asset);
        if (type.startsWith('image/')) return ImageIcon;
        if (type.startsWith('video/')) return VideoCameraIcon;
        if (type.startsWith('font/')) return FileTextIcon;
        return FileIcon;
    };

    const columns = useMemo(
        () => [
            assetColumnHelper.display({
                id: 'thumbnail',
                header: '',
                size: 50,
                cell: (info) => {
                    const asset = info.row.original;
                    return (
                        <div className="size-8 shrink-0 overflow-hidden rounded bg-muted">
                            {isFontAsset(asset) ? (
                                <FontPlaceholder name={asset.name} className="h-full w-full" />
                            ) : (
                                <ProjectImage
                                    src={asset.previewUrl ?? asset.url}
                                    blurhash={asset.blurhash ?? undefined}
                                    sizes={asset.sizes ?? undefined}
                                    alt={asset.name}
                                    className="h-full w-full"
                                    imgClassName="object-cover"
                                />
                            )}
                        </div>
                    );
                },
                enableSorting: false
            }),
            assetColumnHelper.accessor('name', {
                header: ({ column }) => (
                    <button
                        type="button"
                        className="flex items-center gap-1"
                        onClick={() => column.toggleSorting()}
                    >
                        Name <CaretUpDownIcon className="size-3" />
                    </button>
                ),
                cell: (info) => {
                    const asset = info.row.original;
                    const TypeIcon = getAssetTypeIcon(asset);
                    return (
                        <div>
                            <span className="font-medium">{info.getValue()}</span>
                            <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                                <TypeIcon size={12} className="shrink-0" />
                                {getAssetTypeLabel(asset)}
                            </p>
                        </div>
                    );
                }
            }),
            assetColumnHelper.accessor('size', {
                header: ({ column }) => (
                    <button
                        type="button"
                        className="flex items-center gap-1"
                        onClick={() => column.toggleSorting()}
                    >
                        Size <CaretUpDownIcon className="size-3" />
                    </button>
                ),
                cell: (info) => {
                    const bytes = info.getValue();
                    const display =
                        bytes >= 1048576
                            ? `${(bytes / 1048576).toFixed(1)} MB`
                            : `${(bytes / 1024).toFixed(1)} KB`;
                    return <span className="text-muted-foreground">{display}</span>;
                }
            }),
            assetColumnHelper.accessor('createdAt', {
                header: ({ column }) => (
                    <button
                        type="button"
                        className="flex items-center gap-1"
                        onClick={() => column.toggleSorting()}
                    >
                        Created <CaretUpDownIcon className="size-3" />
                    </button>
                ),
                cell: (info) => (
                    <DateDisplay value={info.getValue()} className="text-muted-foreground" />
                )
            }),
            assetColumnHelper.display({
                id: 'actions',
                cell: (info) => {
                    const asset = info.row.original;
                    return (
                        <div className="flex items-center justify-end gap-0.5">
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => openPreview(asset)}
                                disabled={isFontAsset(asset)}
                                title="Preview"
                            >
                                <EyeIcon />
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => handleDownload(asset)}
                                title="Download"
                            >
                                <DownloadIcon />
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => handleDeleteClick(asset)}
                                disabled={deleteAssetMutation.isPending}
                                title="Delete"
                            >
                                <TrashIcon />
                            </Button>
                        </div>
                    );
                }
            })
        ],
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [deleteAssetMutation.isPending]
    );

    // oxlint-disable-next-line
    const table = useReactTable({
        data: displayedAssets as Asset[],
        columns,
        state: { sorting },
        onSortingChange: setSorting,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel()
    });

    useSubHeaderSlot(
        hydrated ? (
            <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 rounded-lg border p-1">
                    <Button
                        variant={kindFilter === 'media' ? 'secondary' : 'ghost'}
                        size="sm"
                        onClick={() => setKindFilter('media')}
                    >
                        <ImageIcon size={14} /> Media
                    </Button>
                    <Button
                        variant={kindFilter === 'font' ? 'secondary' : 'ghost'}
                        size="sm"
                        onClick={() => setKindFilter('font')}
                    >
                        <FileTextIcon size={14} /> Fonts
                    </Button>
                </div>
                <div className="flex items-center gap-1 rounded-lg border p-1">
                    <Button
                        variant={view === 'list' ? 'secondary' : 'ghost'}
                        size="icon-sm"
                        onClick={() => setView('list')}
                    >
                        <ListIcon />
                    </Button>
                    <Button
                        variant={view === 'list-preview' ? 'secondary' : 'ghost'}
                        size="icon-sm"
                        onClick={() => setView('list-preview')}
                    >
                        <RowsIcon />
                    </Button>
                    <Button
                        variant={view === 'grid' ? 'secondary' : 'ghost'}
                        size="icon-sm"
                        onClick={() => setView('grid')}
                    >
                        <SquaresFourIcon />
                    </Button>
                </div>
                <UploadDialog
                    projectId={PUBLIC_ASSET_PROJECT_ID}
                    trigger={uploadTrigger}
                    createTokenFn={() => $adminGetUploadToken()}
                    revokeTokenFn={(token) => $revokeUploadToken({ data: { token } })}
                    onUploadComplete={handleUploadComplete}
                />
            </div>
        ) : null
    );

    if (!hydrated) {
        return <AdminAssetsSkeleton />;
    }

    return (
        <div className="flex flex-col gap-4">
            {displayedAssets.length === 0 && (
                <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed text-muted-foreground">
                    <p>{kindFilter === 'font' ? 'No public fonts yet' : 'No public media yet'}</p>
                    <UploadDialog
                        projectId={PUBLIC_ASSET_PROJECT_ID}
                        trigger={
                            <button className="cursor-pointer text-xs text-primary hover:underline">
                                Upload assets to get started
                            </button>
                        }
                        createTokenFn={() => $adminGetUploadToken()}
                        revokeTokenFn={(token) => $revokeUploadToken({ data: { token } })}
                        onUploadComplete={handleUploadComplete}
                    />
                </div>
            )}

            {view === 'list' && displayedAssets.length > 0 && (
                <div className="overflow-hidden rounded-2xl border">
                    <table className="w-full text-sm">
                        <thead>
                            {table.getHeaderGroups().map((headerGroup) => (
                                <tr key={headerGroup.id} className="border-b bg-muted/50 text-left">
                                    {headerGroup.headers.map((header) => (
                                        <th
                                            key={header.id}
                                            className="px-4 py-2.5 font-medium text-muted-foreground"
                                        >
                                            {header.isPlaceholder
                                                ? null
                                                : flexRender(
                                                      header.column.columnDef.header,
                                                      header.getContext()
                                                  )}
                                        </th>
                                    ))}
                                </tr>
                            ))}
                        </thead>
                        <tbody>
                            {table.getRowModel().rows.map((row) => (
                                <tr
                                    key={row.id}
                                    className="border-b transition-colors last:border-b-0 hover:bg-muted/30"
                                >
                                    {row.getVisibleCells().map((cell) => (
                                        <td key={cell.id} className="px-4 py-2">
                                            {flexRender(
                                                cell.column.columnDef.cell,
                                                cell.getContext()
                                            )}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {view === 'list-preview' && displayedAssets.length > 0 && (
                <div className="flex flex-col gap-2">
                    {displayedAssets.map((asset: Asset) => (
                        <div
                            key={asset.id}
                            className="flex items-center gap-3 rounded-lg border p-2"
                        >
                            {isFontAsset(asset) ? (
                                <FontPlaceholder name={asset.name} className="h-16 w-16" />
                            ) : (
                                <div className="group relative h-16 w-16 overflow-hidden rounded-md">
                                    <ProjectImage
                                        src={asset.previewUrl ?? asset.url}
                                        blurhash={asset.blurhash ?? undefined}
                                        sizes={asset.sizes ?? undefined}
                                        alt={asset.name}
                                        className="h-16 w-16 rounded-md"
                                        imgClassName="cursor-pointer object-cover"
                                        onClick={() => openPreview(asset)}
                                    />
                                    <div className="absolute top-0.5 right-0.5 z-20 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 touch-only:opacity-100 last-touch:opacity-100">
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                openPreview(asset);
                                            }}
                                            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded bg-black/60 text-white hover:bg-black/80"
                                            title="Preview"
                                        >
                                            <EyeIcon size={12} />
                                        </button>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleDownload(asset);
                                            }}
                                            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded bg-black/60 text-white hover:bg-black/80"
                                            title="Download"
                                        >
                                            <DownloadIcon size={12} />
                                        </button>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleDeleteClick(asset);
                                            }}
                                            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded bg-black/60 text-white hover:bg-destructive"
                                            title="Delete"
                                        >
                                            <TrashIcon size={12} />
                                        </button>
                                    </div>
                                </div>
                            )}
                            <div className="flex-1">
                                <div className="font-medium">{asset.name}</div>
                                <div className="text-xs text-muted-foreground">
                                    {(asset.size / 1024).toFixed(2)} KB
                                </div>
                            </div>
                            <div className="flex items-center gap-0.5">
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => openPreview(asset)}
                                    disabled={isFontAsset(asset)}
                                    title="Preview"
                                >
                                    <EyeIcon />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => handleDownload(asset)}
                                    title="Download"
                                >
                                    <DownloadIcon />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => handleDeleteClick(asset)}
                                    disabled={deleteAssetMutation.isPending}
                                    title="Delete"
                                >
                                    <TrashIcon />
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {view === 'grid' && displayedAssets.length > 0 && (
                <div className="grid grid-cols-4 gap-2">
                    {displayedAssets.map((asset: Asset) => (
                        <div key={asset.id} className="group relative">
                            {isFontAsset(asset) ? (
                                <FontPlaceholder
                                    name={asset.name}
                                    className="aspect-square w-full"
                                />
                            ) : (
                                <ProjectImage
                                    src={asset.previewUrl ?? asset.url}
                                    blurhash={asset.blurhash ?? undefined}
                                    sizes={asset.sizes ?? undefined}
                                    alt={asset.name}
                                    className="aspect-square w-full rounded-lg"
                                    imgClassName="cursor-pointer object-cover"
                                    onClick={() => openPreview(asset)}
                                />
                            )}
                            {!isFontAsset(asset) ? (
                                <>
                                    <div className="absolute inset-x-0 bottom-0 z-20 bg-linear-to-t from-black/60 to-transparent px-1 pt-3 pb-0.5 opacity-0 transition-opacity group-hover:opacity-100 touch-only:opacity-100 last-touch:opacity-100">
                                        <span className="block truncate text-[10px] text-white">
                                            {asset.name}
                                        </span>
                                    </div>
                                    <div className="absolute top-0.5 right-0.5 z-20 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 touch-only:opacity-100 last-touch:opacity-100">
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                openPreview(asset);
                                            }}
                                            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded bg-black/60 text-white hover:bg-black/80"
                                            title="Preview"
                                        >
                                            <EyeIcon size={12} />
                                        </button>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleDownload(asset);
                                            }}
                                            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded bg-black/60 text-white hover:bg-black/80"
                                            title="Download"
                                        >
                                            <DownloadIcon size={12} />
                                        </button>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleDeleteClick(asset);
                                            }}
                                            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded bg-black/60 text-white hover:bg-destructive"
                                            title="Delete"
                                        >
                                            <TrashIcon size={12} />
                                        </button>
                                    </div>
                                </>
                            ) : null}
                        </div>
                    ))}
                </div>
            )}

            <AssetPreviewPortal preview={preview} onClose={() => setPreview(null)} />
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
                            disabled={deleteAssetMutation.isPending || !deleteTarget}
                            onClick={() => {
                                if (!deleteTarget) return;
                                deleteAssetMutation.mutate(deleteTarget.id);
                            }}
                        >
                            {deleteAssetMutation.isPending ? 'Deleting...' : 'Delete'}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function AdminAssetsPage() {
    return <AdminAssetsTab />;
}
