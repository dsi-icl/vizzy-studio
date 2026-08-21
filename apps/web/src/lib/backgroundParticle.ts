import { DEFAULT_STAGE_LAYOUT, stageLayoutKey, type StageLayout } from '@repo/db/schema';
import { createNoise2D } from 'simplex-noise';

import type { BackgroundNoiseLayer } from '~/lib/backgroundNoise';

const PARTICLES_PER_PANEL = 84;
const MAX_PARTICLE_COUNT = 12_000;
const MAX_DIST = 280;
const LINE_THICKNESS = 2.6;
const NODE_SIZE = 4.4;
const NOISE_SCL = 0.0001;
const NOISE_TIME_SHIFT = 24_000;
const MOTION_TIME_SCALE = 4_600;
const VERTICAL_DENSITY_BOOST = 0.4;
const CLOUD_OPACITY = 0.5;
// Floors so a heavily downscaled preview keeps the graph legible — features
// this small would otherwise land under one device pixel and vanish.
const MIN_LINE_PX = 0.75;
const MIN_NODE_RADIUS_PX = 0.6;
// Cloud sample budget, held constant while the raster tracks the world span's
// aspect ratio. Resolves to exactly 240x135 for a single 16:9 panel.
const NOISE_SAMPLE_BUDGET = 240 * 135;

type ParticleState = {
    id: number;
    x0: number;
    y0: number;
    vx: number;
    vy: number;
    lx: number;
    ly: number;
    worldX: number;
    worldY: number;
    isVisible: boolean;
    isAlive: boolean;
};

type ParticleRuntime = {
    seed: number;
    layoutKey: string;
    noiseCanvas: HTMLCanvasElement;
    noiseCtx: CanvasRenderingContext2D;
    particles: ParticleState[];
    noiseA: ReturnType<typeof createNoise2D>;
    noiseB: ReturnType<typeof createNoise2D>;
    noiseC: ReturnType<typeof createNoise2D>;
};

const RUNTIME_BY_CANVAS = new WeakMap<HTMLCanvasElement, ParticleRuntime>();

function seededRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
}

