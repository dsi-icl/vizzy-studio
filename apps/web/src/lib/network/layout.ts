import {
    forceCenter,
    forceCollide,
    forceLink,
    forceManyBody,
    forceSimulation,
    type SimulationNodeDatum
} from 'd3-force';

import {
    NETWORK_HEIGHT,
    NETWORK_WIDTH,
    type Network,
    type NetworkData,
    type NetworkSettings
} from './schema';

export function layoutNetwork(data: NetworkData, settings: NetworkSettings): Network['positions'] {
    // D3 mutates nodes and links. Never pass the document's data into the simulation.
    const nodes: (SimulationNodeDatum & { id: string })[] = data.nodes.map(({ id }) => ({ id }));
    const simulation = forceSimulation(nodes)
        .stop()
        .force('charge', forceManyBody().strength(settings.charge))
        .force(
            'link',
            forceLink(data.edges.map((edge) => ({ ...edge })))
                .id((node) => (node as { id: string }).id)
                .distance(settings.linkDistance)
                .strength(settings.linkStrength)
        )
        .force(
            'collision',
            forceCollide(Math.max(settings.nodeRadius + 2, settings.collisionRadius))
        )
        .force('center', forceCenter(0, 0));
    simulation.tick(300);
    const xs = nodes.map((node) => node.x ?? 0);
    const ys = nodes.map((node) => node.y ?? 0);
    const minX = Math.min(...xs),
        maxX = Math.max(...xs);
    const minY = Math.min(...ys),
        maxY = Math.max(...ys);
    const padding = 65;
    // Keep the same scale on both axes; do not distort the graph to fill the box.
    const scale = Math.min(
        1,
        (NETWORK_WIDTH - 2 * padding) / Math.max(1, maxX - minX),
        (NETWORK_HEIGHT - 2 * padding) / Math.max(1, maxY - minY)
    );
    return nodes.map((node) => ({
        x: NETWORK_WIDTH / 2 + ((node.x ?? 0) - (minX + maxX) / 2) * scale,
        y: NETWORK_HEIGHT / 2 + ((node.y ?? 0) - (minY + maxY) / 2) * scale
    }));
}
