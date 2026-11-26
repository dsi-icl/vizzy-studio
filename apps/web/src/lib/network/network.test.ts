import { describe, expect, it, spyOn } from 'bun:test';

import { GSMessageSchema } from '../types';
import { initialNetworkPositions, networkDocumentKey } from './document';
import {
    encodeNetworkFrame,
    decodeNetworkFrame,
    NetworkFrameBuffer,
    type NetworkTopology
} from './frames';
import { networkFromCsv, parseNetworkCsv, parseNetworkJson } from './import';
import { networkEdgeWidth, networkViewport, segmentIntersectsRect } from './render';
import {
    DEFAULT_NETWORK_SETTINGS,
    EXAMPLE_NETWORK,
    MAX_NETWORK_NODES,
    NetworkSchema
} from './schema';
import { createNetworkSimulation } from './simulation';

const config = {
    cx: 500,
    cy: 325,
    width: 1000,
    height: 650,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    visible: true,
    zIndex: 1
};
const network = {
    name: 'Example',
    data: EXAMPLE_NETWORK,
    settings: DEFAULT_NETWORK_SETTINGS,
    source: 'import' as const,
    reheat: 0,
    positions: initialNetworkPositions(EXAMPLE_NETWORK)
};

describe('Network data import', () => {
    it('maps arbitrary CSV headings, quoted IDs, BOM and repeated nodes', () => {
        const table = parseNetworkCsv(
            '\uFEFFPerson,Colleague,Count\r\n"Alice, A",Bob,2\r\nBob,Carol,\r\n"Alice, A",Carol,4\r\n'
        );
        const data = networkFromCsv(table, {
            source: 'Person',
            target: 'Colleague',
            weight: 'Count'
        });
        expect(data.nodes.map((node) => node.id)).toEqual(['Alice, A', 'Bob', 'Carol']);
        expect(data.edges[0]).toEqual({ source: 'Alice, A', target: 'Bob', weight: 2 });
        expect(data.edges[1]?.weight).toBeUndefined();
    });

    it('supports quoted newlines and escaped quotes', () => {
        const table = parseNetworkCsv('source,target\n"a\nnew line","b ""quoted"""');
        const data = networkFromCsv(table, { source: 'source', target: 'target', weight: '' });
        expect(data.edges[0]).toEqual({ source: 'a\nnew line', target: 'b "quoted"' });
    });

    it('rejects ambiguous columns, incomplete rows, missing endpoints and invalid weights', () => {
        expect(() => parseNetworkCsv('a,a\nx,y')).toThrow();
        expect(() => parseNetworkCsv('a,b\nx,y,z')).toThrow();
        expect(() =>
            networkFromCsv(parseNetworkCsv('a,b\nx,y'), { source: 'a', target: 'a', weight: '' })
        ).toThrow();
        expect(() =>
            networkFromCsv(parseNetworkCsv('a,b\nx,'), { source: 'a', target: 'b', weight: '' })
        ).toThrow();
        expect(() =>
            networkFromCsv(parseNetworkCsv('a,b,w\nx,y,NaN'), {
                source: 'a',
                target: 'b',
                weight: 'w'
            })
        ).toThrow();
    });

    it('preserves JSON labels/groups, supports links, and rejects dangling/duplicate IDs', () => {
        const data = parseNetworkJson(
            JSON.stringify({
                nodes: [{ id: 'a', label: 'Alice', group: 'Team' }, { id: 'b' }],
                links: [{ source: 'a', target: 'b' }]
            })
        );
        expect(data.nodes[0]?.label).toBe('Alice');
        expect(() =>
            parseNetworkJson('{"nodes":[{"id":"a"}],"edges":[{"source":"a","target":"b"}]}')
        ).toThrow('Unknown node');
        expect(() => parseNetworkJson('{"nodes":[{"id":"a"},{"id":"a"}],"edges":[]}')).toThrow(
            'Duplicate node'
        );
        expect(() => parseNetworkJson('[]')).toThrow();
        expect(() => parseNetworkJson('{bad')).toThrow('Invalid JSON');
    });

    it('bounds input size and node count before layout', () => {
        expect(() => parseNetworkJson(' '.repeat(2 * 1024 * 1024 + 1))).toThrow('2 MB');
        expect(() =>
            parseNetworkJson(
                JSON.stringify({
                    nodes: Array.from({ length: MAX_NETWORK_NODES + 1 }, (_, i) => ({
                        id: String(i)
                    })),
                    edges: []
                })
            )
        ).toThrow();
    });
});