function hexToRgba(hex: string): [number, number, number, number] {
    const clean = hex.replace(/^#/, '').padEnd(8, 'f');
    return [
        parseInt(clean.slice(0, 2), 16),
        parseInt(clean.slice(2, 4), 16),
        parseInt(clean.slice(4, 6), 16),
        parseInt(clean.slice(6, 8), 16)
    ];
}

function toCssRgba(c: [number, number, number, number], alphaMul = 1): string {
    return `rgba(${Math.round(c[0])} ${Math.round(c[1])} ${Math.round(c[2])} / ${clamp01((c[3] / 255) * alphaMul)})`;
}

function ensureRuntime(
    canvas: HTMLCanvasElement,
    layer: BackgroundNoiseLayer,
    layout: StageLayout
): ParticleRuntime {
    const existing = RUNTIME_BY_CANVAS.get(canvas);
    const resolvedLayoutKey = stageLayoutKey(layout);
    if (existing && existing.seed === layer.noiseSeed && existing.layoutKey === resolvedLayoutKey) {
        return existing;
    }

    const noiseCanvas = document.createElement('canvas');
    noiseCanvas.width = 240;
    noiseCanvas.height = 135;
    const noiseCtx = noiseCanvas.getContext('2d');
    if (!noiseCtx) throw new Error('Failed to create 2D context for particle noise canvas');

    const rngParticles = seededRandom(layer.noiseSeed || 1);
    const worldW = layout.columns * layout.screenWidth;
    const worldH = layout.rows * layout.screenHeight;
    const particleCount = Math.min(
        MAX_PARTICLE_COUNT,
        Math.max(PARTICLES_PER_PANEL, layout.columns * layout.rows * PARTICLES_PER_PANEL)
    );
    const particles: ParticleState[] = Array.from({ length: particleCount }, (_, id) => ({
        id,
        x0: rngParticles() * worldW,
        y0: rngParticles() * worldH,
        vx: (rngParticles() - 0.5) * 1.5,
        vy: (rngParticles() - 0.5) * 1.5,
        lx: 0,
        ly: 0,
        worldX: 0,
        worldY: 0,
        isVisible: false,
        isAlive: true
    }));

    const noiseA = createNoise2D(seededRandom(layer.noiseSeed + 101));
    const noiseB = createNoise2D(seededRandom(layer.noiseSeed + 202));
    const noiseC = createNoise2D(seededRandom(layer.noiseSeed + 303));

    const runtime: ParticleRuntime = {
        seed: layer.noiseSeed,
        layoutKey: resolvedLayoutKey,
        noiseCanvas,
        noiseCtx,
        particles,
        noiseA,
        noiseB,
        noiseC
    };
    RUNTIME_BY_CANVAS.set(canvas, runtime);
    return runtime;
}

export function renderBackgroundParticle(
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

    const runtime = ensureRuntime(canvas, layer, layout);
    const { noiseCanvas, noiseCtx, particles, noiseA, noiseB, noiseC } = runtime;

    const w = canvas.width;
    const h = canvas.height;
    const worldW = layout.columns * layout.screenWidth;
    const worldH = layout.rows * layout.screenHeight;
    const worldStartX = col * layout.screenWidth;
    const worldStartY = row * layout.screenHeight;
    const worldSpanX = Math.max(1e-6, colSpan) * layout.screenWidth;
    const worldSpanY = Math.max(1e-6, rowSpan) * layout.screenHeight;
    const centerX = worldW / 2;
    const valleyWidth = worldW * 0.46;
    const motionT = t * MOTION_TIME_SCALE;
    const timeShift = t * NOISE_TIME_SHIFT;

    // Particle positions, link distances and node sizes are all authored in
    // world pixels. The wall path draws one panel at native resolution so this
    // is exactly 1; the preview rasters the whole wall into a smaller,
    // aspect-preserving canvas and needs the conversion.
    const pxScale = w / worldSpanX;
    const maxDistPx = MAX_DIST * pxScale;

    const bg = hexToRgba(layer.backgroundColor);
    const atm = hexToRgba(layer.atmosphereColor);
    const motif1 = hexToRgba(layer.motifColor1);
    const motif2 = hexToRgba(layer.motifColor2);

    // Track the world span's aspect so cloud samples stay square. A fixed
    // raster would smear the full-wall preview horizontally (its span is 7.1:1,
    // not 16:9). Same budget either way, so cost is unchanged.
    const noiseW = Math.max(
        1,
        Math.round(Math.sqrt(NOISE_SAMPLE_BUDGET * (worldSpanX / worldSpanY)))
    );
    const noiseH = Math.max(1, Math.round(NOISE_SAMPLE_BUDGET / noiseW));
    if (noiseCanvas.width !== noiseW) noiseCanvas.width = noiseW;
    if (noiseCanvas.height !== noiseH) noiseCanvas.height = noiseH;

    const noiseImage = noiseCtx.createImageData(noiseCanvas.width, noiseCanvas.height);
    const noiseData = noiseImage.data;
    for (let py = 0; py < noiseCanvas.height; py++) {
        for (let px = 0; px < noiseCanvas.width; px++) {
            const wx = worldStartX + (px / noiseCanvas.width) * worldSpanX;
            const wy = worldStartY + (py / noiseCanvas.height) * worldSpanY;
            const vA = Math.pow(
                (noiseA(wx * NOISE_SCL, (wy + timeShift) * NOISE_SCL) + 1) / 2,
                2.5
            );
            const vB = Math.pow(
                (noiseB(wx * NOISE_SCL, (wy + timeShift) * NOISE_SCL) + 1) / 2,
                2.5
            );
            const vC = Math.pow(
                (noiseC(wx * NOISE_SCL, (wy + timeShift) * NOISE_SCL) + 1) / 2,
                2.5
            );
            const i = (py * noiseCanvas.width + px) * 4;
            noiseData[i] = vA * motif1[0] + vB * motif2[0] + vC * atm[0];
            noiseData[i + 1] = vA * motif1[1] + vB * motif2[1] + vC * atm[1];
            noiseData[i + 2] = vA * motif1[2] + vB * motif2[2] + vC * atm[2];
            noiseData[i + 3] = Math.max(vA, vB, vC) * 255 * CLOUD_OPACITY;
        }
    }
    noiseCtx.putImageData(noiseImage, 0, 0);

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = toCssRgba(bg);
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(noiseCanvas, 0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';

    const margin = maxDistPx;
    const gridCellSize = maxDistPx;
    const gridCols = Math.ceil(w / gridCellSize) + 2;
    const gridRows = Math.ceil(h / gridCellSize) + 2;
    const grid = Array.from({ length: gridCols * gridRows }, () => [] as number[]);

    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.worldX = (p.x0 + p.vx * motionT) % worldW;
        p.worldY = (p.y0 + p.vy * motionT) % worldH;
        if (p.worldX < 0) p.worldX += worldW;
        if (p.worldY < 0) p.worldY += worldH;

        const distFromCenterX = Math.abs(p.worldX - centerX);
        const horizontalProb = Math.min(1, Math.pow(distFromCenterX / valleyWidth, 2));
        const verticalProb = (p.worldY / worldH) * VERTICAL_DENSITY_BOOST;
        const finalLifeProb = Math.min(1, horizontalProb + verticalProb);
        p.isAlive = p.id / particles.length < finalLifeProb;
        if (!p.isAlive) {
            p.isVisible = false;
            continue;
        }

        p.lx = (p.worldX - worldStartX) * pxScale;
        p.ly = (p.worldY - worldStartY) * pxScale;
        p.isVisible = p.lx > -margin && p.lx < w + margin && p.ly > -margin && p.ly < h + margin;
        if (!p.isVisible) continue;

        const gx = Math.floor((p.lx + margin) / gridCellSize);
        const gy = Math.floor((p.ly + margin) / gridCellSize);
        if (gx >= 0 && gx < gridCols && gy >= 0 && gy < gridRows) {
            grid[gy * gridCols + gx].push(i);
        }
    }

    const lineR = Math.round(atm[0] * 0.45 + motif2[0] * 0.55);
    const lineG = Math.round(atm[1] * 0.45 + motif2[1] * 0.55);
    const lineB = Math.round(atm[2] * 0.45 + motif2[2] * 0.55);
    const distSqLimit = maxDistPx * maxDistPx;
    ctx.lineWidth = Math.max(MIN_LINE_PX, LINE_THICKNESS * pxScale);

    for (let gy = 0; gy < gridRows; gy++) {
        for (let gx = 0; gx < gridCols; gx++) {
            const idx = gy * gridCols + gx;
            const neighbors = [idx];
            if (gx + 1 < gridCols) neighbors.push(idx + 1);
            if (gy + 1 < gridRows) neighbors.push(idx + gridCols);
            if (gx + 1 < gridCols && gy + 1 < gridRows) neighbors.push(idx + gridCols + 1);

            for (const p1Idx of grid[idx]) {
                const p1 = particles[p1Idx];
                for (const nIdx of neighbors) {
                    for (const p2Idx of grid[nIdx]) {
                        if (p1Idx >= p2Idx) continue;
                        const p2 = particles[p2Idx];
                        const dx = p1.lx - p2.lx;
                        const dy = p1.ly - p2.ly;
                        const d2 = dx * dx + dy * dy;
                        if (d2 >= distSqLimit) continue;
                        const opacity = (1 - Math.sqrt(d2) / maxDistPx) * 0.25;
                        ctx.strokeStyle = `rgba(${lineR} ${lineG} ${lineB} / ${clamp01(opacity)})`;
                        ctx.beginPath();
                        ctx.moveTo(p1.lx, p1.ly);
                        ctx.lineTo(p2.lx, p2.ly);
                        ctx.stroke();
                    }
                }
            }
        }
    }

    const nodeRadius = Math.max(MIN_NODE_RADIUS_PX, NODE_SIZE * pxScale);

    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (!p.isVisible || p.lx <= 0 || p.lx >= w || p.ly <= 0 || p.ly >= h) continue;

        const vA = Math.pow(
            (noiseA(p.worldX * NOISE_SCL, (p.worldY + timeShift) * NOISE_SCL) + 1) / 2,
            2
        );
        const vB = Math.pow(
            (noiseB(p.worldX * NOISE_SCL, (p.worldY + timeShift) * NOISE_SCL) + 1) / 2,
            2
        );
        const vC = Math.pow(
            (noiseC(p.worldX * NOISE_SCL, (p.worldY + timeShift) * NOISE_SCL) + 1) / 2,
            2
        );
        const m = Math.max(vA, vB, vC);

        let nodeColor = motif1;
        if (m === vB) nodeColor = motif2;
        else if (m === vC) nodeColor = atm;
        if (m < 0.1) nodeColor = [bg[0] * 0.35, bg[1] * 0.35, bg[2] * 0.35, 255];

        ctx.fillStyle = toCssRgba(nodeColor as [number, number, number, number]);
        ctx.beginPath();
        ctx.arc(p.lx, p.ly, nodeRadius, 0, Math.PI * 2);
        ctx.fill();
    }
}
