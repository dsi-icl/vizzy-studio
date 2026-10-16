import { OrthographicViewport } from '@deck.gl/core';
import { _Tileset2D as Tileset2D } from '@deck.gl/geo-layers';
import { Matrix4 } from '@math.gl/core';
import type { ImageDeepZoomLayer } from '@repo/db/schema';

import { imagePreviewUrl, imageTileUrl } from './mediaUtils';

export const MAX_TILE_ATLAS_SIDE = 8192;
export const MAX_TILE_ATLAS_PIXELS = 16 * 1024 * 1024;
export type ImageTileIndex = { x: number; y: number; z: number };

export function tileGridBounds(indices: readonly ImageTileIndex[], tileSize: number) {
    if (!indices.length) return null;
    let x = Infinity,
        y = Infinity,
        right = -Infinity,
        bottom = -Infinity;
    for (const index of indices) {
        x = Math.min(x, index.x);
        y = Math.min(y, index.y);
        right = Math.max(right, index.x + 1);
        bottom = Math.max(bottom, index.y + 1);
    }
    return {
        x,
        y,
        width: (right - x) * tileSize,
        height: (bottom - y) * tileSize,
        unitsPerPixel: 2 ** -indices[0].z
    };
}

// Reuse deck.gl's scheduler/cache. Only visible tiles enter a bounded 2D canvas;
// no WebGL context or original-image-sized canvas is needed by a screen.
export class ImageTileset extends Tileset2D {
    private imageWidth: number;
    private imageHeight: number;
    private imageTileSize: number;
    constructor(
        options: ConstructorParameters<typeof Tileset2D>[0] & { width: number; height: number }
    ) {
        super(options);
        this.imageWidth = options.width;
        this.imageHeight = options.height;
        this.imageTileSize = options.tileSize ?? 512;
    }
    override getTileIndices(options: Parameters<Tileset2D['getTileIndices']>[0]) {
        let next = options;
        for (;;) {
            const indices = super.getTileIndices(next).filter(({ x, y, z }) => {
                const span = this.imageTileSize * 2 ** -z;
                // Rotating the extent can select cells outside the original image.
                return (
                    x >= 0 &&
                    y >= 0 &&
                    x < Math.ceil(this.imageWidth / span) &&
                    y < Math.ceil(this.imageHeight / span)
                );
            });
            const bounds = tileGridBounds(indices, this.imageTileSize);
            if (
                !bounds ||
                (bounds.width <= MAX_TILE_ATLAS_SIDE &&
                    bounds.height <= MAX_TILE_ATLAS_SIDE &&
                    bounds.width * bounds.height <= MAX_TILE_ATLAS_PIXELS)
            )
                return indices;
            // Extreme independent width/height stretching can expose a long strip.
            // Select a coarser existing level before requesting or allocating it.
            const maxZoom = indices[0].z - 1;
            if (maxZoom < (options.minZoom ?? -Infinity)) return [];
            next = { ...options, maxZoom };
        }
    }
}
/** Source pixels to viewport CSS pixels, including rotation, mirroring and independent scales. */
export type ImageAffine = readonly [number, number, number, number, number, number];
export type ImageTileView = {
    matrix: ImageAffine;
    viewport: { x: number; y: number; width: number; height: number };
    pixelRatio: number;
};
export function imageTileTransform([a, b, c, d, e, f]: ImageAffine) {
    return {
        matrix: new Matrix4([a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, e, f, 0, 1]),
        zoomOffset: Math.ceil(Math.log2(Math.max(Math.hypot(a, b), Math.hypot(c, d))))
    };
}

/** Clip to scroll slots as well as the window: a Vizzy stage can span many screens. */
export function clippedViewport(element: Element) {
    let left = 0,
        top = 0,
        right = window.innerWidth,
        bottom = window.innerHeight;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const clipX = /auto|scroll|hidden|clip/.test(style.overflowX);
        const clipY = /auto|scroll|hidden|clip/.test(style.overflowY);
        if (!clipX && !clipY) continue;
        const box = parent.getBoundingClientRect();
        const sx = parent.offsetWidth ? box.width / parent.offsetWidth : 1;
        const sy = parent.offsetHeight ? box.height / parent.offsetHeight : 1;
        if (clipX) {
            left = Math.max(left, box.left + parent.clientLeft * sx);
            right = Math.min(right, box.left + (parent.clientLeft + parent.clientWidth) * sx);
        }
        if (clipY) {
            top = Math.max(top, box.top + parent.clientTop * sy);
            bottom = Math.min(bottom, box.top + (parent.clientTop + parent.clientHeight) * sy);
        }
    }
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

