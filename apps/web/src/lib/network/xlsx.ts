import JSZip from 'jszip';

import {
    MAX_NETWORK_EDGES,
    MAX_NETWORK_FILE_BYTES,
    MAX_NETWORK_NODES,
    NetworkDataSchema,
    type Network,
    type NetworkData
} from './schema';

type Cell = { row: number; column: number; text: string };

function xml(text: string): Document {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length)
        throw new Error('The Excel workbook contains invalid XML.');
    return doc;
}

function columnIndex(ref: string): number {
    let index = 0;
    for (const letter of ref.toUpperCase()) index = index * 26 + letter.charCodeAt(0) - 64;
    return index;
}

function cellText(cell: Element, sharedStrings: string[]): string {
    const kind = cell.getAttribute('t');
    if (kind === 'inlineStr')
        return [...cell.getElementsByTagName('t')].map((part) => part.textContent ?? '').join('');
    const value = cell.getElementsByTagName('v')[0]?.textContent ?? '';
    return kind === 's' ? (sharedStrings[Number(value)] ?? '') : value;
}

/** Read a square, labelled relationship matrix. Zero is an edge; blank is not. */
export function networkFromMatrixCells(cells: Cell[]): NetworkData {
    const byAddress = new Map(
        cells.map(({ row, column, text }) => [`${row}:${column}`, text.trim()])
    );
    const at = (row: number, column: number) => byAddress.get(`${row}:${column}`) ?? '';
    const labels: string[] = [];
    for (let column = 2; column <= MAX_NETWORK_NODES + 1; column++) {
        const label = at(1, column);
        if (!label) break;
        labels.push(label);
    }
    if (labels.length < 2) throw new Error('Excel needs a labelled relationship matrix.');
    if (new Set(labels).size !== labels.length)
        throw new Error('Matrix column labels must be unique.');
    for (let i = 0; i < labels.length; i++) {
        if (at(i + 2, 1) !== labels[i])
            throw new Error(`Matrix row ${i + 2} does not match its column label.`);
    }
    const edges: NetworkData['edges'] = [];
    for (let i = 1; i < labels.length; i++) {
        for (let j = 0; j < i; j++) {
            const lower = at(i + 2, j + 2);
            const upper = at(j + 2, i + 2);
            if (lower && upper && Number(lower) !== Number(upper))
                throw new Error(`Conflicting values for ${labels[i]} and ${labels[j]}.`);
            const raw = lower || upper;
            if (!raw) continue;
            const influence = Number(raw);
            if (!Number.isFinite(influence) || influence < -5 || influence > 5)
                throw new Error(`Relationship ${labels[i]} → ${labels[j]} must be from -5 to 5.`);
            edges.push({ source: labels[i]!, target: labels[j]!, influence });
            if (edges.length > MAX_NETWORK_EDGES)
                throw new Error(`Matrix has more than ${MAX_NETWORK_EDGES} relationships.`);
        }
    }
    return NetworkDataSchema.parse({ nodes: labels.map((id) => ({ id })), edges });
}

export async function parseNetworkXlsx(file: Blob): Promise<{
    data: NetworkData;
    influence: NonNullable<Network['influence']>;
}> {
    if (file.size > MAX_NETWORK_FILE_BYTES)
        throw new Error('Choose an Excel file smaller than 2 MB.');
    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(await file.arrayBuffer());
    } catch {
        throw new Error('Could not open this .xlsx workbook.');
    }
    const sharedXml = zip.file('xl/sharedStrings.xml');
    const sharedStrings = sharedXml
        ? [...xml(await sharedXml.async('text')).getElementsByTagName('si')].map((item) =>
              [...item.getElementsByTagName('t')].map((part) => part.textContent ?? '').join('')
          )
        : [];
    const sheets = Object.keys(zip.files)
        .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
        .sort(
            (a, b) => Number(a.match(/\d+(?=\.xml$)/)?.[0]) - Number(b.match(/\d+(?=\.xml$)/)?.[0])
        );
    let failure: Error | undefined;
    for (const path of sheets) {
        const sheet = zip.file(path);
        if (!sheet) continue;
        const source = await sheet.async('text');
        if (source.length > 10 * 1024 * 1024) throw new Error('Excel sheet is too large.');
        const cells: Cell[] = [];
        for (const cell of xml(source).getElementsByTagName('c')) {
            const ref = cell.getAttribute('r')?.match(/^([A-Z]+)(\d+)$/i);
            if (ref)
                cells.push({
                    row: Number(ref[2]),
                    column: columnIndex(ref[1]!),
                    text: cellText(cell, sharedStrings)
                });
        }
        try {
            const data = networkFromMatrixCells(cells);
            return {
                data,
                influence: { activeNodeId: data.nodes[0]!.id, values: {}, propagation: 1 }
            };
        } catch (cause) {
            failure ??= cause instanceof Error ? cause : new Error('Invalid matrix.');
        }
    }
    throw failure ?? new Error('Excel workbook has no relationship matrix.');
}
