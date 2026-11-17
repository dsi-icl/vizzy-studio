import { describe, expect, it } from 'bun:test';

import { GSMessageSchema } from '../types';
import { networkFromCsv, parseNetworkCsv, parseNetworkJson } from './import';
import { layoutNetwork } from './layout';
import { networkViewport, segmentIntersectsRect } from './render';
import {
    DEFAULT_NETWORK_SETTINGS,
    EXAMPLE_NETWORK,
    MAX_NETWORK_NODES,
    NetworkSchema
} from './schema';

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
    positions: layoutNetwork(EXAMPLE_NETWORK, DEFAULT_NETWORK_SETTINGS)
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
    });

    it('is deterministic, does not mutate imported data, and accepts isolated/self-linked nodes', () => {
        const before = JSON.stringify(EXAMPLE_NETWORK);
        expect(layoutNetwork(EXAMPLE_NETWORK, DEFAULT_NETWORK_SETTINGS)).toEqual(network.positions);
        expect(JSON.stringify(EXAMPLE_NETWORK)).toBe(before);
        expect(
            layoutNetwork(
                { nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'a' }] },
                DEFAULT_NETWORK_SETTINGS
            )
        ).toEqual([{ x: 500, y: 325 }]);
        expect(NetworkSchema.safeParse(network).success).toBe(true);
    });

    it('changes the saved layout when force settings change', () => {
        expect(
            layoutNetwork(EXAMPLE_NETWORK, { ...DEFAULT_NETWORK_SETTINGS, linkDistance: 200 })
        ).not.toEqual(network.positions);
    });
});

describe('Network screen boundaries', () => {
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