// One browser frame observer for all adapters. Read every live transform before
// resizing/painting canvases. This also follows wall animation and Konva's binary
// fast path, neither of which necessarily updates React props.
const observers = new Set<{
    read: () => ImageTileView | null;
    update: (view: ImageTileView | null) => void;
}>();
let frame = 0;
function tick() {
    const snapshots = Array.from(observers, (observer) => ({ observer, view: observer.read() }));
    for (const { observer, view } of snapshots) if (observers.has(observer)) observer.update(view);
    frame = observers.size ? requestAnimationFrame(tick) : 0;
}
export function observeImageTileView(
    read: () => ImageTileView | null,
    update: (view: ImageTileView | null) => void
) {
    const observer = { read, update };
    observers.add(observer);
    if (!frame) frame = requestAnimationFrame(tick);
    return () => {
        observers.delete(observer);
        if (!observers.size) {
            cancelAnimationFrame(frame);
            frame = 0;
        }
    };
}

/** Bound HTTP/decode work across all Deep Zoom layers in this browser. */
export function createImageRequestBudget(limit: number) {
    let active = 0;
    const waiting = new Set<() => void>();
    return async function run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
            const abort = () => {
                waiting.delete(start);
                reject(signal.reason);
            };
            const start = () => {
                if (active >= limit) return;
                waiting.delete(start);
                signal.removeEventListener('abort', abort);
                active++;
                resolve();
            };
            waiting.add(start);
            signal.addEventListener('abort', abort, { once: true });
            start();
        });
        try {
            signal.throwIfAborted();
            return await task();
        } finally {
            active--;
            for (const next of waiting) next();
        }
    };
}
export const withImageRequestBudget = createImageRequestBudget(8);

type TileData = { url: string; image: HTMLImageElement; byteLength: number };
type TileBitmap = { id: string; index: ImageTileIndex; image: HTMLImageElement };
export type ImageTileFrame = {
    canvas: HTMLCanvasElement;
    x: number;
    y: number;
    width: number;
    height: number;
    ready: boolean;
};

/** Shared scheduler/compositor for Konva and DOM, adapted from do-image. No WebGL context. */
export class ImageTileController {
    private readonly tileset: ImageTileset;
    private readonly tileLoader: ConstructorParameters<typeof ImageTileset>[0]['getTileData'] = ({
        index,
        signal
    }) =>
        this.load(
            imageTileUrl(this.source, index.z + this.source.tiles.maxZoom, index.x, index.y),
            signal
        );
    private readonly lifetime = new AbortController();
    private readonly urls = new Set<string>();
    private preview: HTMLImageElement | null = null;
    private retained: TileBitmap[] = [];
    private bounds: ReturnType<typeof tileGridBounds> = null;
    private view: ImageTileView | null = null;
    private viewKey = '';
    private paintKey = '';
    private previewRevision = 0;
    private retry?: ReturnType<typeof setTimeout>;
    private previewRetry?: ReturnType<typeof setTimeout>;
    private retryDelay = 2000;
    public frame: ImageTileFrame | null = null;

    constructor(
        readonly source: ImageDeepZoomLayer,
        readonly canvas: HTMLCanvasElement,
        private readonly changed: (frame: ImageTileFrame | null) => void,
        private readonly previewSettled: () => void = () => {}
    ) {
        this.tileset = new ImageTileset({
            width: source.width,
            height: source.height,
            extent: [0, 0, source.width, source.height],
            tileSize: source.tiles.tileSize,
            minZoom: -source.tiles.maxZoom,
            maxZoom: 0,
            maxCacheSize: 64,
            maxCacheByteSize: 16 * 1024 * 1024,
            maxRequests: 6,
            refinementStrategy: 'no-overlap',
            getTileData: this.tileLoader,
            onTileLoad: () => {
                this.retryDelay = 2000;
                this.refresh();
            },
            onTileUnload: (tile) => {
                const data = tile.content as TileData | null;
                if (data) {
                    URL.revokeObjectURL(data.url);
                    this.urls.delete(data.url);
                }
            },
            onTileError: () => {
                if (this.lifetime.signal.aborted || this.retry) return;
                this.retry = setTimeout(() => {
                    this.retry = undefined;
                    for (const tile of this.tileset.tiles)
                        if (!tile.content && !tile.isLoading) tile.setNeedsReload();
                    this.refresh();
                }, this.retryDelay);
                this.retryDelay = Math.min(30_000, this.retryDelay * 2);
            }
        });
        canvas.width = canvas.height = 1;
        void this.loadPreview();
    }

