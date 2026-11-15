import { ShapeEffectSettingsSchema, type ShapeEffect, type ShapeEffectSettings } from './types';

const EFFECT_DURATION_MS = {
    pulse: 2400,
    focus: 2600,
    ping: 2200,
    travel: 1800,
    reveal: 1800
} as const;
export const DEFAULT_SHAPE_EFFECT_SETTINGS: ShapeEffectSettings = ShapeEffectSettingsSchema.parse(
    {}
);

export function getShapeEffectSettings(settings?: ShapeEffectSettings): ShapeEffectSettings {
    return settings
        ? { ...DEFAULT_SHAPE_EFFECT_SETTINGS, ...settings }
        : DEFAULT_SHAPE_EFFECT_SETTINGS;
}

function phase(timeMs: number, periodMs: number): number {
    return (((timeMs % periodMs) + periodMs) % periodMs) / periodMs;
}

export function getShapeEffectMaxScale(
    effect: ShapeEffect | undefined,
    settings?: ShapeEffectSettings
): number {
    const intensity = getShapeEffectSettings(settings).intensity / 100;
    if (effect === 'pulse') return 1 + 0.12 * intensity;
    if (effect === 'focus') return 1.08 + 0.08 * intensity;
    if (effect === 'ping') return 1 + 0.65 * intensity;
    return 1;
}

/** Render-only values derived from absolute time; nothing is sent per frame. */
export function getShapeEffectFrame(
    effect: ShapeEffect | undefined,
    timeMs: number,
    settings?: ShapeEffectSettings
) {
    const { speed, intensity, direction, ringCount, playMode, phaseOffsetMs, startAtMs } =
        getShapeEffectSettings(settings);
    const strength = intensity / 100;
    const duration = effect && effect !== 'none' ? EFFECT_DURATION_MS[effect] / speed : 1;
    const elapsed =
        playMode === 'once'
            ? startAtMs === undefined
                ? duration
                : Math.max(0, timeMs - startAtMs)
            : timeMs + phaseOffsetMs;
    const progress =
        playMode === 'once' ? Math.min(1, elapsed / duration) : phase(elapsed, duration);
    const wave = Math.sin(Math.PI * progress) ** 2;
    const frame = {
        scale: 1,
        focusScale: 1,
        focusOpacity: 0,
        rings: [] as Array<{ scale: number; opacity: number }>,
        travelProgress: direction === 'reverse' ? 1 - progress : progress,
        travelOpacity: playMode === 'once' && progress >= 1 ? 0 : Math.min(1, strength),
        revealProgress: playMode === 'once' ? 1 - (1 - progress) ** 3 : Math.min(1, progress / 0.8)
    };
    switch (effect) {
        case 'pulse':
            frame.scale = 1 + 0.12 * strength * wave;
            break;
        case 'focus':
            frame.scale = 1 + 0.035 * strength * wave;
            frame.focusScale = 1.08 + 0.08 * strength * wave;
            frame.focusOpacity =
                playMode === 'once' && progress >= 1
                    ? 0
                    : Math.min(1, strength) * (0.4 + 0.55 * wave);
            break;
        case 'ping': {
            for (let i = 0; i < ringCount; i++) {
                const ringProgress =
                    playMode === 'once'
                        ? Math.max(
                              0,
                              Math.min(1, (progress - i * 0.18) / (1 - (ringCount - 1) * 0.18))
                          )
                        : phase(progress - i / ringCount, 1);
                frame.rings.push({
                    scale: 1 + 0.65 * strength * ringProgress,
                    opacity:
                        Math.min(1, strength) *
                        0.8 *
                        (1 - ringProgress) *
                        (playMode === 'once' && progress < i * 0.18 ? 0 : 1)
                });
            }
            break;
        }
    }
    return frame;
}

export function getPolylineLength(points: ArrayLike<number>): number {
    let length = 0;
    for (let i = 2; i + 1 < points.length; i += 2) {
        length += Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
    }
    return length;
}

export type OutlinePoint = { x: number; y: number };
type Outline = { points: OutlinePoint[]; total: number };
const outlineCache = new Map<string, Outline>();

/** Shared perimeter sampling for editor, preview and wall overlays. */
export function getShapeOutline(
    shape: 'rectangle' | 'oval',
    width: number,
    height: number,
    cornerRadius = 0
): Outline {
    const key = `${shape}:${width}:${height}:${cornerRadius}`;
    const cached = outlineCache.get(key);
    if (cached) return cached;
    const points: OutlinePoint[] = [];
    const add = (x: number, y: number) => points.push({ x, y });
    if (shape === 'oval') {
        for (let i = 0; i <= 128; i++) {
            const angle = -Math.PI / 2 + (2 * Math.PI * i) / 128;
            add(
                width / 2 + (width / 2) * Math.cos(angle),
                height / 2 + (height / 2) * Math.sin(angle)
            );
        }
    } else {
        const radius = Math.min(Math.max(0, cornerRadius), width / 2, height / 2);
        add(radius, 0);
        add(width - radius, 0);
        const corners = [
            [width - radius, radius, -Math.PI / 2],
            [width - radius, height - radius, 0],
            [radius, height - radius, Math.PI / 2],
            [radius, radius, Math.PI]
        ];
        for (const [cx, cy, start] of corners) {
            for (let i = 1; i <= 12; i++) {
                const angle = start + (Math.PI * i) / 24;
                add(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
            }
            if (start === -Math.PI / 2) add(width, height - radius);
            if (start === 0) add(radius, height);
            if (start === Math.PI / 2) add(0, radius);
        }
        add(radius, 0);
    }
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    const outline = { points, total };
    if (outlineCache.size >= 64) outlineCache.clear();
    outlineCache.set(key, outline);
    return outline;
}

export function partialShapeOutline(outline: Outline, progress: number, reverse = false): number[] {
    const target = Math.max(0, Math.min(1, progress)) * outline.total;
    const points = reverse ? [...outline.points].reverse() : outline.points;
    const result = [points[0].x, points[0].y];
    let distance = 0;
    for (let i = 1; i < points.length && distance < target; i++) {
        const previous = points[i - 1];
        const current = points[i];
        const segment = Math.hypot(current.x - previous.x, current.y - previous.y);
        if (distance + segment <= target) {
            result.push(current.x, current.y);
            distance += segment;
        } else {
            const fraction = segment > 0 ? (target - distance) / segment : 0;
            result.push(
                previous.x + (current.x - previous.x) * fraction,
                previous.y + (current.y - previous.y) * fraction
            );
            break;
        }
    }
    return result;
}
