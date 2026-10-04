import { ImageDeepZoomLayer, type ImageDeepZoomAsset } from '@repo/db/schema';

import type { Layer } from './types';

export function deriveVideoStillImageFilename(url: string): string | null {
    if (!url.startsWith('/api/assets/')) return null;
    const filename = url.split('/').pop() ?? '';
    const base = filename.replace(/\.[^.]+$/, '');
    return base ? `${base}.jpg` : null;
}

export function isFontAsset(asset: { name: string; mimeType?: string | null }): boolean {
    return asset.mimeType === 'font/woff2' || /\.woff2$/i.test(asset.name);
}

export function sortAssetsFontsLast<T extends { name: string; mimeType?: string | null }>(
    items: T[]
): T[] {
    const media: T[] = [];
    const fonts: T[] = [];
    for (const item of items) {
        if (isFontAsset(item)) fonts.push(item);
        else media.push(item);
    }
    return [...media, ...fonts];
}

function stripFileExtension(name: string): string {
    const trimmed = name.trim();
    const dot = trimmed.lastIndexOf('.');
    if (dot <= 0) return trimmed;
    return trimmed.slice(0, dot);
}

export function makeUniqueMediaLayerName(
    filename: string,
    existingLayers: Iterable<{ type: string; name?: string }>
): string {
    const baseName = stripFileExtension(filename) || 'Untitled';
    const existingMediaNames = Array.from(existingLayers).flatMap((layer) => {
        if (layer.type === 'image') return [layer.name?.trim() || 'Image'];
        if (layer.type === 'video') return [layer.name?.trim() || 'Video'];
        return [];
    });
    const usedNames = new Set(existingMediaNames.map((name) => name.toLowerCase()));

    if (!usedNames.has(baseName.toLowerCase())) return baseName;

    let suffix = 1;
    while (usedNames.has(`${baseName} ${suffix}`.toLowerCase())) {
        suffix += 1;
    }

    return `${baseName} ${suffix}`;
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
    deepZoom?: ImageDeepZoomAsset;
};

export function toLibraryAsset(asset: {
    id: string;
    name: string;
    url: string;
    public?: boolean | null;
    mimeType?: string | null;
    blurhash?: string | null;
    sizes?: number[] | null;
    previewUrl?: string | null;
    deepZoom?: ImageDeepZoomAsset;
}): AssetLibraryAsset {
    return {
        id: asset.id,
        name: asset.name,
        url: asset.url,
        public: asset.public ?? false,
        mimeType: asset.mimeType ?? undefined,
        blurhash: asset.blurhash ?? undefined,
        sizes: asset.sizes ?? undefined,
        previewUrl: asset.previewUrl ?? undefined,
        ...(asset.deepZoom ? { deepZoom: asset.deepZoom } : {})
    };
}

export function isAssetProcessing(asset: { deepZoom?: ImageDeepZoomAsset }) {
    return asset.deepZoom?.status === 'queued' || asset.deepZoom?.status === 'processing';
}

export function canPlaceAsset(
    asset: AssetLibraryAsset,
    { allowProcessing = false }: { allowProcessing?: boolean } = {}
) {
    return (
        !asset.deepZoom ||
        (Boolean(asset.previewUrl) &&
            (asset.deepZoom.status === 'ready' || (allowProcessing && isAssetProcessing(asset))))
    );
}

export function assetProcessingLabel(asset: AssetLibraryAsset) {
    switch (asset.deepZoom?.status) {
        case 'queued':
            return 'Queued';
        case 'processing':
            return 'Processing';
        case 'failed':
            return 'Processing failed';
        case 'ready':
            return asset.previewUrl ? undefined : 'Preview unavailable';
        default:
            return undefined;
    }
}

/** Deep Zoom previews never fall back to fetching the potentially huge source. */
export function assetPreviewFilename(asset: AssetLibraryAsset) {
    return asset.deepZoom ? asset.previewUrl : asset.url;
}

/** Hero images are bounded raster previews; image layers retain the original asset reference. */
export function assetPickerFilename(asset: AssetLibraryAsset) {
    return asset.deepZoom ? (asset.previewUrl ?? asset.url) : asset.url;
}

export type MediaDimensions = { width: number; height: number; duration: number };

/** Read bounded headers before asking the browser to decode an upload preview.
 * Unknown formats, giant rasters and long JPEG metadata use the server preview.
 */
