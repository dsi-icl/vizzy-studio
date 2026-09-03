import { DEFAULT_STAGE_LAYOUT, type StageLayout } from '@repo/db/schema';
import { createNoise3D } from 'simplex-noise';

/** Advance per second in noise time — controls how slowly the pattern drifts. */
export const BACKGROUND_T_SPEED = 0.0015;

/** How often the canvas redraws (ms). Small enough to look smooth, large enough to be cheap. */
export const BACKGROUND_TICK_MS = 2_000;

type NoiseFrequency = {
    x: number;
    y: number;
    t: number;
    ox: number;
    oy: number;
};

export const ATMOSPHERE_FREQUENCY: NoiseFrequency = { x: 0.9, y: 0.6, t: 1, ox: 0, oy: 0 };
export const MOTIF_THICKNESS_FREQUENCY: NoiseFrequency = {
    x: 0.4,
    y: 0.4,
    t: 0.9,
    ox: 120,
    oy: 120
};
export const MOTIF_COLOR_FREQUENCY: NoiseFrequency = {
    x: 0.4,
    y: 0.4,
    t: 0.9,
    ox: 280,
    oy: 280
};

/** Motif thickness remap: values below this are fully invisible. */
export const MOTIF_INVISIBILITY_THRESHOLD = 0.1;
/** Maximum stroke thickness as a fraction of `cellMin`. */
export const MOTIF_MAX_THICKNESS_FACTOR = 0.2;
/** Minimum visible stroke width in pixels (below this, skip drawing). */
export const MOTIF_MIN_VISIBLE_STROKE_PX = 0.9;
/** Glyph scale range driven by thickness ramp. */
export const MOTIF_GLYPH_SCALE_MIN = 0.2;
export const MOTIF_GLYPH_SCALE_MAX = 0.7;
/** Absolute minimum glyph height in pixels once a glyph is visible. */
export const MOTIF_MIN_GLYPH_HEIGHT_PX = 2;

export interface BackgroundNoiseLayer {
    backgroundColor: string;
    atmosphereColor: string;
    motifColor1: string;
    motifColor2: string;
    noiseSeed: number;
    speedFactor: number;
}

/** Seeded PRNG (mulberry32) — used to seed simplex-noise deterministically. */
export function seededRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Parse a 6- or 8-digit hex colour string into [r, g, b, a] (0-255 each). */
function hexToRgba(hex: string): [number, number, number, number] {
    const clean = hex.replace(/^#/, '').padEnd(8, 'f');
    const rr = clean.slice(0, 2);
    const gg = clean.slice(2, 4);
    const bb = clean.slice(4, 6);
    const aa = clean.slice(6, 8);
    return [parseInt(rr, 16), parseInt(gg, 16), parseInt(bb, 16), parseInt(aa, 16)];
}

/** Smooth Hermite interpolation — softens blend edges. */
function smoothstep(t: number): number {
    const c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c);
}

/** Linear ramp that stays 0 until `threshold`, then progresses to 1 by x=1. */
function rampAfterThreshold(x: number, threshold = 0.3): number {
    if (x <= threshold) return 0;
    return (x - threshold) / Math.max(1e-6, 1 - threshold);
}

/** Smooth (Hermite) version of `rampAfterThreshold`. */
function smoothRampAfterThreshold(x: number, threshold = 0.3): number {
    return smoothstep(rampAfterThreshold(x, threshold));
}

