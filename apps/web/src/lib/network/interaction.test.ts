import { describe, expect, it } from 'bun:test';

import { hitTestNetwork, networkPointerPosition, networkPreviewView } from './interaction';
import { DEFAULT_NETWORK_SETTINGS, type NetworkView } from './schema';

describe('Network canvas interaction', () => {
    const view: NetworkView = {
        data: {
            nodes: [{ id: 'a' }, { id: 'b' }],
            edges: [
                { source: 'a', target: 'b' },
                { source: 'a', target: 'a' }
            ]
        },
        positions: [
            { x: 100, y: 100 },
            { x: 900, y: 100 }
        ]
    };
    it('maps scaled and letterboxed CSS coordinates back to graph coordinates', () => {
        expect(networkPointerPosition(260, 395, { x: 10, y: 20, w: 500, h: 750 })).toEqual({
            x: 500,
            y: 325,
            scale: 0.5
        });
        expect(networkPointerPosition(15, 25, { x: 10, y: 20, w: 500, h: 750 })).toBeNull();
        const wide = networkPointerPosition(250, 100, { x: 0, y: 0, w: 500, h: 200 });
        expect(wide?.x).toBeCloseTo(500);
        expect(wide?.y).toBeCloseTo(325);
        expect(wide?.scale).toBeCloseTo(200 / 650);
        expect(networkPointerPosition(0, 0, { x: 0, y: 0, w: 0, h: 0 })).toBeNull();
    });
    it('selects nodes ahead of their links and keeps small nodes clickable when scaled down', () => {
        expect(
            hitTestNetwork(view, DEFAULT_NETWORK_SETTINGS, { x: 102, y: 100, scale: 1 })
        ).toEqual({ nodeId: 'a' });
        expect(
            hitTestNetwork(view, DEFAULT_NETWORK_SETTINGS, { x: 130, y: 100, scale: 0.2 })
        ).toEqual({ nodeId: 'a' });
    });
    it('selects line segments and self loops, while empty space clears selection', () => {
        expect(
            hitTestNetwork(view, DEFAULT_NETWORK_SETTINGS, { x: 500, y: 104, scale: 1 })
        ).toEqual({ edgeIndex: 0 });
        expect(
            hitTestNetwork(view, DEFAULT_NETWORK_SETTINGS, { x: 500, y: 110, scale: 1 })
        ).toBeNull();
        expect(
            hitTestNetwork(view, DEFAULT_NETWORK_SETTINGS, { x: 950, y: 100, scale: 1 })
        ).toBeNull();
        expect(
            hitTestNetwork(view, DEFAULT_NETWORK_SETTINGS, { x: 100, y: 74.8, scale: 1 })
        ).toEqual({ edgeIndex: 1 });
    });
    it('picks the topmost overlapping node', () => {
        expect(
            hitTestNetwork(
                {
                    ...view,
                    positions: [
                        { x: 100, y: 100 },
                        { x: 100, y: 100 }
                    ]
                },
                DEFAULT_NETWORK_SETTINGS,
                { x: 100, y: 100, scale: 1 }
            )
        ).toEqual({ nodeId: 'b' });
    });
    it('maps pending topology changes by node ID, so clicks cannot use a deleted or shifted node', () => {
        const next = networkPreviewView(
            {
                nodes: [{ id: 'b', label: 'Renamed' }, { id: 'c' }],
                edges: [{ source: 'b', target: 'c' }]
            },
            view
        );
        expect(next.positions[0]).toEqual({ x: 900, y: 100 });
        expect(next.positions).toHaveLength(2);
        expect(next.data.nodes[0]?.label).toBe('Renamed');
        expect(
            hitTestNetwork(next, DEFAULT_NETWORK_SETTINGS, { x: 900, y: 100, scale: 1 })
        ).toEqual({ nodeId: 'b' });
        expect(
            hitTestNetwork(next, DEFAULT_NETWORK_SETTINGS, { x: 100, y: 100, scale: 1 })
        ).toBeNull();
        expect(view.data.nodes[0]?.id).toBe('a');
    });
});