describe('Network document and layout', () => {
    it('serializes graph coordinates through the same layer/bus schema as other native layers', () => {
        const layer = { numericId: 10, type: 'graph', config, network };
        expect(
            GSMessageSchema.parse(JSON.parse(JSON.stringify({ type: 'hydrate', layers: [layer] })))
        ).toMatchObject({ layers: [layer] });
        expect(
            GSMessageSchema.parse({ type: 'upsert_layer', origin: 'editor:test_network', layer })
        ).toMatchObject({ layer });
        const influence = {
            activeNodeId: 'Vizzy',
            values: { Vizzy: 72 },
            propagation: 1
        };
        const delta = GSMessageSchema.parse({
            type: 'network_influence',
            numericId: 10,
            influence
        });
        expect(delta).toMatchObject({ numericId: 10, influence });
        expect(JSON.stringify(delta).length).toBeLessThan(
            JSON.stringify({ type: 'upsert_layer', origin: 'editor:test_network', layer }).length
        );
        expect(
            GSMessageSchema.safeParse({
                type: 'network_influence',
                numericId: 10,
                influence: { ...influence, values: { Vizzy: 101 } }
            }).success
        ).toBe(false);
        expect(
            GSMessageSchema.safeParse({
                type: 'hydrate',
                layers: [{ numericId: 10, type: 'graph', config }]
            }).success
        ).toBe(true);
    });

    it('rejects mismatched coordinates, non-finite positions, and unsafe settings', () => {
        expect(NetworkSchema.safeParse({ ...network, positions: [] }).success).toBe(false);
        expect(
            NetworkSchema.safeParse({
                ...network,
                positions: network.positions.map(() => ({ x: NaN, y: 1 }))
            }).success
        ).toBe(false);
        expect(
            NetworkSchema.safeParse({
                ...network,
                settings: { ...network.settings, charge: -Infinity }
            }).success
        ).toBe(false);
        expect(
            NetworkSchema.safeParse({
                ...network,
                nodeMove: { nodeId: 'missing', x: 200, y: 100, revision: 1 }
            }).success
        ).toBe(false);
    });

    it('keeps moving across ticks without mutating imported data, and reheats after settling', () => {
        const before = JSON.stringify(network);
        const still = { ...network, settings: { ...network.settings, motionStrength: 0 } };
        const sim = createNetworkSimulation(still);
        sim.advance(1000);
        const first = sim.view.positions;
        sim.advance(1050);
        expect(sim.view.positions).not.toEqual(first);
        for (let i = 0; i < 200; i++) sim.advance(1100 + i * 50);
        expect(sim.advance(12000)).toBe(false);
        const settled = sim.view.positions;
        sim.configure({ ...still, settings: { ...still.settings, linkDistance: 200 } });
        expect(sim.advance(12100)).toBe(true);
        expect(sim.view.positions).not.toEqual(settled);
        expect(JSON.stringify(network)).toBe(before);
        expect(sim.view.data.nodes).toHaveLength(12);
        sim.stop();
    });

    it('keeps a fixed dataset moving after it would normally cool, without new events', () => {
        for (const source of ['live-example', 'import', 'custom'] as const) {
            const live = { ...network, source };
            const sim = createNetworkSimulation(live);
            for (let i = 0; i < 1200; i++) sim.advance(i * 50);
            const before = sim.view.positions;
            expect(sim.advance(60050)).toBe(true);
            expect(sim.view.positions).not.toEqual(before);
            expect(sim.view.data).toEqual(EXAMPLE_NETWORK);
            expect(sim.topologyVersion).toBe(1);
            const paused = { ...live, settings: { ...live.settings, paused: true } };
            sim.configure(paused);
            sim.advance(60100);
            const frozen = sim.view;
            for (let i = 0; i < 100; i++) sim.advance(60150 + i * 50);
            expect(sim.view).toEqual(frozen);
            sim.configure(live);
            sim.advance(66000);
            expect(sim.view.positions).not.toEqual(frozen.positions);
            sim.stop();
        }
    });

    it('uses a paused preview snapshot when an existing layer is frozen', () => {
        const { positions: _positions, ...live } = network;
        const sim = createNetworkSimulation(live);
        for (let i = 0; i < 10; i++) sim.advance(i * 50);
        const snapshot = live.data.nodes.map((_, i) => ({ x: 80 + i * 25, y: 100 + i * 20 }));
        const paused = {
            ...live,
            settings: { ...live.settings, paused: true },
            positions: snapshot
        };
        const previousVersion = sim.topologyVersion;
        sim.configure(paused);
        expect(sim.topologyVersion).toBeGreaterThan(previousVersion);
        expect(sim.view.positions).toEqual(snapshot);
        for (let i = 0; i < 10; i++) sim.advance(1000 + i * 50);
        expect(sim.view.positions).toEqual(snapshot);
        sim.configure({ ...paused, settings: { ...paused.settings, linkDistance: 180 } });
        expect(sim.view.positions).toEqual(snapshot);
        sim.stop();
    });

    it('moves one node without restarting the layout, then resumes the force simulation', () => {
        const running = { ...network, settings: { ...network.settings, motionStrength: 0 } };
        const sim = createNetworkSimulation(running);
        sim.advance(1000);
        const before = sim.view.positions;
        const version = sim.topologyVersion;
        const moved = {
            ...running,
            nodeMove: { nodeId: 'Vizzy', x: 800, y: 500, revision: 1 }
        };
        expect(networkDocumentKey(moved)).not.toBe(networkDocumentKey(running));
        sim.configure(moved);
        expect(sim.view.positions[0]).toEqual({ x: 800, y: 500 });
        expect(sim.view.positions.slice(1)).toEqual(before.slice(1));
        expect(sim.topologyVersion).toBe(version);
        sim.advance(1050);
        expect(sim.view.positions[0]).not.toEqual({ x: 800, y: 500 });
        sim.stop();
    });

    it('can turn continuous motion off, nudge settled nodes, and keep strong motion bounded', () => {
        const quiet = { ...network, settings: { ...network.settings, motionStrength: 0 } };
        const sim = createNetworkSimulation(quiet);
        for (let i = 0; i < 200; i++) sim.advance(i * 50);
        expect(sim.advance(11000)).toBe(false);
        const resting = sim.view.positions;
        sim.configure({ ...quiet, reheat: 1 });
        sim.advance(11100);
        expect(
            sim.view.positions.some(
                (p, i) => Math.hypot(p.x - resting[i]!.x, p.y - resting[i]!.y) > 1
            )
        ).toBe(true);
        sim.configure({ ...network, settings: { ...network.settings, motionStrength: 2 } });
        for (let i = 0; i < 1200; i++) sim.advance(12000 + i * 50);
        expect(
            sim.view.positions.every(
                (p) =>
                    Number.isFinite(p.x) &&
                    Number.isFinite(p.y) &&
                    p.x >= 0 &&
                    p.x <= 1000 &&
                    p.y >= 0 &&
                    p.y <= 650
            )
        ).toBe(true);
        expect(sim.view.data).toEqual(EXAMPLE_NETWORK);
        sim.stop();
    });

    it('uses the same document key after schema parsing reorders settings', () => {
        expect(networkDocumentKey(network)).toBe(networkDocumentKey(NetworkSchema.parse(network)));
    });

    it('keeps visual changes on the same frame stream without reheating the layout', () => {
        const quiet = { ...network, settings: { ...network.settings, motionStrength: 0 } };
        const sim = createNetworkSimulation(quiet);
        for (let i = 0; i < 200; i++) sim.advance(i * 50);
        expect(sim.advance(11000)).toBe(false);
        const resting = sim.view.positions;
        const visual = {
            ...quiet,
            source: 'custom' as const,
            data: {
                nodes: quiet.data.nodes.map((node, index) =>
                    index === 0 ? { ...node, label: 'Renamed', group: 'New type' } : node
                ),
                edges: quiet.data.edges.map((edge, index) =>
                    index === 0 ? { ...edge, influence: 4 } : edge
                )
            },
            settings: {
                ...quiet.settings,
                colorByGroup: true,
                showLabels: true,
                nodeColor: '#ff0000',
                labelColor: '#00ff00',
                edgeColor: '#0000ff',
                edgeWidth: 3
            }
        };
        expect(networkDocumentKey(visual)).toBe(networkDocumentKey(quiet));
        sim.configure(visual);
        expect(sim.advance(11050)).toBe(false);
        expect(sim.view.positions).toEqual(resting);
        expect(
            networkDocumentKey({
                ...visual,
                settings: { ...visual.settings, linkDistance: 200 }
            })
        ).not.toBe(networkDocumentKey(visual));
        sim.stop();
    });

    it('stores white nodes and links without a layer background or runtime coordinates', () => {
        const { positions: _positions, ...document } = network;
        expect(NetworkSchema.parse(document).positions).toBeUndefined();
        expect(NetworkSchema.parse(document).settings).toMatchObject({
            nodeColor: '#ffffff',
            edgeColor: '#ffffff',
            colorByGroup: false,
            showLabels: false
        });
        expect(
            NetworkSchema.parse({
                ...document,
                settings: { ...document.settings, background: '#123456' }
            }).settings
        ).not.toHaveProperty('background');
    });
});