/** Power-shaped ramp after threshold. exponent>1 delays growth, exponent<1 accelerates it. */
function powerRampAfterThreshold(x: number, threshold = 0.3, exponent = 2.2): number {
    const t = rampAfterThreshold(x, threshold);
    return Math.pow(t, exponent);
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function toCssRgba(c: [number, number, number, number]): string {
    return `rgba(${Math.round(c[0])} ${Math.round(c[1])} ${Math.round(c[2])} / ${Math.max(
        0,
        Math.min(1, c[3] / 255)
    )})`;
}

function pixelAligned(value: number, lineWidth: number): number {
    const rounded = Math.round(value);
    return lineWidth % 2 === 1 ? rounded + 0.5 : rounded;
}

/**
 * Renders a simplex-noise background frame onto `canvas`.
 *
 * `col` and `row` place this screen in the wall's noise coordinate space so
 * adjacent screens tile seamlessly.  All screens sharing the same `layer.noiseSeed`
 * use the same noise function — spatial coordinates alone drive continuity.
 *
 * `colSpan` and `rowSpan` control how many screens worth of noise space the
 * canvas covers.  Use 1/1 (default) for per-screen wall rendering.  Use
 * COLS/ROWS for the editor Konva preview so the full wall aspect ratio is shown.
 *
 * @param t  Slow-moving time axis value.  Advance by BACKGROUND_T_SPEED per second.
 */
export function renderBackgroundNoise(
    canvas: HTMLCanvasElement,
    layer: BackgroundNoiseLayer,
    col: number,
    row: number,
    t: number,
    colSpan = 1,
    rowSpan = 1,
    layout: StageLayout = DEFAULT_STAGE_LAYOUT
): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    // All screens share the same noise function — no col/row in the seed.
    // Spatial coords (nx, ny) place each pixel in wall space for seamless tiling.
    const noise3D = createNoise3D(seededRandom(layer.noiseSeed));

    const bg = hexToRgba(layer.backgroundColor);
    const atm = hexToRgba(layer.atmosphereColor);
    const m1 = hexToRgba(layer.motifColor1);
    const m2 = hexToRgba(layer.motifColor2);

    // Pre-normalise alphas to [0, 1] so they act as blend multipliers.
    const atmA = atm[3] / 255;

    const w = canvas.width;
    const h = canvas.height;
    const imageData = ctx.createImageData(w, h);
    const data = imageData.data;

    for (let y = 0; y < h; y++) {
        // Map to wall noise space: col=0,x=0 → nx=0; col=1,x=0 → nx=1; seamless at boundary.
        const ny = row + (y / h) * rowSpan;
        for (let x = 0; x < w; x++) {
            const nx = col + (x / w) * colSpan;

            // Layer 1: large-blob base wash (low spatial frequency = big smooth areas).
            // Atmosphere alpha scales how strongly it can wash over the background.
            const n1 =
                (noise3D(
                    nx * ATMOSPHERE_FREQUENCY.x + ATMOSPHERE_FREQUENCY.ox,
                    ny * ATMOSPHERE_FREQUENCY.y + ATMOSPHERE_FREQUENCY.oy,
                    t * ATMOSPHERE_FREQUENCY.t
                ) +
                    1) /
                2;
            const wash = smoothstep(n1) * atmA;
            const r0 = bg[0] + (atm[0] - bg[0]) * wash;
            const g0 = bg[1] + (atm[1] - bg[1]) * wash;
            const b0 = bg[2] + (atm[2] - bg[2]) * wash;

            const i = (y * w + x) * 4;
            data[i] = Math.round(r0);
            data[i + 1] = Math.round(g0);
            data[i + 2] = Math.round(b0);
            // Background colour alpha controls overall canvas opacity.
            data[i + 3] = bg[3];
        }
    }

    ctx.putImageData(imageData, 0, 0);

    // Single motif layer: draw "I" glyphs on a grid.
    // - Glyph stroke thickness is driven by simplex-noise at the same frequency as atmosphere.
    // - Glyph colour comes from a second simplex-noise sample interpolating motifColor1↔motifColor2.
    // Keep motif density tied to logical wall coordinates (screen pixels),
    // not the current raster resolution, so preview/wall match consistently.
    const logicalW = colSpan * layout.screenWidth;
    const logicalH = rowSpan * layout.screenHeight;
    const targetCellLogical = 72;
    const colsCount = Math.max(1, Math.round(logicalW / targetCellLogical));
    const rowsCount = Math.max(1, Math.round(logicalH / targetCellLogical));
    const cellW = w / colsCount;
    const cellH = h / rowsCount;
    const cellMin = Math.min(cellW, cellH);

    for (let gy = 0; gy < rowsCount; gy++) {
        const ny = row + ((gy + 0.5) / rowsCount) * rowSpan;
        const cy = (gy + 0.5) * cellH;

        for (let gx = 0; gx < colsCount; gx++) {
            const nx = col + ((gx + 0.5) / colsCount) * colSpan;
            const cx = (gx + 0.5) * cellW;

            // Same base frequency as atmosphere layer (0.9, 0.6), phase-offset.
            const widthNoise =
                (noise3D(
                    nx * MOTIF_THICKNESS_FREQUENCY.x + MOTIF_THICKNESS_FREQUENCY.ox,
                    ny * MOTIF_THICKNESS_FREQUENCY.y + MOTIF_THICKNESS_FREQUENCY.oy,
                    t * MOTIF_THICKNESS_FREQUENCY.t
                ) +
                    1) /
                2;
            const colorNoise =
                (noise3D(
                    nx * MOTIF_COLOR_FREQUENCY.x + MOTIF_COLOR_FREQUENCY.ox,
                    ny * MOTIF_COLOR_FREQUENCY.y + MOTIF_COLOR_FREQUENCY.oy,
                    t * MOTIF_COLOR_FREQUENCY.t
                ) +
                    1) /
                2;

            // Map noise to motif visibility from fully absent to thick.
            // Very low values skip drawing entirely (effectively invisible).
            const thicknessT = smoothRampAfterThreshold(widthNoise, MOTIF_INVISIBILITY_THRESHOLD);
            const strokePxRaw = lerp(0, cellMin * MOTIF_MAX_THICKNESS_FACTOR, thicknessT);
            if (strokePxRaw < MOTIF_MIN_VISIBLE_STROKE_PX) continue;
            const strokePx = Math.max(1, Math.round(strokePxRaw));
            const glyphScale = lerp(MOTIF_GLYPH_SCALE_MIN, MOTIF_GLYPH_SCALE_MAX, thicknessT);
            const glyphH = Math.max(MOTIF_MIN_GLYPH_HEIGHT_PX, cellH * 0.78 * glyphScale);
            const capW = Math.max(strokePx * 2, glyphH * 0.42);

            const mix = smoothstep(colorNoise);
            const motif: [number, number, number, number] = [
                lerp(m1[0], m2[0], mix),
                lerp(m1[1], m2[1], mix),
                lerp(m1[2], m2[2], mix),
                lerp(m1[3], m2[3], mix)
            ];
            const motifAlpha = motif[3] / 255;
            if (motifAlpha <= 0) continue;

            const xCenter = pixelAligned(cx, strokePx);
            const xLeft = pixelAligned(cx - capW / 2, strokePx);
            const xRight = pixelAligned(cx + capW / 2, strokePx);
            const yTop = pixelAligned(cy - glyphH / 2, strokePx);
            const yBottom = pixelAligned(cy + glyphH / 2, strokePx);

            ctx.beginPath();
            ctx.strokeStyle = toCssRgba(motif);
            ctx.lineWidth = strokePx;
            ctx.lineCap = 'butt';
            ctx.lineJoin = 'miter';

            // Top cap.
            ctx.moveTo(xLeft, yTop);
            ctx.lineTo(xRight, yTop);
            // Stem.
            ctx.moveTo(xCenter, yTop);
            ctx.lineTo(xCenter, yBottom);
            // Bottom cap.
            ctx.moveTo(xLeft, yBottom);
            ctx.lineTo(xRight, yBottom);

            ctx.stroke();
        }
    }
}
