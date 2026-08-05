export const TEXT_BASE_FONT_SIZE_PX = 100;
export const TEXT_BASE_LINE_HEIGHT = 1.3;
export const TEXT_BASE_PADDING_PX = 16;
export const TEXT_BASE_FONT_FAMILY = 'sans-serif';

/** A compact, single-line starting size for newly inserted text layers. */
export const TEXT_DEFAULT_LAYER_WIDTH_PX = 640;
export const TEXT_DEFAULT_LAYER_HEIGHT_PX = Math.ceil(
    TEXT_BASE_FONT_SIZE_PX * TEXT_BASE_LINE_HEIGHT + TEXT_BASE_PADDING_PX * 2
);

export const TEXT_BASE_STYLE = {
    color: 'white',
    fontFamily: TEXT_BASE_FONT_FAMILY,
    fontSize: `${TEXT_BASE_FONT_SIZE_PX}px`,
    lineHeight: String(TEXT_BASE_LINE_HEIGHT),
    padding: `${TEXT_BASE_PADDING_PX}px`,
    boxSizing: 'border-box' as const
};

/**
 * Canonical text scale for physical-size calculations.
 * We intentionally use Y scale to match vertical glyph sizing on wall/editor.
 * Alternative considered: sqrt(scaleX * scaleY) for isotropic averaging.
 */
export function getCanonicalTextScale(scaleX: number, scaleY: number): number {
    void scaleX;
    return Math.max(0.01, Number.isFinite(scaleY) ? scaleY : 1);
}

export function virtualPxToEm(virtualPx: number, scaleX: number, scaleY: number): number {
    const scale = getCanonicalTextScale(scaleX, scaleY);
    return virtualPx / (TEXT_BASE_FONT_SIZE_PX * scale);
}

export function emToVirtualPx(em: number, scaleX: number, scaleY: number): number {
    const scale = getCanonicalTextScale(scaleX, scaleY);
    return em * TEXT_BASE_FONT_SIZE_PX * scale;
}