    private async load(url: string, requestSignal?: AbortSignal): Promise<TileData> {
        const signal = AbortSignal.any([
            this.lifetime.signal,
            AbortSignal.timeout(15_000),
            ...(requestSignal ? [requestSignal] : [])
        ]);
        return withImageRequestBudget(signal, async () => {
            const response = await fetch(url, { signal, credentials: 'same-origin' });
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error('Image temporarily unavailable');
            }
            const objectUrl = URL.createObjectURL(await response.blob());
            this.urls.add(objectUrl);
            try {
                const image = new Image();
                image.src = objectUrl;
                await image.decode();
                signal.throwIfAborted();
                return { image, url: objectUrl, byteLength: image.width * image.height * 4 };
            } catch (error) {
                URL.revokeObjectURL(objectUrl);
                this.urls.delete(objectUrl);
                throw error;
            }
        });
    }

    private async loadPreview() {
        try {
            const data = await this.load(imagePreviewUrl(this.source));
            this.preview = data.image;
            URL.revokeObjectURL(data.url);
            this.urls.delete(data.url);
            this.previewRevision++;
            this.refresh();
        } catch {
            if (!this.lifetime.signal.aborted)
                this.previewRetry = setTimeout(() => void this.loadPreview(), 3000);
        } finally {
            if (!this.lifetime.signal.aborted) this.previewSettled();
        }
    }

    update(view: ImageTileView | null) {
        const valid =
            view &&
            [
                ...view.matrix,
                view.viewport.x,
                view.viewport.y,
                view.viewport.width,
                view.viewport.height,
                view.pixelRatio
            ].every(Number.isFinite) &&
            view.viewport.width > 0 &&
            view.viewport.height > 0 &&
            view.pixelRatio > 0 &&
            Math.abs(view.matrix[0] * view.matrix[3] - view.matrix[1] * view.matrix[2]) > 1e-12;
        const next = valid ? view : null;
        const key = next ? JSON.stringify(next) : '';
        if (key === this.viewKey) return;
        this.view = next;
        this.viewKey = key;
        this.refresh();
    }

    private refresh() {
        if (this.lifetime.signal.aborted) return;
        const view = this.view;
        if (!view) {
            for (const tile of this.tileset.tiles) if (tile.isLoading) tile.abort();
            if (this.frame) {
                this.frame = null;
                this.canvas.width = this.canvas.height = 1;
                this.paintKey = '';
                this.changed(null);
            }
            return;
        }
        const transform = imageTileTransform(view.matrix);
        this.tileset.setOptions({ getTileData: this.tileLoader, zoomOffset: transform.zoomOffset });
        const viewport = view.viewport;
        // A small viewport margin covers filtering and the next frame of movement.
        const margin = 32;
        this.tileset.update(
            new OrthographicViewport({
                width: (viewport.width + margin * 2) * view.pixelRatio,
                height: (viewport.height + margin * 2) * view.pixelRatio,
                target: [viewport.x + viewport.width / 2, viewport.y + viewport.height / 2, 0],
                zoom: Math.log2(view.pixelRatio),
                flipY: true
            }),
            { zRange: null, modelMatrix: transform.matrix }
        );
        const selected = this.tileset.selectedTiles ?? [];
        this.bounds = tileGridBounds(
            selected.map((tile) => tile.index),
            this.source.tiles.tileSize
        );
        const ready = selected.length > 0 && selected.every((tile) => Boolean(tile.content));
        if (ready)
            this.retained = selected.map((tile) => ({
                id: tile.id,
                index: tile.index,
                image: (tile.content as TileData).image
            }));
        const bounds = this.bounds;
        const key = JSON.stringify([
            bounds,
            this.retained.map((tile) => tile.id),
            this.previewRevision,
            ready
        ]);
        if (key === this.paintKey) return;
        this.paintKey = key;
        if (!bounds) {
            this.frame = null;
            this.canvas.width = this.canvas.height = 1;
            this.changed(null);
            return;
        }
        const { canvas } = this;
        canvas.width = bounds.width;
        canvas.height = bounds.height;
        const context = canvas.getContext('2d')!;
        const tileSize = this.source.tiles.tileSize;
        if (this.preview)
            context.drawImage(
                this.preview,
                -bounds.x * tileSize,
                -bounds.y * tileSize,
                this.source.width / bounds.unitsPerPixel,
                this.source.height / bounds.unitsPerPixel
            );
        // Replace preview pixels (including alpha) with the last complete tile
        // grid on this ONE surface. Stacked preview/detail elements create seams.
        const retainedBounds = tileGridBounds(
            this.retained.map((tile) => tile.index),
            tileSize
        );
        if (retainedBounds) {
            const ratio = retainedBounds.unitsPerPixel / bounds.unitsPerPixel;
            const span = tileSize * ratio;
            if (span >= 1) {
                context.clearRect(
                    (retainedBounds.x * ratio - bounds.x) * tileSize,
                    (retainedBounds.y * ratio - bounds.y) * tileSize,
                    retainedBounds.width * ratio,
                    retainedBounds.height * ratio
                );
                context.imageSmoothingEnabled = ratio !== 1;
                for (const tile of this.retained)
                    context.drawImage(
                        tile.image,
                        (tile.index.x * ratio - bounds.x) * tileSize,
                        (tile.index.y * ratio - bounds.y) * tileSize,
                        span,
                        span
                    );
            }
        }
        this.frame = {
            canvas,
            x: bounds.x * tileSize * bounds.unitsPerPixel,
            y: bounds.y * tileSize * bounds.unitsPerPixel,
            width: bounds.width * bounds.unitsPerPixel,
            height: bounds.height * bounds.unitsPerPixel,
            ready
        };
        this.changed(this.frame);
    }

    dispose() {
        this.lifetime.abort();
        clearTimeout(this.retry);
        clearTimeout(this.previewRetry);
        this.tileset.finalize();
        for (const url of this.urls) URL.revokeObjectURL(url);
        this.urls.clear();
        this.retained = [];
        this.preview = null;
        this.frame = null;
        this.canvas.width = this.canvas.height = 1;
    }
}
