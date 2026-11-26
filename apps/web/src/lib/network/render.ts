import { getFontFamilyCss } from '../fontFamilyOptions';
import type { LayerPositionState } from '../types';
import { initialNetworkPositions } from './document';
import { networkInfluenceValues, networkNodeRadius, networkVisibleNodeIds } from './influence';
import {
    NETWORK_HEIGHT,
    NETWORK_WIDTH,
    type Network,
    type NetworkData,
    type NetworkSettings,
    type NetworkView
} from './schema';

export type Rect = { x: number; y: number; w: number; h: number };
export type NetworkSelection = { nodeId: string } | { edgeIndex: number } | null;
type Point = { x: number; y: number };
type DrawNode = {
    id: string;
    label: string;
    group?: string;
    x: number;
    y: number;
    radius: number;
};
export const NETWORK_COLORS = ['#60a5fa', '#34d399', '#fbbf24', '#c084fc', '#fb7185', '#22d3ee'];

/** Signed matrix values encode relationship strength; the sign is encoded by colour. */
export function networkEdgeWidth(edge: NetworkData['edges'][number], settings: NetworkSettings) {
    return edge.influence === undefined
        ? settings.edgeWidth * Math.min(4, Math.sqrt(edge.weight ?? 1))
        : settings.edgeWidth * (0.5 + Math.abs(edge.influence) * 0.5);
}

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
    const data = network.data;
    const fallback = network.positions ?? initialNetworkPositions(data);
    const livePositions = live
        ? new Map(live.data.nodes.map((node, index) => [node.id, live.positions[index]]))
        : null;
    const positions = data.nodes.map(
        (node, index) => livePositions?.get(node.id) ?? fallback[index]
    );
    const indices = new Map(data.nodes.map((node, index) => [node.id, index]));
    const visible = networkVisibleNodeIds(network);
    const influenceValues = networkInfluenceValues(network);
    const groups = [...new Set(data.nodes.map((node) => node.group ?? ''))].sort();
    const selectedEdge =
        selection && 'edgeIndex' in selection ? data.edges[selection.edgeIndex] : undefined;
    const selectedNode = selection && 'nodeId' in selection ? selection.nodeId : undefined;
    const drawNodes: DrawNode[] = [];
    data.nodes.forEach((node, index) => {
        if (visible && !visible.has(node.id)) return;
        const p = positions[index];
        if (!p) return;
        drawNodes.push({
            id: node.id,
            label: node.label || node.id,
            group: node.group,
            x: p.x,
            y: p.y,
            radius: networkNodeRadius(network, influenceValues.get(node.id) ?? 50)
        });
    });
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    for (const edge of data.edges) {
        if (visible && (!visible.has(edge.source) || !visible.has(edge.target))) continue;
        const a = positions[indices.get(edge.source)!],
            b = positions[indices.get(edge.target)!];
        if (!a || !b) continue;
        const edgeWidth = networkEdgeWidth(edge, settings);
        const loop = edge.source === edge.target;
        if (
            viewport &&
            !segmentIntersectsRect(a, b, viewport, loop ? settings.nodeRadius * 4 : edgeWidth)
        )
            continue;
        const selected = edge === selectedEdge;
        const active =
            edge.source === network.influence?.activeNodeId ||
            edge.target === network.influence?.activeNodeId;
        ctx.globalAlpha = network.influence ? (active ? 0.9 : 0.32) : 1;
        ctx.strokeStyle = selected
            ? '#a5b4fc'
            : edge.influence === undefined
              ? settings.edgeColor
              : edge.influence > 0
                ? settings.relationshipColors.positive
                : edge.influence < 0
                  ? settings.relationshipColors.negative
                  : settings.relationshipColors.neutral;
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
    ctx.globalAlpha = 1;
    ctx.font = `${settings.labelFontSize ?? 14}px ${getFontFamilyCss(settings.labelFontFamily ?? 'system-sans')}`;
    ctx.textBaseline = 'middle';
    for (const node of drawNodes) {
        const selected =
            node.id === selectedNode ||
            node.id === selectedEdge?.source ||
            node.id === selectedEdge?.target;
        const value = influenceValues.get(node.id) ?? 50;
        const radius = node.radius;
        if (
            viewport &&
            (node.x + radius + (selected ? 4 : 0) < viewport.x ||
                node.x - radius - (selected ? 4 : 0) > viewport.x + viewport.w ||
                node.y + radius + (selected ? 4 : 0) < viewport.y ||
                node.y - radius - (selected ? 4 : 0) > viewport.y + viewport.h)
        )
            continue;
        ctx.fillStyle = settings.colorByGroup
            ? NETWORK_COLORS[groups.indexOf(node.group ?? '') % NETWORK_COLORS.length]!
            : network.influence && settings.nodeColor.toLowerCase() === '#ffffff'
              ? value > 52
                  ? '#ef4444'
                  : value < 48
                    ? '#3b82f6'
                    : '#e2e8f0'
              : settings.nodeColor;
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx.fill();
        if (selected) {
            ctx.strokeStyle = '#a5b4fc';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(node.x, node.y, radius + 4, 0, Math.PI * 2);
            ctx.stroke();
        }
    }
    ctx.fillStyle = settings.labelColor;
    for (const node of drawNodes) {
        const selected =
            node.id === selectedNode ||
            node.id === selectedEdge?.source ||
            node.id === selectedEdge?.target;
        if (
            !selected &&
            (!settings.showLabels ||
                (settings.labelGroup !== undefined && (node.group ?? '') !== settings.labelGroup))
        )
            continue;
        const x = node.x + node.radius + 5;
        const width = ctx.measureText(node.label).width;
        const halfHeight = (settings.labelFontSize ?? 14) * 0.625;
        if (
            viewport &&
            (x + width < viewport.x ||
                x > viewport.x + viewport.w ||
                node.y + halfHeight < viewport.y ||
                node.y - halfHeight > viewport.y + viewport.h)
        )
            continue;
        ctx.fillText(node.label, x, node.y);
    }
    ctx.restore();
}
