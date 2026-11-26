import { describe, expect, it } from 'bun:test';

import { drawNetwork, type Rect, type NetworkSelection } from './render';
import { DEFAULT_NETWORK_SETTINGS, NetworkSchema, type Network, type NetworkView } from './schema';

function paintedLabels(
    network: Network,
    view: NetworkView,
    viewport?: Rect,
    selection: NetworkSelection = null
) {
    const labels: Array<{ text: string; x: number; y: number }> = [];
    const noop = () => {};
    const ctx = {
        save: noop,
        restore: noop,
        beginPath: noop,
        rect: noop,
        clip: noop,
        translate: noop,
        scale: noop,
        setLineDash: noop,
        arc: noop,
        fill: noop,
        stroke: noop,
        measureText: () => ({ width: 80 }),
        fillText: (text: string, x: number, y: number) => labels.push({ text, x, y })
    } as unknown as CanvasRenderingContext2D;
    drawNetwork(ctx, network, 1000, 650, viewport, view, selection);
    return labels;
}

describe('Network labels', () => {
    const network = NetworkSchema.parse({
        name: 'Labels',
        source: 'custom',
        data: {
            nodes: [
                { id: 'A', label: 'Health', group: 'Health' },
                { id: 'B', label: 'Environment', group: 'Environment' }
            ],
            edges: []
        },
        settings: { ...DEFAULT_NETWORK_SETTINGS, showLabels: true }
    });
    const view = {
        data: network.data,
        positions: [
            { x: 100, y: 100 },
            { x: 104, y: 100 }
        ]
    };

    it('shows every requested label at a fixed offset, even when labels overlap', () => {
        expect(paintedLabels(network, view)).toEqual([
            { text: 'Health', x: 112, y: 100 },
            { text: 'Environment', x: 116, y: 100 }
        ]);
        expect(
            paintedLabels(
                { ...network, settings: { ...network.settings, labelGroup: 'Health' } },
                view
            )
        ).toEqual([{ text: 'Health', x: 112, y: 100 }]);
        expect(
            paintedLabels(
                { ...network, settings: { ...network.settings, showLabels: false } },
                view,
                undefined,
                { nodeId: 'B' }
            )
        ).toEqual([{ text: 'Environment', x: 116, y: 100 }]);
    });

    it('draws the same fixed label across a screen boundary', () => {
        const single = { ...network, data: { nodes: [network.data.nodes[0]!], edges: [] } };
        const singleView = { data: single.data, positions: [{ x: 100, y: 100 }] };
        expect(paintedLabels(single, singleView, { x: 110, y: 90, w: 12, h: 20 })).toEqual(
            paintedLabels(single, singleView, { x: 122, y: 90, w: 12, h: 20 })
        );
        expect(paintedLabels(single, singleView, { x: 110, y: 90, w: 12, h: 20 })).toHaveLength(1);
    });

    it('uses current node types and labels with existing shared positions', () => {
        const current = {
            ...network,
            data: { nodes: [{ id: 'A', label: 'New label', group: 'Health' }], edges: [] },
            settings: { ...network.settings, labelGroup: 'Health' }
        };
        expect(
            paintedLabels(current, {
                data: { nodes: [{ id: 'A', label: 'Old label', group: 'Environment' }], edges: [] },
                positions: [{ x: 100, y: 100 }]
            })
        ).toEqual([{ text: 'New label', x: 112, y: 100 }]);
    });
});
