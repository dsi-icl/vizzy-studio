import { describe, expect, it } from 'bun:test';

import {
    MAX_NETWORK_EDGES,
    MAX_NETWORK_NODES,
    NetworkDataSchema,
    type NetworkData
} from './schema';
import { appendNetworkLink, appendNetworkNode, removeNetworkNode } from './topology';

describe('Custom network topology', () => {
    it('allocates stable node IDs without colliding with imported IDs', () => {
        const original: NetworkData = {
            nodes: [{ id: 'node-1' }, { id: 'node-3' }],
            edges: [{ source: 'node-1', target: 'node-3' }]
        };
        const next = appendNetworkNode(original);
        expect(next.nodes.at(-1)).toEqual({ id: 'node-2', label: 'Node 2' });
        expect(original.nodes).toHaveLength(2);
        expect(next.edges).toEqual(original.edges);
        expect(NetworkDataSchema.safeParse(next).success).toBe(true);
    });
    it('removes all incident links, including self links, while preserving unrelated data', () => {
        const data: NetworkData = {
            nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c', label: 'C', group: 'team' }],
            edges: [
                { source: 'a', target: 'b' },
                { source: 'b', target: 'a' },
                { source: 'b', target: 'b' },
                { source: 'a', target: 'c', weight: 3 }
            ]
        };
        const next = removeNetworkNode(data, 'b');
        expect(next.nodes).toEqual([data.nodes[0]!, data.nodes[2]!]);
        expect(next.edges).toEqual([{ source: 'a', target: 'c', weight: 3 }]);
        expect(data.edges).toHaveLength(4);
        expect(NetworkDataSchema.safeParse(next).success).toBe(true);
        expect(removeNetworkNode(data, 'missing')).toBe(data);
        expect(() => removeNetworkNode({ nodes: [{ id: 'a' }], edges: [] }, 'a')).toThrow(
            'at least one node'
        );
    });
    it('accepts disconnected nodes and self links but rejects missing endpoints and limits', () => {
        const data: NetworkData = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [] };
        expect(NetworkDataSchema.safeParse(appendNetworkLink(data, 'a', 'a')).success).toBe(true);
        expect(() => appendNetworkLink(data, 'a', 'missing')).toThrow('existing node');
        expect(() =>
            appendNetworkLink(
                {
                    ...data,
                    edges: Array.from({ length: MAX_NETWORK_EDGES }, () => ({
                        source: 'a',
                        target: 'b'
                    }))
                },
                'a',
                'b'
            )
        ).toThrow('link limit');
        expect(() =>
            appendNetworkNode({
                nodes: Array.from({ length: MAX_NETWORK_NODES }, (_, i) => ({ id: String(i) })),
                edges: []
            })
        ).toThrow('node limit');
    });
});
