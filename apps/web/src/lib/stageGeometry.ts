'use client';

import type Konva from 'konva';

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

export function touchToStagePoint(
    stage: Konva.Stage,
    touch: Pick<Touch, 'clientX' | 'clientY'>
): { x: number; y: number } {
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
    const scale = Math.max(Math.abs(pos.scaleX), Math.abs(pos.scaleY), 1);
    const filterBlur =
        layer.config.filters?.enabled === true ? (layer.config.filters.blur ?? 0) : 0;
    const blurPadding = filterBlur * scale * 2;
    const strokePadding =
        layer.type === 'line' || layer.type === 'shape' ? (layer.strokeWidth / 2) * scale : 0;
    return 20 + blurPadding + strokePadding;
}

export type ImagePinchPoint = { x: number; y: number };
export type ImagePinchTransform = {
    cx: number;
    cy: number;
    scaleX: number;
    scaleY: number;
    rotation: number;
};

// Reuse do-image's cursor/midpoint anchored model and limits. Vizzy also permits
// mirrored layers, so clamp the magnitudes together without changing their signs.
function scaleFactor(base: ImagePinchTransform, ratio: number) {
    const x = Math.abs(base.scaleX),
        y = Math.abs(base.scaleY);
    if (!Number.isFinite(ratio) || ratio <= 0 || !x || !y) return 1;
    return Math.max(Math.max(0.1 / x, 0.1 / y), Math.min(Math.min(1000 / x, 1000 / y), ratio));
}

export function scaleImageAroundPoint(
    base: ImagePinchTransform,
    pivot: ImagePinchPoint,
    ratio: number
): ImagePinchTransform {
    const factor = scaleFactor(base, ratio);
    return {
        ...base,
        cx: pivot.x + (base.cx - pivot.x) * factor,
        cy: pivot.y + (base.cy - pivot.y) * factor,
        scaleX: base.scaleX * factor,
        scaleY: base.scaleY * factor
    };
}

export function pinchImageTransform(
    base: ImagePinchTransform,
    start: [ImagePinchPoint, ImagePinchPoint],
    current: [ImagePinchPoint, ImagePinchPoint]
): ImagePinchTransform {
    const initialDistance = getDistance(...start),
        distance = getDistance(...current);
    if (initialDistance < 1 || distance < 1) return base;
    const factor = scaleFactor(base, distance / initialDistance);
    const turn = getAngleDelta(getAngle(...current), getAngle(...start));
    const radians = (turn * Math.PI) / 180;
    const dx = base.cx - (start[0].x + start[1].x) / 2;
    const dy = base.cy - (start[0].y + start[1].y) / 2;
    return {
        cx:
            (current[0].x + current[1].x) / 2 +
            (dx * Math.cos(radians) - dy * Math.sin(radians)) * factor,
        cy:
            (current[0].y + current[1].y) / 2 +
            (dx * Math.sin(radians) + dy * Math.cos(radians)) * factor,
        scaleX: base.scaleX * factor,
        scaleY: base.scaleY * factor,
        rotation: base.rotation + turn
    };
}

export function imagePinchWheelFactor(deltaY: number, deltaMode: number, height: number) {
    const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? height || 1 : 1;
    return Math.exp(Math.max(-1, Math.min(1, (-deltaY * unit) / 100)));
}
