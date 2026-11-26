import { describe, expect, it } from 'bun:test';

import { Window } from 'happy-dom';
import JSZip from 'jszip';

import { networkDocumentKey } from './document';
import { networkInfluenceValues, networkNodeRadius } from './influence';
import { hitTestNetwork } from './interaction';
import { drawNetwork } from './render';
import { DEFAULT_NETWORK_SETTINGS, NetworkSchema } from './schema';
import { networkFromMatrixCells, parseNetworkXlsx } from './xlsx';

describe('Excel relationship matrix', () => {
    it('keeps zero as a neutral edge, omits blanks, and applies signed one-hop feedback', () => {
        const data = networkFromMatrixCells([
            { row: 1, column: 2, text: 'Driver' },
            { row: 1, column: 3, text: 'Positive' },
            { row: 1, column: 4, text: 'Neutral' },
            { row: 1, column: 5, text: 'Absent' },
            { row: 1, column: 6, text: 'Negative' },
            ...['Driver', 'Positive', 'Neutral', 'Absent', 'Negative'].map((text, i) => ({
                row: i + 2,
                column: 1,
                text
            })),
            { row: 3, column: 2, text: '5' },
            { row: 4, column: 2, text: '0' },
            { row: 6, column: 2, text: '-4' }
        ]);
        expect(data.edges).toEqual([
            { source: 'Positive', target: 'Driver', influence: 5 },
            { source: 'Neutral', target: 'Driver', influence: 0 },
            { source: 'Negative', target: 'Driver', influence: -4 }
        ]);
        const network = NetworkSchema.parse({
            name: 'Matrix',
            source: 'import',
            data,
            settings: DEFAULT_NETWORK_SETTINGS,
            influence: {
                activeNodeId: 'Driver',
                values: { Driver: 80, Neutral: 20 },
                propagation: 1
            }
        });
        const values = networkInfluenceValues(network);
        expect(values.get('Driver')).toBe(80);
        expect(values.get('Positive')).toBe(100);
        expect(values.get('Negative')).toBe(0);
        expect(values.get('Neutral')).toBe(20);
        expect(values.get('Absent')).toBe(50);
        expect(networkNodeRadius(network, values.get('Positive')!)).toBeGreaterThan(
            networkNodeRadius(network, values.get('Negative')!)
        );
        expect(networkDocumentKey(network)).toBe(
            networkDocumentKey({
                ...network,
                influence: { ...network.influence!, values: { Driver: 10 } }
            })
        );
    });

    it('imports a workbook sheet with shared strings and finds its matrix', async () => {
        const zip = new JSZip();
        zip.file(
            'xl/sharedStrings.xml',
            '<sst><si><t>A</t></si><si><t>B</t></si><si><t>C</t></si></sst>'
        );
        zip.file(
            'xl/worksheets/sheet1.xml',
            '<worksheet><sheetData><row r="1"><c r="B1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>0</v></c></row><row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><v>0</v></c></row><row r="4"><c r="A4" t="s"><v>2</v></c><c r="B4"><v>-2</v></c></row></sheetData></worksheet>'
        );
        const bytes = await zip.generateAsync({ type: 'uint8array' });
        const previous = globalThis.DOMParser;
        globalThis.DOMParser = new Window().DOMParser as unknown as typeof DOMParser;
        try {
            const result = await parseNetworkXlsx(new Blob([bytes.slice().buffer as ArrayBuffer]));
            expect(result.data.nodes.map((node) => node.id)).toEqual(['A', 'B', 'C']);
            expect(result.data.edges).toEqual([
                { source: 'B', target: 'A', influence: 0 },
                { source: 'C', target: 'A', influence: -2 }
            ]);
            expect(result.influence.activeNodeId).toBe('A');
        } finally {
            globalThis.DOMParser = previous;
        }
    });

    it('uses independently chosen colours for positive, negative and zero links', () => {
        const network = NetworkSchema.parse({
            name: 'Link colours',
            source: 'import',
            data: {
                nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
                edges: [
                    { source: 'A', target: 'B', influence: 2 },
                    { source: 'A', target: 'C', influence: -3 },
                    { source: 'A', target: 'D', influence: 0 },
                    { source: 'B', target: 'D' }
                ]
            },
            settings: {
                ...DEFAULT_NETWORK_SETTINGS,
                edgeColor: '#abcdef',
                relationshipColors: {
                    positive: '#112233',
                    negative: '#445566',
                    neutral: '#778899'
                }
            }
        });
        const strokes: string[] = [];
        let currentStroke = '';
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
            moveTo: noop,
            lineTo: noop,
            arc: noop,
            fill: noop,
            set strokeStyle(value: string) {
                currentStroke = value;
            },
            stroke: () => strokes.push(currentStroke)
        } as unknown as CanvasRenderingContext2D;
        drawNetwork(ctx, network, 1000, 650, undefined, {
            data: network.data,
            positions: [
                { x: 100, y: 100 },
                { x: 200, y: 100 },
                { x: 100, y: 200 },
                { x: 200, y: 200 }
            ]
        });
        expect(strokes).toEqual(['#112233', '#445566', '#778899', '#abcdef']);
        expect(networkDocumentKey(network)).toBe(
            networkDocumentKey({
                ...network,
                settings: {
                    ...network.settings,
                    relationshipColors: {
                        ...network.settings.relationshipColors,
                        positive: '#fedcba'
                    }
                }
            })
        );
    });

    it('hides filtered nodes and their links from paint and hit testing without changing physics', () => {
        const network = NetworkSchema.parse({
            name: 'Filtered matrix',
            source: 'import',
            data: {
                nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
                edges: [
                    { source: 'A', target: 'B', influence: 1 },
                    { source: 'A', target: 'C', influence: 0 }
                ]
            },
            settings: DEFAULT_NETWORK_SETTINGS,
            influence: { activeNodeId: 'A', values: {}, propagation: 1, visibleNodeIds: ['A', 'B'] }
        });
        const view = {
            data: network.data,
            positions: [
                { x: 100, y: 100 },
                { x: 200, y: 100 },
                { x: 100, y: 200 }
            ]
        };
        const calls: string[] = [];
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
            moveTo: noop,
            lineTo: noop,
            arc: () => calls.push('arc'),
            stroke: () => calls.push('stroke'),
            fill: noop,
            measureText: () => ({ width: 0 })
        } as unknown as CanvasRenderingContext2D;
        drawNetwork(ctx, network, 1000, 650, undefined, view);
        expect(calls.filter((call) => call === 'stroke')).toHaveLength(1);
        expect(calls.filter((call) => call === 'arc')).toHaveLength(2);
        expect(
            hitTestNetwork(view, network.settings, { x: 100, y: 200, scale: 1 }, network)
        ).toBeNull();
        expect(
            hitTestNetwork(view, network.settings, { x: 100, y: 190, scale: 1 }, network)
        ).toBeNull();
        expect(
            hitTestNetwork(view, network.settings, { x: 200, y: 100, scale: 1 }, network)
        ).toEqual({ nodeId: 'B' });
        expect(networkDocumentKey(network)).toBe(
            networkDocumentKey({
                ...network,
                influence: { ...network.influence!, visibleNodeIds: undefined }
            })
        );
        expect(() =>
            NetworkSchema.parse({
                ...network,
                influence: { ...network.influence!, visibleNodeIds: ['A', 'A'] }
            })
        ).toThrow();
    });
});
