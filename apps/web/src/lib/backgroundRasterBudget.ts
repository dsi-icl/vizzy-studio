/**
 * Background previews are disposable raster caches for a logical stage. Their
 * dimensions must preserve the stage aspect ratio without allowing an unusual
 * wall shape to allocate an unbounded canvas.
 */
export const BACKGROUND_PREVIEW_MIN_LONG_EDGE = 1_536;
export const BACKGROUND_PREVIEW_MAX_EDGE = 4_096;
export const BACKGROUND_PREVIEW_MAX_PIXELS = 4_096 * 2_048;
const BACKGROUND_PREVIEW_BUCKET = 128;

export type BackgroundRasterSize = {
    width: number;
    height: number;
};

export function resolveBackgroundRasterSize(
    logicalWidth: number,
    logicalHeight: number,
    previewScale: number,
    devicePixelRatio: number
): BackgroundRasterSize {
    const safeWidth = Math.max(1, logicalWidth);
    const safeHeight = Math.max(1, logicalHeight);
    const longEdge = Math.max(safeWidth, safeHeight);
    const requestedLongEdge = Math.max(
        BACKGROUND_PREVIEW_MIN_LONG_EDGE,
        longEdge * Math.max(previewScale, 0.001) * Math.max(devicePixelRatio, 1)
    );
    const dimensionScale = BACKGROUND_PREVIEW_MAX_EDGE / longEdge;
    const pixelScale = Math.sqrt(BACKGROUND_PREVIEW_MAX_PIXELS / (safeWidth * safeHeight));
    const maxScale = Math.min(dimensionScale, pixelScale);
    const requestedScale = requestedLongEdge / longEdge;
    const scale = Math.min(requestedScale, maxScale);

    let width = Math.max(1, Math.round(safeWidth * scale));
    let height = Math.max(1, Math.round(safeHeight * scale));

    // Bucket the long edge to avoid regenerating the raster for tiny zoom
    // changes, then re-apply the aspect ratio and hard budgets.
    if (width >= height) {
        width = Math.min(
            BACKGROUND_PREVIEW_MAX_EDGE,
            Math.ceil(width / BACKGROUND_PREVIEW_BUCKET) * BACKGROUND_PREVIEW_BUCKET
        );
        height = Math.max(1, Math.round((width * safeHeight) / safeWidth));
    } else {
        height = Math.min(
            BACKGROUND_PREVIEW_MAX_EDGE,
            Math.ceil(height / BACKGROUND_PREVIEW_BUCKET) * BACKGROUND_PREVIEW_BUCKET
        );
        width = Math.max(1, Math.round((height * safeWidth) / safeHeight));
    }

    if (
        width > BACKGROUND_PREVIEW_MAX_EDGE ||
        height > BACKGROUND_PREVIEW_MAX_EDGE ||
        width * height > BACKGROUND_PREVIEW_MAX_PIXELS
    ) {
        const correction = Math.min(
            BACKGROUND_PREVIEW_MAX_EDGE / width,
            BACKGROUND_PREVIEW_MAX_EDGE / height,
            Math.sqrt(BACKGROUND_PREVIEW_MAX_PIXELS / (width * height))
        );
        width = Math.max(1, Math.floor(width * correction));
        height = Math.max(1, Math.floor(height * correction));
    }

    return { width, height };
}
