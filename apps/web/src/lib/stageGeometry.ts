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

export type RectTransform = {
    cx: number;
    cy: number;
    width: number;
    height: number;
    rotation: number;
    scaleX: number;
    scaleY: number;
};

export function getKonvaRectTransform(config: RectTransform, coordinateScale = 1) {
    return {
        x: config.cx * coordinateScale,
        y: config.cy * coordinateScale,
        width: config.width * coordinateScale,
        height: config.height * coordinateScale,
        offsetX: (config.width * coordinateScale) / 2,
        offsetY: (config.height * coordinateScale) / 2,
        scaleX: config.scaleX,
        scaleY: config.scaleY,
        rotation: config.rotation
    };
}

export function getTransformedRectBounds(config: RectTransform) {
    const width = Math.abs(config.width * config.scaleX);
    const height = Math.abs(config.height * config.scaleY);
    const radians = (config.rotation * Math.PI) / 180;
    const radiusX =
        (width / 2) * Math.abs(Math.cos(radians)) + (height / 2) * Math.abs(Math.sin(radians));
    const radiusY =
        (width / 2) * Math.abs(Math.sin(radians)) + (height / 2) * Math.abs(Math.cos(radians));

    return {
        left: config.cx - radiusX,
        top: config.cy - radiusY,
        right: config.cx + radiusX,
        bottom: config.cy + radiusY,
        width: radiusX * 2,
        height: radiusY * 2
    };
}

type HorizontalEdge = 'left' | 'right';
type VerticalEdge = 'top' | 'bottom';

/** Map a Konva transformer's local anchor name onto world-facing edges. */
export function getVisualAnchorEdges(anchor: string | null, rotation: number) {
    const normalized = normalizeRotationToQuadrant(rotation);
    const localEdges = [
        anchor?.includes('left') ? 'left' : anchor?.includes('right') ? 'right' : null,
        anchor?.includes('top') ? 'top' : anchor?.includes('bottom') ? 'bottom' : null
    ].filter((edge): edge is HorizontalEdge | VerticalEdge => edge !== null);

    const mappings: Record<
        number,
        Record<HorizontalEdge | VerticalEdge, HorizontalEdge | VerticalEdge>
    > = {
        0: { left: 'left', right: 'right', top: 'top', bottom: 'bottom' },
        90: { left: 'top', right: 'bottom', top: 'right', bottom: 'left' },
        180: { left: 'right', right: 'left', top: 'bottom', bottom: 'top' },
        270: { left: 'bottom', right: 'top', top: 'left', bottom: 'right' }
    };
    const mapping = mappings[normalized] ?? mappings[0];
    const visualEdges = localEdges.map((edge) => mapping[edge]);

    return {
        horizontal: visualEdges.find(
            (edge): edge is HorizontalEdge => edge === 'left' || edge === 'right'
        ),
        vertical: visualEdges.find(
            (edge): edge is VerticalEdge => edge === 'top' || edge === 'bottom'
        )
    };
}

export function hasSameSpatialTransform(a: RectTransform, b: RectTransform): boolean {
    return (
        a.cx === b.cx &&
        a.cy === b.cy &&
        a.width === b.width &&
        a.height === b.height &&
        a.rotation === b.rotation &&
        a.scaleX === b.scaleX &&
        a.scaleY === b.scaleY
    );
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
    const scale = Math.max(Math.abs(pos.scaleX), Math.abs(pos.scaleY), 1);
    const filterBlur =
        layer.config.filters?.enabled === true ? (layer.config.filters.blur ?? 0) : 0;
    const blurPadding = filterBlur * scale * 2;
    const strokePadding =
        layer.type === 'line' || layer.type === 'shape' ? (layer.strokeWidth / 2) * scale : 0;
    return 20 + blurPadding + strokePadding;
}