export async function canPreviewImageLocally(file: Blob): Promise<boolean> {
    if (file.size > 32 * 1024 * 1024) return false;
    const bytes = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
    const view = new DataView(bytes.buffer);
    let width = 0,
        height = 0;
    if (
        bytes.length >= 24 &&
        view.getUint32(0) === 0x89504e47 &&
        view.getUint32(4) === 0x0d0a1a0a
    ) {
        width = view.getUint32(16);
        height = view.getUint32(20);
    } else if (bytes.length >= 4 && view.getUint16(0) === 0xffd8) {
        for (let offset = 2; offset + 4 <= bytes.length;) {
            if (bytes[offset++] !== 0xff) break;
            while (bytes[offset] === 0xff) offset++;
            const marker = bytes[offset++];
            if (
                marker === undefined ||
                marker === 0xda ||
                marker === 0xd9 ||
                offset + 2 > bytes.length
            )
                break;
            const size = view.getUint16(offset);
            if (size < 2 || offset + size > bytes.length) break;
            if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) {
                height = view.getUint16(offset + 3);
                width = view.getUint16(offset + 5);
                break;
            }
            offset += size;
        }
    } else if (
        bytes.length >= 30 &&
        view.getUint32(0) === 0x52494646 &&
        view.getUint32(8) === 0x57454250
    ) {
        const format = view.getUint32(12);
        if (format === 0x56503858) {
            // VP8X
            width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
            height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
        } else if (format === 0x56503820) {
            // VP8
            width = view.getUint16(26, true) & 0x3fff;
            height = view.getUint16(28, true) & 0x3fff;
        } else if (format === 0x5650384c && bytes[20] === 0x2f) {
            // VP8L
            const dimensions = view.getUint32(21, true);
            width = (dimensions & 0x3fff) + 1;
            height = ((dimensions >>> 14) & 0x3fff) + 1;
        }
    }
    return (
        width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_000_000
    );
}

export async function prepareMediaAsset(
    asset: AssetLibraryAsset,
    readLegacyDimensions: (isVideo: boolean) => Promise<MediaDimensions>
) {
    // Validate readiness before allocating ids, loading source media or making a layer.
    const deepZoom = createImageDeepZoomLayerDescriptor(asset);
    if (deepZoom)
        return {
            isVideo: false,
            width: deepZoom.width,
            height: deepZoom.height,
            duration: 0,
            deepZoom
        };
    const isVideo =
        asset.mimeType?.startsWith('video/') ||
        /\.(mp4|mov|webm|avi|mkv)$/i.test(asset.name) ||
        /\.(mp4|mov|webm|avi|mkv)$/i.test(asset.url);
    return { isVideo, ...(await readLegacyDimensions(isVideo)), deepZoom: undefined };
}

/**
 * Build the immutable resource snapshot when placing a ready asset. The caller
 * keeps the layer's existing url/config; job updates must never upsert a layer.
 * previewUrl uses the same asset filename convention as AssetDocument.
 */
export function createImageDeepZoomLayerDescriptor(asset: {
    id: string;
    previewUrl?: string | null;
    deepZoom?: ImageDeepZoomAsset;
}): ImageDeepZoomLayer | undefined {
    const image = asset.deepZoom;
    if (!image) return undefined;
    if (image.status !== 'ready') throw new Error('Deep Zoom image is not ready for placement.');
    return ImageDeepZoomLayer.parse({
        schemaVersion: image.schemaVersion,
        assetId: asset.id,
        width: image.width,
        height: image.height,
        previewUrl: asset.previewUrl,
        tiles: image.tiles
    });
}

/** An older client's geometry update must not strip an existing resource snapshot. */
export function preserveImageDeepZoom<T extends Layer>(previous: Layer | undefined, next: T): T {
    if (
        previous?.type === 'image' &&
        previous.deepZoom &&
        next.type === 'image' &&
        !next.deepZoom &&
        previous.numericId === next.numericId &&
        previous.url === next.url
    )
        return { ...next, deepZoom: structuredClone(previous.deepZoom) };
    return next;
}

export function imageTileUrl(image: ImageDeepZoomLayer, z: number, x: number, y: number) {
    return `/api/image-tiles/${encodeURIComponent(image.assetId)}/${encodeURIComponent(image.tiles.sourceId)}/${z}/${x}/${y}`;
}

export function imagePreviewUrl(image: ImageDeepZoomLayer) {
    return `/api/assets/${encodeURIComponent(image.previewUrl)}`;
}

export function parseImageTilePath(path: string) {
    const match =
        /^([a-f\d]{24})\/([a-zA-Z\d][a-zA-Z\d_-]{0,79})\/(0|[1-9]\d?)\/(0|[1-9]\d{0,9})\/(0|[1-9]\d{0,9})$/.exec(
            path
        );
    if (!match) return null;
    return {
        assetId: match[1],
        sourceId: match[2],
        z: Number(match[3]),
        x: Number(match[4]),
        y: Number(match[5])
    };
}

export function isImageTileInBounds(
    image: ImageDeepZoomAsset,
    tile: { sourceId: string; z: number; x: number; y: number }
) {
    if (image.status !== 'ready' || image.tiles.sourceId !== tile.sourceId) return false;
    const maxZoom = image.tiles.maxZoom;
    if (!Number.isSafeInteger(maxZoom) || maxZoom < 0 || maxZoom > 30 || tile.z > maxZoom)
        return false;
    if (![image.width, image.height].every((n) => Number.isSafeInteger(n) && n > 0)) return false;
    if (![tile.z, tile.x, tile.y].every((n) => Number.isSafeInteger(n) && n >= 0)) return false;
    const span = image.tiles.tileSize * 2 ** (maxZoom - tile.z);
    return tile.x < Math.ceil(image.width / span) && tile.y < Math.ceil(image.height / span);
}
