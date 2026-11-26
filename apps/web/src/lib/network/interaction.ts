import { initialNetworkPositions } from './document';
import { networkInfluenceValues, networkNodeRadius, networkVisibleNodeIds } from './influence';
import { networkEdgeWidth, networkFit, type NetworkSelection, type Rect } from './render';
import {
    NETWORK_HEIGHT,
    NETWORK_WIDTH,
    type Network,
    type NetworkData,
    type NetworkSettings,
    type NetworkView
} from './schema';

/** Match the canvas's object-contain transform, including its empty margins. */
export function networkPointerPosition(clientX: number, clientY: number, bounds: Rect) {
    if (bounds.w <= 0 || bounds.h <= 0) return null;
    const fit = networkFit(bounds.w, bounds.h);
    const x = (clientX - bounds.x - fit.x) / fit.scale;
    const y = (clientY - bounds.y - fit.y) / fit.scale;
    return x >= 0 && x <= NETWORK_WIDTH && y >= 0 && y <= NETWORK_HEIGHT
        ? { x, y, scale: fit.scale }
        : null;
}

export function clampNetworkNodePosition(point: { x: number; y: number }, nodeRadius: number) {
    const margin = nodeRadius + 8;
    return {
        x: Math.max(margin, Math.min(NETWORK_WIDTH - margin, point.x)),
        y: Math.max(margin, Math.min(NETWORK_HEIGHT - margin, point.y))
    };
}

/** Use the current topology while a worker update is in flight. IDs keep the
 * positions aligned after a node is inserted, removed or renamed. */
export function networkPreviewView(data: NetworkData, live?: NetworkView): NetworkView {
    if (!live) return { data, positions: initialNetworkPositions(data) };
    const previous = new Map(live.data.nodes.map((node, i) => [node.id, live.positions[i]]));
    const fallback = initialNetworkPositions(data);
    return { data, positions: data.nodes.map((node, i) => previous.get(node.id) ?? fallback[i]!) };
}

export function hitTestNetwork(
    view: NetworkView,
    settings: NetworkSettings,
    point: { x: number; y: number; scale: number },
    network?: Network
): NetworkSelection {
    const nodeRadius = Math.max(settings.nodeRadius, 9 / point.scale);
    const values = network ? networkInfluenceValues(network) : null;
    const visible = network ? networkVisibleNodeIds(network) : null;
    // Nodes are painted above links. Within a node's target area, select the node.
    let nodeIndex = -1;
    let nearestNode = Infinity;
    for (let i = view.data.nodes.length - 1; i >= 0; i--) {
        if (visible && !visible.has(view.data.nodes[i]!.id)) continue;
        const p = view.positions[i];
        if (!p) continue;
        const distance = Math.hypot(point.x - p.x, point.y - p.y);
        const radius = network
            ? Math.max(
                  networkNodeRadius(network, values?.get(view.data.nodes[i]!.id) ?? 50),
                  9 / point.scale
              )
            : nodeRadius;
        if (distance <= radius && distance < nearestNode) {
            nearestNode = distance;
            nodeIndex = i;
        }
    }
    if (nodeIndex !== -1) return { nodeId: view.data.nodes[nodeIndex]!.id };
    const byId = new Map(view.data.nodes.map((node, i) => [node.id, view.positions[i]]));
    let edgeIndex = -1;
    let nearestEdge = Infinity;
    for (let i = view.data.edges.length - 1; i >= 0; i--) {
        const edge = view.data.edges[i]!;
        if (visible && (!visible.has(edge.source) || !visible.has(edge.target))) continue;
        const a = byId.get(edge.source),
            b = byId.get(edge.target);
        if (!a || !b) continue;
        let distance: number;
        if (edge.source === edge.target) {
            const radius = settings.nodeRadius * 1.8;
            distance = Math.abs(Math.hypot(point.x - a.x, point.y - (a.y - radius)) - radius);
        } else {
            const dx = b.x - a.x,
                dy = b.y - a.y;
            const length = dx * dx + dy * dy;
            const t = length
                ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length))
                : 0;
            distance = Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
        }
        const width = networkEdgeWidth(edge, settings);
        const tolerance = Math.max(5 / point.scale, width / 2 + 2 / point.scale);
        if (distance <= tolerance && distance < nearestEdge) {
            nearestEdge = distance;
            edgeIndex = i;
        }
    }
    return edgeIndex === -1 ? null : { edgeIndex };
}
