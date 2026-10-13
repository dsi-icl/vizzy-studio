'use client';

import type Konva from 'konva';

import { getShapeEffectMaxScale } from '~/lib/shapeEffects';
import type { LayerWithWallComponentState } from '~/lib/types';

// ── Rotation ──────────────────────────────────────────────────────────────────

export function normalizeRotationToQuadrant(rotation: number): number {
    return ((Math.round(rotation) % 360) + 360) % 360;
}

export function isCardinalRotation(rotation: number): boolean {
    const normalized = normalizeRotationToQuadrant(rotation);
    return normalized === 0 || normalized === 90 || normalized === 180 || normalized === 270;
}

// ── Snapping ──────────────────────────────────────────────────────────────────

export function snapToGrid(value: number, grid: number): number {
    return Math.round(value / grid) * grid;
}

// ── Touch / pinch ─────────────────────────────────────────────────────────────

export function getDistance(p1: { x: number; y: number }, p2: { x: number; y: number }): number {
    return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
}

export function getAngle(p1: { x: number; y: number }, p2: { x: number; y: number }): number {
    return (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
}

/** Keep delta in [-180, 180] to avoid wrap-around jumps at the ±180 boundary. */
export function getAngleDelta(current: number, previous: number): number {
    return ((current - previous + 540) % 360) - 180;
}

export function touchToStagePoint(stage: Konva.Stage, touch: Touch): { x: number; y: number } {
    const rect = stage.container().getBoundingClientRect();
    const pointer = { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
    const transform = stage.getAbsoluteTransform().copy();
    transform.invert();
    return transform.point(pointer);
}

// ── Line / AABB (used by wall renderer) ──────────────────────────────────────

export function getLineBounds(line: number[]) {
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;

    for (let i = 0; i < line.length; i += 2) {
        const x = line[i];
        const y = line[i + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }

    if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;

    const rawWidth = maxX - minX;
    const rawHeight = maxY - minY;
    return {
        minX,
        minY,
        maxX,
        maxY,
        width: Math.max(1, Math.round(rawWidth)),
        height: Math.max(1, Math.round(rawHeight)),
        cx: minX + rawWidth / 2,
        cy: minY + rawHeight / 2
    };
}

export function getCullingPadding(
    layer: LayerWithWallComponentState,
    pos: { scaleX: number; scaleY: number }
): number {
    const effectScale =
        layer.type === 'shape' ? getShapeEffectMaxScale(layer.effect, layer.effectSettings) : 1;
    const scale = Math.max(Math.abs(pos.scaleX), Math.abs(pos.scaleY), 1) * effectScale;
    const filterBlur =
        layer.config.filters?.enabled === true ? (layer.config.filters.blur ?? 0) : 0;
    const blurPadding = filterBlur * scale * 2;
    const strokePadding =
        layer.type === 'line' || layer.type === 'shape' ? (layer.strokeWidth / 2) * scale : 0;
    return (
        20 +
        blurPadding +
        strokePadding +
        (layer.type === 'shape' && layer.effect === 'focus' ? 8 * scale : 0)
    );
}

/** Radius of the largest rendered footprint, including the full pulse cycle. */
export function getLayerCullingRadii(
    layer: LayerWithWallComponentState,
    pos: { width: number; height: number; rotation: number; scaleX: number; scaleY: number }
): { x: number; y: number } {
    const effectScale =
        layer.type === 'shape' ? getShapeEffectMaxScale(layer.effect, layer.effectSettings) : 1;
    const halfWidth = (Math.abs(pos.width * pos.scaleX) * effectScale) / 2;
    const halfHeight = (Math.abs(pos.height * pos.scaleY) * effectScale) / 2;
    const rotation = (pos.rotation * Math.PI) / 180;
    const cosine = Math.abs(Math.cos(rotation));
    const sine = Math.abs(Math.sin(rotation));
    const padding = getCullingPadding(layer, pos);
    return {
        x: halfWidth * cosine + halfHeight * sine + padding,
        y: halfWidth * sine + halfHeight * cosine + padding
    };
}
