import { csvParseRows } from 'd3-dsv';

import { MAX_NETWORK_FILE_BYTES, NetworkDataSchema, type NetworkData } from './schema';

export type CsvTable = { headers: string[]; rows: string[][] };
export type CsvMapping = { source: string; target: string; weight: string };

export function checkNetworkFileSize(text: string) {
    if (new TextEncoder().encode(text).length > MAX_NETWORK_FILE_BYTES) {
        throw new Error('Choose a CSV or JSON file smaller than 2 MB.');
    }
}

function validate(data: unknown): NetworkData {
    const result = NetworkDataSchema.safeParse(data);
    if (!result.success)
        throw new Error(result.error.issues[0]?.message ?? 'Invalid network data.');
    return result.data;
}

export function parseNetworkJson(text: string): NetworkData {
    checkNetworkFileSize(text);
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new Error('Invalid JSON. Use an object with nodes and edges.');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Use a JSON object with nodes and edges.');
    }
    const obj = raw as Record<string, unknown>;
    return validate({ nodes: obj.nodes, edges: obj.edges ?? obj.links });
}

export function parseNetworkCsv(text: string): CsvTable {
    checkNetworkFileSize(text);
    const table = csvParseRows(text.replace(/^\uFEFF/, ''));
    const headers = table.shift()?.map((cell) => cell.trim()) ?? [];
    if (headers.length < 2 || headers.some((h) => !h) || new Set(headers).size !== headers.length) {
        throw new Error('CSV needs at least two distinct, non-empty column headings.');
    }
    const rows = table.filter((row) => row.some((cell) => cell.trim()));
    if (!rows.length) throw new Error('CSV has no relationships.');
    if (rows.some((row) => row.length !== headers.length)) {
        throw new Error('Each CSV row must have the same number of columns as the header.');
    }
    return { headers, rows };
}

export function networkFromCsv(table: CsvTable, mapping: CsvMapping): NetworkData {
    const sourceIndex = table.headers.indexOf(mapping.source);
    const targetIndex = table.headers.indexOf(mapping.target);
    const weightIndex = table.headers.indexOf(mapping.weight);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
        throw new Error('Choose different columns for source and target.');
    }
    if (mapping.weight && weightIndex < 0) throw new Error('Choose a valid weight column.');
    const ids = new Set<string>();
    const edges = table.rows.map((row, index) => {
        const source = row[sourceIndex]?.trim() ?? '';
        const target = row[targetIndex]?.trim() ?? '';
        if (!source || !target)
            throw new Error(`Row ${index + 2}: source and target cannot be empty.`);
        ids.add(source);
        ids.add(target);
        const weightText = weightIndex >= 0 ? row[weightIndex]?.trim() : '';
        const weight = weightText ? Number(weightText) : undefined;
        if (weight !== undefined && (!Number.isFinite(weight) || weight <= 0)) {
            throw new Error(`Row ${index + 2}: weight must be a positive number.`);
        }
        return { source, target, ...(weight !== undefined ? { weight } : {}) };
    });
    return validate({ nodes: [...ids].map((id) => ({ id })), edges });
}
