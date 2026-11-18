import type { LayerPositionState } from '../types';
import { initialNetworkPositions } from './document';
import { NETWORK_HEIGHT, NETWORK_WIDTH, type Network, type NetworkView } from './schema';

export type Rect = { x: number; y: number; w: number; h: number };
export type NetworkSelection = { nodeId: string } | { edgeIndex: number } | null;
type Point = { x: number; y: number };
export const NETWORK_COLORS = ['#60a5fa', '#34d399', '#fbbf24', '#c084fc', '#fb7185', '#22d3ee'];

export function networkFit(width: number, height: number) {
    const scale = Math.max(
        0.000001,
        Math.min(Math.abs(width) / NETWORK_WIDTH, Math.abs(height) / NETWORK_HEIGHT)
    );
    return {
        scale,
        x: (width - NETWORK_WIDTH * scale) / 2,
        y: (height - NETWORK_HEIGHT * scale) / 2
    };
}

/** A segment may cross a screen even when BOTH endpoints are on other screens. */
export function segmentIntersectsRect(a: Point, b: Point, rect: Rect, padding = 0) {
    let enter = 0,
        exit = 1;
    const dx = b.x - a.x,
        dy = b.y - a.y;
    const bounds = [
        [-dx, a.x - rect.x + padding],
        [dx, rect.x + rect.w - a.x + padding],
        [-dy, a.y - rect.y + padding],
        [dy, rect.y + rect.h - a.y + padding]
    ];
    for (const [p, q] of bounds) {
        if (p === 0) {
            if (q! < 0) return false;
        } else {
            const t = q! / p!;
            if (p! < 0) enter = Math.max(enter, t);
            else exit = Math.min(exit, t);
            if (enter > exit) return false;
        }
    }
    return true;
}

/** Inverse transform of the physical screen into the shared graph coordinate space. */
export function networkViewport(pos: LayerPositionState, screen: Rect): Rect {
    const fit = networkFit(pos.width, pos.height);
    const radians = (-pos.rotation * Math.PI) / 180;
    const cos = Math.cos(radians),
        sin = Math.sin(radians);
    const points = [
        [screen.x, screen.y],
        [screen.x + screen.w, screen.y],
        [screen.x, screen.y + screen.h],
        [screen.x + screen.w, screen.y + screen.h]
    ].map(([x, y]) => {
        const dx = x! - pos.cx,
            dy = y! - pos.cy;
        return {
            x: ((cos * dx - sin * dy) / (pos.scaleX || 1) + pos.width / 2 - fit.x) / fit.scale,
            y: ((sin * dx + cos * dy) / (pos.scaleY || 1) + pos.height / 2 - fit.y) / fit.scale
        };
    });
    const xs = points.map((p) => p.x),
        ys = points.map((p) => p.y);
    return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys)
    };
}

/** Shared painter for editor, previews and wall. The caller owns the canvas size/transform. */
export function drawNetwork(
    ctx: CanvasRenderingContext2D,
    network: Network | undefined,
    width: number,
    height: number,
    viewport?: Rect,
    live?: NetworkView,
    selection: NetworkSelection = null
) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.clip();
    if (!network) {
        ctx.restore();
        return;
    }
    const fit = networkFit(width, height);
    ctx.translate(fit.x, fit.y);
    ctx.scale(fit.scale, fit.scale);
    const { settings } = network;
    const { data, positions } = live ?? {
        data: network.data,
        positions: network.positions ?? initialNetworkPositions(network.data)
    };
    const indices = new Map(data.nodes.map((node, index) => [node.id, index]));
    const groups = [...new Set(data.nodes.map((node) => node.group ?? ''))].sort();
    const selectedEdge =
        selection && 'edgeIndex' in selection ? data.edges[selection.edgeIndex] : undefined;
    const selectedNode = selection && 'nodeId' in selection ? selection.nodeId : undefined;
    ctx.lineCap = 'round';
    for (const edge of data.edges) {
        const a = positions[indices.get(edge.source)!],
            b = positions[indices.get(edge.target)!];
        if (!a || !b) continue;
        const edgeWidth = settings.edgeWidth * Math.min(4, Math.sqrt(edge.weight ?? 1));
        const loop = edge.source === edge.target;
        if (
            viewport &&
            !segmentIntersectsRect(a, b, viewport, loop ? settings.nodeRadius * 4 : edgeWidth)
        )
            continue;
        const selected = edge === selectedEdge;
        ctx.strokeStyle = selected ? '#a5b4fc' : settings.edgeColor;
        ctx.lineWidth = selected ? Math.max(3, edgeWidth + 1) : edgeWidth;
        ctx.beginPath();
        if (loop)
            ctx.arc(
                a.x,
                a.y - settings.nodeRadius * 1.8,
                settings.nodeRadius * 1.8,
                0,
                Math.PI * 2
            );
        else {
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
    }
    ctx.font = '14px sans-serif';
    ctx.textBaseline = 'middle';
    data.nodes.forEach((node, index) => {
        const p = positions[index];
        if (!p) return;
        const selected =
            node.id === selectedNode ||
            node.id === selectedEdge?.source ||
            node.id === selectedEdge?.target;
        const showLabel = settings.showLabels || selected;
        const label = node.label || node.id;
        const labelWidth = showLabel ? ctx.measureText(label).width + settings.nodeRadius + 5 : 0;
        // Labels/partial nodes crossing a tile boundary must survive culling too.
        if (
            viewport &&
            (p.x + Math.max(settings.nodeRadius, labelWidth) < viewport.x ||
                p.x - settings.nodeRadius > viewport.x + viewport.w ||
                p.y + Math.max(10, settings.nodeRadius) < viewport.y ||
                p.y - Math.max(10, settings.nodeRadius) > viewport.y + viewport.h)
        )
            return;
        ctx.fillStyle = settings.colorByGroup
            ? NETWORK_COLORS[groups.indexOf(node.group ?? '') % NETWORK_COLORS.length]!
            : settings.nodeColor;
        ctx.beginPath();
        ctx.arc(p.x, p.y, settings.nodeRadius, 0, Math.PI * 2);
        ctx.fill();
        if (selected) {
            ctx.strokeStyle = '#a5b4fc';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(p.x, p.y, settings.nodeRadius + 4, 0, Math.PI * 2);
            ctx.stroke();
        }
        if (showLabel) {
            ctx.fillStyle = settings.labelColor;
            ctx.fillText(label, p.x + settings.nodeRadius + 5, p.y);
        }
    });
    ctx.restore();
}
