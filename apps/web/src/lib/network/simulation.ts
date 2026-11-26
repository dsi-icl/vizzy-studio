import {
    forceCenter,
    forceCollide,
    forceLink,
    forceManyBody,
    forceSimulation,
    forceX,
    forceY,
    type ForceLink,
    type SimulationLinkDatum,
    type SimulationNodeDatum
} from 'd3-force';

import {
    NETWORK_HEIGHT,
    NETWORK_WIDTH,
    type Network,
    type NetworkData,
    type NetworkPositions,
    type NetworkView
} from './schema';

type Node = SimulationNodeDatum & { id: string };

import { networkDocumentKey, networkTopologyKey, initialNetworkPositions } from './document';

/** One continuing simulation. Call advance at 20 Hz; each call steps three physics ticks. */
export function createNetworkSimulation(initial: Network) {
    let network = initial;
    let nodes: Node[] = [];
    let data: NetworkData = initial.data;
    let topologyVersion = 0;
    let changed = true;
    let documentKey = '';
    const simulation = forceSimulation<Node>([]).stop();
    const random = simulation.randomSource();
    const wander = new Map<
        string,
        { x: number; y: number; tx: number; ty: number; ticks: number }
    >();
    // Smooth, correlated random acceleration. It acts on existing nodes only and
    // runs in the shared simulation, so tiles never invent their own motion.
    simulation.force('wander', () => {
        const strength = network.settings.motionStrength;
        if (!strength) return;
        for (const node of nodes) {
            let state = wander.get(node.id);
            if (!state) {
                state = { x: 0, y: 0, tx: 0, ty: 0, ticks: 0 };
                wander.set(node.id, state);
            }
            if (--state.ticks <= 0) {
                const angle = random() * Math.PI * 2;
                state.tx = Math.cos(angle);
                state.ty = Math.sin(angle);
                state.ticks = 45 + Math.floor(random() * 90);
            }
            state.x += (state.tx - state.x) * 0.04;
            state.y += (state.ty - state.y) * 0.04;
            node.vx = (node.vx ?? 0) + state.x * strength * 0.35;
            node.vy = (node.vy ?? 0) + state.y * strength * 0.35;
        }
    });

    function setTopology(next: NetworkData, seed?: NetworkPositions, useSeed = false) {
        const previous = new Map(nodes.map((node) => [node.id, node]));
        const fallback = seed ?? initialNetworkPositions(next);
        nodes = next.nodes.map(
            (node, i) =>
                (useSeed ? undefined : previous.get(node.id)) ?? { id: node.id, ...fallback[i] }
        );
        data = next;
        const ids = new Set(nodes.map((node) => node.id));
        for (const id of wander.keys()) if (!ids.has(id)) wander.delete(id);
        simulation.force('link', null);
        simulation.nodes(nodes);
        simulation.force(
            'link',
            forceLink<Node, SimulationLinkDatum<Node>>(data.edges.map((edge) => ({ ...edge })))
                .id((node) => node.id)
                .distance(network.settings.linkDistance)
                .strength(network.settings.linkStrength)
        );
        topologyVersion++;
        changed = true;
    }

    function configure(next: Network) {
        const key = networkDocumentKey(next);
        if (documentKey === key) return;
        const topologyChanged =
            !documentKey || networkTopologyKey(network.data) !== networkTopologyKey(next.data);
        const pausedSnapshot = next.settings.paused && !!next.positions;
        const positionsChanged =
            pausedSnapshot && JSON.stringify(network.positions) !== JSON.stringify(next.positions);
        const movedNode =
            next.nodeMove &&
            (!documentKey || JSON.stringify(network.nodeMove) !== JSON.stringify(next.nodeMove))
                ? next.nodeMove
                : undefined;
        const nudged = !!documentKey && next.reheat !== network.reheat;
        network = next;
        documentKey = key;
        if (topologyChanged || positionsChanged) {
            setTopology(next.data, next.positions, pausedSnapshot);
        }
        const s = next.settings;
        simulation
            .force('charge', forceManyBody<Node>().strength(s.charge))
            .force('center', forceCenter<Node>(NETWORK_WIDTH / 2, NETWORK_HEIGHT / 2))
            .force('x', forceX<Node>(NETWORK_WIDTH / 2).strength(0.03))
            .force('y', forceY<Node>(NETWORK_HEIGHT / 2).strength(0.03))
            .force(
                'collision',
                forceCollide<Node>(Math.max(s.nodeRadius + 2, s.collisionRadius)).iterations(2)
            );
        const link = simulation.force('link') as ForceLink<Node, SimulationLinkDatum<Node>>;
        link.distance(s.linkDistance).strength(s.linkStrength);
        simulation.alphaTarget(s.motionStrength > 0 ? 0.12 : 0).alpha(0.8);
        if (movedNode) {
            const node = nodes.find((candidate) => candidate.id === movedNode.nodeId);
            if (node) {
                const margin = s.nodeRadius + 8;
                node.x = Math.max(margin, Math.min(NETWORK_WIDTH - margin, movedNode.x));
                node.y = Math.max(margin, Math.min(NETWORK_HEIGHT - margin, movedNode.y));
                node.vx = 0;
                node.vy = 0;
            }
        }
        if (nudged) {
            for (const node of nodes) {
                const angle = random() * Math.PI * 2;
                const impulse = 3 + random() * 3;
                node.vx = (node.vx ?? 0) + Math.cos(angle) * impulse;
                node.vy = (node.vy ?? 0) + Math.sin(angle) * impulse;
            }
        }
        changed = true;
    }

    configure(initial);
    return {
        configure,
        advance(_now: number) {
            let moved = changed;
            changed = false;
            if (network.settings.paused) return moved;
            if (simulation.alpha() >= simulation.alphaMin()) {
                simulation.tick(3);
                // Fixed shared world: screen clipping never changes physics or camera framing.
                const margin = network.settings.nodeRadius + 8;
                for (const node of nodes) {
                    const x = Math.max(
                        margin,
                        Math.min(NETWORK_WIDTH - margin, node.x ?? NETWORK_WIDTH / 2)
                    );
                    const y = Math.max(
                        margin,
                        Math.min(NETWORK_HEIGHT - margin, node.y ?? NETWORK_HEIGHT / 2)
                    );
                    if (x !== node.x) node.vx = 0;
                    if (y !== node.y) node.vy = 0;
                    node.x = x;
                    node.y = y;
                }
                moved = true;
            }
            return moved;
        },
        get view(): NetworkView {
            return { data, positions: nodes.map((node) => ({ x: node.x ?? 0, y: node.y ?? 0 })) };
        },
        get topologyVersion() {
            return topologyVersion;
        },
        get documentKey() {
            return documentKey;
        },
        get paused() {
            return network.settings.paused;
        },
        stop() {
            simulation.stop();
        }
    };
}