describe('Network screen boundaries', () => {
    it('uses matrix magnitude for line thickness while keeping explicit zero visible', () => {
        const edge = { source: 'a', target: 'b' };
        const width = (influence: number) =>
            networkEdgeWidth({ ...edge, influence }, DEFAULT_NETWORK_SETTINGS);
        expect(width(0)).toBeGreaterThan(0);
        expect(width(0)).toBeLessThan(width(1));
        expect(width(1)).toBeLessThan(width(5));
        expect(width(-5)).toBe(width(5));
        expect(networkEdgeWidth(edge, DEFAULT_NETWORK_SETTINGS)).toBe(
            DEFAULT_NETWORK_SETTINGS.edgeWidth
        );
    });
    const viewport = { x: 100, y: 100, w: 100, h: 100 };
    it('retains a crossing link with both endpoints outside the screen', () => {
        expect(segmentIntersectsRect({ x: 0, y: 150 }, { x: 300, y: 150 }, viewport)).toBe(true);
        expect(segmentIntersectsRect({ x: 0, y: 0 }, { x: 300, y: 300 }, viewport)).toBe(true);
        expect(segmentIntersectsRect({ x: 0, y: 90 }, { x: 300, y: 90 }, viewport)).toBe(false);
        expect(segmentIntersectsRect({ x: 0, y: 99 }, { x: 300, y: 99 }, viewport, 2)).toBe(true);
    });
    it('uses adjacent pieces of the same world, including resize and rotation', () => {
        expect(networkViewport(config, { x: 0, y: 0, w: 500, h: 650 })).toEqual({
            x: 0,
            y: 0,
            w: 500,
            h: 650
        });
        expect(networkViewport(config, { x: 500, y: 0, w: 500, h: 650 })).toEqual({
            x: 500,
            y: 0,
            w: 500,
            h: 650
        });
        expect(
            networkViewport(
                { ...config, scaleX: 2, scaleY: 2 },
                { x: -500, y: -325, w: 2000, h: 1300 }
            )
        ).toEqual({ x: 0, y: 0, w: 1000, h: 650 });
        const rotated = networkViewport(
            { ...config, rotation: 90 },
            { x: 175, y: -175, w: 650, h: 1000 }
        );
        expect(rotated.x).toBeCloseTo(0);
        expect(rotated.y).toBeCloseTo(0);
        expect(rotated.w).toBeCloseTo(1000);
        expect(rotated.h).toBeCloseTo(650);
    });
});

