import {
    NETWORK_HEIGHT,
    NETWORK_WIDTH,
    type Network,
    type NetworkData,
    type NetworkPositions
} from './schema';

/** Identity of the simulated layout. Paint-only settings leave the frame stream intact. */
export function networkDocumentKey(network: Network): string {
    const {
        charge,
        linkDistance,
        linkStrength,
        collisionRadius,
        nodeRadius,
        motionStrength,
        paused
    } = network.settings;
    const text = JSON.stringify([
        network.source,
        network.data.nodes.map(({ id, label, group }) => [id, label, group]),
        network.data.edges.map(({ source, target, weight }) => [source, target, weight]),
        [charge, linkDistance, linkStrength, collisionRadius, nodeRadius, motionStrength, paused],
        network.reheat,
        network.positions?.map(({ x, y }) => [x, y])
    ]);
    let a = 2166136261,
        b = 5381;
    for (let i = 0; i < text.length; i++) {
        a = Math.imul(a ^ text.charCodeAt(i), 16777619);
        b = Math.imul(b, 33) ^ text.charCodeAt(i);
    }
    return `${text.length}:${a >>> 0}:${b >>> 0}`;
}

export function initialNetworkPositions(data: NetworkData): NetworkPositions {
    return data.nodes.map((_, i) => {
        const angle = i * Math.PI * (3 - Math.sqrt(5));
        const radius = Math.min(220, 15 * Math.sqrt(i + 0.5));
        return {
            x: NETWORK_WIDTH / 2 + Math.cos(angle) * radius,
            y: NETWORK_HEIGHT / 2 + Math.sin(angle) * radius
        };
    });
}
