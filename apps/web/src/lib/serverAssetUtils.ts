import { extname, join } from 'node:path';

import { env } from '@repo/env';
import { encode } from 'blurhash';
import sharp from 'sharp';

import { ASSET_DIR } from './serverVariables';
import { z } from './zod';

export type ImageUploadPolicy =
    | { enabled: false }
    | { enabled: true; tilePixels: number; tileEdge: number; maxPixels: number };

type ImageUploadSettings = {
    IMAGE_DEEP_ZOOM_UPLOADS_ENABLED?: string;
    IMAGE_DEEP_ZOOM_TILE_PIXELS?: string;
    IMAGE_DEEP_ZOOM_TILE_EDGE?: string;
    IMAGE_DEEP_ZOOM_MAX_PIXELS?: string;
};

const EnabledSettings = z.object({
    IMAGE_DEEP_ZOOM_TILE_PIXELS: z.coerce.number().int().positive().default(24_000_000),
    IMAGE_DEEP_ZOOM_TILE_EDGE: z.coerce.number().int().positive().default(8192),
    // Match do-image's default, with an optional deployment-specific override.
    IMAGE_DEEP_ZOOM_MAX_PIXELS: z.coerce.number().int().positive().default(16_000_000_000)
});

export function readImageUploadPolicy(settings: ImageUploadSettings): ImageUploadPolicy {
    const flag = (settings.IMAGE_DEEP_ZOOM_UPLOADS_ENABLED ?? 'false').trim().toLowerCase();
    if (['', '0', 'false', 'off', 'no'].includes(flag)) return { enabled: false };
    if (!['1', 'true', 'on', 'yes'].includes(flag)) {
        throw new Error('Invalid IMAGE_DEEP_ZOOM_UPLOADS_ENABLED.');
    }
    const values = EnabledSettings.parse({
        ...settings,
        // @repo/env exposes an unset value as an empty string.
        IMAGE_DEEP_ZOOM_MAX_PIXELS: settings.IMAGE_DEEP_ZOOM_MAX_PIXELS?.trim() || undefined
    });
    return {
        enabled: true,
        tilePixels: values.IMAGE_DEEP_ZOOM_TILE_PIXELS,
        tileEdge: values.IMAGE_DEEP_ZOOM_TILE_EDGE,
        maxPixels: values.IMAGE_DEEP_ZOOM_MAX_PIXELS
    };
}

// Structural subset of Sharp metadata, deliberately excluding client filename,
// MIME type and supplied dimensions. Call only for a newly completed upload.
export type ImageUploadMetadata = {
    format?: string;
    width?: number;
    height?: number;
    pageHeight?: number;
    orientation?: number;
    pages?: number;
};

export type ImageUploadPlan =
    | { kind: 'standard' }
    | { kind: 'deep-zoom'; width: number; height: number };

export function classifyNewImageUpload(
    metadata: ImageUploadMetadata,
    policy: ImageUploadPolicy
): ImageUploadPlan {
    if (!policy.enabled || metadata.format === 'svg') return { kind: 'standard' };

    let width = metadata.width;
    let height = metadata.pageHeight ?? metadata.height;
    if (
        typeof width !== 'number' ||
        typeof height !== 'number' ||
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width <= 0 ||
        height <= 0
    ) {
        throw new Error('Missing or invalid image dimensions.');
    }
    if (metadata.orientation && metadata.orientation >= 5 && metadata.orientation <= 8) {
        [width, height] = [height, width];
    }

    // Match do-image's strict thresholds. SVG keeps Vizzy's existing vector
    // handling; small animations keep their existing processing behaviour.
    const tiled =
        width * height > policy.tilePixels ||
        Math.max(width, height) > policy.tileEdge ||
        metadata.format === 'tiff';
    if (!tiled) return { kind: 'standard' };
    if ((metadata.pages ?? 1) > 1) {
        throw new Error(
            'Deep Zoom requires a single-frame image; animated or multipage input is unsupported.'
        );
    }
    if (width * height > policy.maxPixels) {
        throw new Error('Image exceeds IMAGE_DEEP_ZOOM_MAX_PIXELS.');
    }
    return { kind: 'deep-zoom', width, height };
}

const VARIANT_WIDTHS = [50, 200, 800, 1600, 2400, 3200];

/**
 * New-upload boundary, called by Tus only. Asset reads and existing image jobs
 * never reclassify or backfill historical images.
 * With the gate closed, even the additional metadata read is skipped.
 */
export async function inspectNewImageUpload(
    sourcePath: string,
    policy: ImageUploadPolicy = readImageUploadPolicy(env)
): Promise<ImageUploadPlan> {
    if (!policy.enabled) return { kind: 'standard' };
    const metadata = await sharp(sourcePath, { limitInputPixels: false }).metadata();
    return classifyNewImageUpload(metadata, policy);
}

/** Compute a blurhash from an image file on disk */
export async function computeBlurhash(imagePath: string): Promise<string | null> {
    try {
        const { data, info } = await sharp(imagePath)
            .rotate()
            .resize(32, 32, { fit: 'inside' })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        return encode(new Uint8ClampedArray(data), info.width, info.height, 4, 3);
    } catch (err) {
        console.error('[Asset] blurhash computation failed:', err);
        return null;
    }
}

/** Generate WebP variants at multiple sizes. Returns the list of widths actually generated. */
export async function generateVariants(sourcePath: string, baseId: string): Promise<number[]> {
    try {
        const meta = await sharp(sourcePath).rotate().metadata();
        const origWidth = meta.width ?? 0;
        if (origWidth === 0) return [];

        const sizes: number[] = [];

        // Generate downscaled variants (skip if original is already smaller)
        for (const width of VARIANT_WIDTHS) {
            if (origWidth <= width) continue;
            const outPath = join(ASSET_DIR, `${baseId}_${width}.webp`);
            await sharp(sourcePath)
                .rotate()
                .resize(width, undefined, { fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 80 })
                .toFile(outPath);
            sizes.push(width);
        }

        // Always generate a full-res WebP (unless source is already WebP)
        const srcExt = extname(sourcePath).toLowerCase();
        if (srcExt !== '.webp') {
            const outPath = join(ASSET_DIR, `${baseId}_${origWidth}.webp`);
            await sharp(sourcePath).rotate().webp({ quality: 85 }).toFile(outPath);
            sizes.push(origWidth);
        } else {
            // Source is already WebP — include original width in sizes for selection
            sizes.push(origWidth);
        }

        return sizes;
    } catch (err) {
        console.error('[Asset] variant generation failed:', err);
        return [];
    }
}

/** A 512px WebP must stay bounded even if the configured upstream misbehaves. */
const MAX_TILE_BYTES = 2 * 1024 * 1024;

export async function fetchImageTile(url: URL, signal: AbortSignal, fetcher: typeof fetch = fetch) {
    const upstream = await fetcher(url, { signal, redirect: 'manual' });
    if (
        !upstream.ok ||
        upstream.headers.get('content-type')?.split(';')[0].trim() !== 'image/webp' ||
        !upstream.body
    ) {
        await upstream.body?.cancel();
        throw new Error('Tile unavailable');
    }
    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_TILE_BYTES) throw new Error('Tile too large');
            chunks.push(value);
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    if (
        size < 12 ||
        new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RIFF' ||
        new TextDecoder().decode(bytes.subarray(8, 12)) !== 'WEBP'
    )
        throw new Error('Invalid tile');
    return bytes;
}