describe('Shared network frames', () => {
    const topology: NetworkTopology = {
        type: 'network_topology',
        scopeKey: 'scope-a',
        scopeId: 1,
        numericId: 10,
        epoch: 22,
        topologyVersion: 3,
        documentKey: networkDocumentKey(network),
        data: { nodes: [{ id: 'a' }], edges: [] }
    };
    const packet = (sequence: number, time: number, x: number) =>
        encodeNetworkFrame({
            scopeId: 1,
            numericId: 10,
            epoch: 22,
            sequence,
            topologyVersion: 3,
            serverTime: time,
            positions: [{ x, y: 30 }]
        });
    it('interpolates every screen on the same timeline regardless of arrival times', () => {
        const left = new NetworkFrameBuffer(() => 1125),
            right = new NetworkFrameBuffer(() => 1125);
        for (const tile of [left, right]) {
            tile.setScope('scope-a');
            tile.topology(topology);
            tile.receive(packet(1, 1000, 10));
        }
        left.receive(packet(2, 1050, 20));
        right.receive(packet(2, 1050, 20));
        expect(left.sample(10, topology.documentKey)?.view.positions).toEqual([{ x: 15, y: 30 }]);
        expect(right.sample(10, topology.documentKey)).toEqual(
            left.sample(10, topology.documentKey)
        );
        expect(left.sample(10, 'changed-settings')).toBeNull();
        left.setScope('scope-b');
        left.topology(topology);
        left.receive(packet(3, 1100, 30));
        expect(left.sample(10, topology.documentKey)).toBeNull();
    });
    it('lets editor fallback detect stale arrivals without changing the wall timeline', () => {
        const clock = spyOn(performance, 'now').mockReturnValue(100);
        try {
            const frames = new NetworkFrameBuffer(() => 1200);
            frames.setScope('scope-a');
            frames.topology(topology);
            frames.receive(packet(1, 1000, 10));
            expect(frames.sample(10, topology.documentKey, undefined, 2500)).not.toBeNull();
            clock.mockReturnValue(3000);
            expect(frames.sample(10, topology.documentKey, undefined, 2500)).toBeNull();
            expect(frames.sample(10, topology.documentKey)?.view.positions[0]?.x).toBe(10);
            frames.receive(packet(2, 1100, 20));
            expect(
                frames.sample(10, topology.documentKey, undefined, 2500)?.view.positions[0]?.x
            ).toBe(20);
        } finally {
            clock.mockRestore();
        }
    });
    it('rejects truncated, non-finite, stale and mismatched frames', () => {
        expect(decodeNetworkFrame(new ArrayBuffer(3))).toBeNull();
        const broken = packet(1, 1000, NaN);
        expect(decodeNetworkFrame(broken)).toBeNull();
        const frames = new NetworkFrameBuffer(() => 1300);
        frames.setScope('scope-a');
        frames.topology(topology);
        frames.receive(packet(2, 1050, 20));
        frames.receive(packet(1, 1000, 10));
        const wrong = packet(3, 1100, 50);
        new DataView(wrong).setUint32(13, 99, true);
        frames.receive(wrong);
        expect(frames.sample(10, topology.documentKey)?.view.positions[0]?.x).toBe(20);
        frames.topology({ ...topology, epoch: 99 });
        expect(frames.sample(10, topology.documentKey)).toBeNull();
        frames.receive(wrong);
        expect(frames.sample(10, topology.documentKey)?.view.positions[0]?.x).toBe(50);
        frames.remove(10);
        expect(frames.sample(10, topology.documentKey)).toBeNull();
    });
});
