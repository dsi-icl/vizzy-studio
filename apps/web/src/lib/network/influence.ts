import type { Network } from './schema';

/** Null means every node is displayed. Filtering only affects paint and hit testing. */
export function networkVisibleNodeIds(network: Network): Set<string> | null {
    const ids = network.influence?.visibleNodeIds;
    return ids ? new Set(ids) : null;
}

/** The HTML prototype's one-hop, signed feedback rule. Blank links are absent;
 * a stored zero remains a visible link but contributes no feedback. */
export function networkInfluenceValues(network: Network): Map<string, number> {
    const state = network.influence;
    const values = new Map(
        network.data.nodes.map((node) => [node.id, state?.values[node.id] ?? 50])
    );
    if (!state) return values;
    const driver = state.values[state.activeNodeId] ?? 50;
    for (const edge of network.data.edges) {
        if (edge.influence === undefined || edge.influence === 0) continue;
        const other =
            edge.source === state.activeNodeId
                ? edge.target
                : edge.target === state.activeNodeId
                  ? edge.source
                  : null;
        if (other && other !== state.activeNodeId)
            values.set(
                other,
                Math.max(
                    0,
                    Math.min(100, 50 + (driver - 50) * edge.influence * 0.55 * state.propagation)
                )
            );
    }
    return values;
}

export function networkNodeRadius(network: Network, value: number): number {
    return network.influence
        ? network.settings.nodeRadius * ((18 + value * 0.28) / 32)
        : network.settings.nodeRadius;
}
