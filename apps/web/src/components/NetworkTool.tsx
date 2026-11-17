import { GraphIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import { Button } from '@repo/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@repo/ui/components/dialog';
import { Input } from '@repo/ui/components/input';
import { TipButton } from '@repo/ui/components/tip-button';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { useEditorStore } from '~/lib/editorStore';
import {
    networkFromCsv,
    parseNetworkCsv,
    parseNetworkJson,
    type CsvMapping,
    type CsvTable
} from '~/lib/network/import';
import { drawNetwork, NETWORK_COLORS } from '~/lib/network/render';
import {
    DEFAULT_NETWORK_SETTINGS,
    EXAMPLE_NETWORK,
    MAX_NETWORK_FILE_BYTES,
    NetworkSchema,
    type Network,
    type NetworkData,
    type NetworkSettings
} from '~/lib/network/schema';
import type { Layer } from '~/lib/types';

function layoutKey(settings: NetworkSettings) {
    return JSON.stringify([
        settings.charge,
        settings.linkDistance,
        settings.linkStrength,
        settings.collisionRadius,
        settings.nodeRadius
    ]);
}

function NetworkEditor({
    initial,
    onClose,
    onSave
}: {
    initial?: Network;
    onClose: () => void;
    onSave: (network: Network) => void;
}) {
    const [name, setName] = useState(initial?.name ?? 'Example network');
    const [data, setData] = useState<NetworkData>(initial?.data ?? EXAMPLE_NETWORK);
    const [settings, setSettings] = useState<NetworkSettings>(
        initial?.settings ?? DEFAULT_NETWORK_SETTINGS
    );
    const [table, setTable] = useState<CsvTable | null>(null);
    const [mapping, setMapping] = useState<CsvMapping>({ source: '', target: '', weight: '' });
    const [error, setError] = useState('');
    const [reading, setReading] = useState(false);
    const [result, setResult] = useState<{
        data: NetworkData;
        key: string;
        positions?: Network['positions'];
        error?: string;
    } | null>(
        initial
            ? { data: initial.data, key: layoutKey(initial.settings), positions: initial.positions }
            : null
    );
    const fileRef = useRef<HTMLInputElement>(null);
    const readVersion = useRef(0);
    const nameId = useId();
    const simulationSettings = useMemo(
        () => ({
            ...DEFAULT_NETWORK_SETTINGS,
            charge: settings.charge,
            linkDistance: settings.linkDistance,
            linkStrength: settings.linkStrength,
            collisionRadius: settings.collisionRadius,
            nodeRadius: settings.nodeRadius
        }),
        [
            settings.charge,
            settings.linkDistance,
            settings.linkStrength,
            settings.collisionRadius,
            settings.nodeRadius
        ]
    );
    const key = layoutKey(settings);
    const currentResult = useMemo(
        () =>
            initial?.data === data && layoutKey(initial.settings) === key
                ? { positions: initial.positions, error: undefined }
                : result?.data === data && result.key === key
                  ? result
                  : null,
        [initial, data, key, result]
    );
    const busy = !currentResult;
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        // A worker owns the force simulation. Changing data/settings cancels old work.
        if (initial?.data === data && layoutKey(initial.settings) === key) {
            return;
        }
        let worker: Worker | undefined;
        let cancelled = false;
        const timer = setTimeout(() => {
            try {
                worker = new Worker(new URL('../lib/network/layout.worker.ts', import.meta.url), {
                    type: 'module'
                });
                worker.onmessage = (
                    event: MessageEvent<{ positions?: Network['positions']; error?: string }>
                ) => {
                    if (!cancelled) setResult({ data, key, ...event.data });
                    worker?.terminate();
                };
                worker.onerror = () => {
                    if (cancelled) return;
                    setResult({
                        data,
                        key,
                        error: 'Layout could not start. Reopen the Network editor to try again.'
                    });
                    worker?.terminate();
                };
                worker.postMessage({ data, settings: simulationSettings });
            } catch {
                setResult({ data, key, error: 'Layout could not start in this browser.' });
            }
        }, 120);
        return () => {
            cancelled = true;
            clearTimeout(timer);
            worker?.terminate();
        };
    }, [data, key, initial, simulationSettings]);

    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!currentResult?.positions) return;
        drawNetwork(
            ctx,
            { name, data, settings, positions: currentResult.positions },
            canvas.width,
            canvas.height
        );
    }, [name, data, settings, currentResult]);

    useEffect(
        () => () => {
            readVersion.current++;
        },
        []
    );

    const useExample = () => {
        readVersion.current++;
        setReading(false);
        setError('');
        setTable(null);
        setData(EXAMPLE_NETWORK);
        setName('Example network');
        if (fileRef.current) fileRef.current.value = '';
    };

    const readFile = async (file: File) => {
        const version = ++readVersion.current;
        setReading(true);
        setError('');
        try {
            if (file.size > MAX_NETWORK_FILE_BYTES)
                throw new Error('Choose a file smaller than 2 MB.');
            const text = await file.text();
            if (version !== readVersion.current) return;
            if (file.name.toLowerCase().endsWith('.csv')) {
                const nextTable = parseNetworkCsv(text);
                const columns = nextTable.headers;
                const nextMapping = {
                    source: columns.find((h) => /^(source|from)$/i.test(h)) ?? columns[0]!,
                    target: columns.find((h) => /^(target|to)$/i.test(h)) ?? columns[1]!,
                    weight: columns.find((h) => /^weight$/i.test(h)) ?? ''
                };
                // Keep the mapping UI available even if the initial guess is invalid.
                setTable(nextTable);
                setMapping(nextMapping);
                setData(networkFromCsv(nextTable, nextMapping));
            } else if (file.name.toLowerCase().endsWith('.json')) {
                setTable(null);
                setData(parseNetworkJson(text));
            } else throw new Error('Choose a .csv or .json file.');
            setName(file.name.replace(/\.(csv|json)$/i, '').slice(0, 100) || 'Network');
        } catch (err) {
            if (version === readVersion.current)
                setError(err instanceof Error ? err.message : 'Could not read this file.');
        } finally {
            if (version === readVersion.current) setReading(false);
        }
    };

    const changeMapping = (field: keyof CsvMapping, value: string) => {
        const next = { ...mapping, [field]: value };
        setMapping(next);
        if (!table) return;
        try {
            setData(networkFromCsv(table, next));
            setError('');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Invalid column mapping.');
        }
    };

    const sliders: {
        field: keyof Pick<
            NetworkSettings,
            | 'charge'
            | 'linkDistance'
            | 'linkStrength'
            | 'collisionRadius'
            | 'nodeRadius'
            | 'edgeWidth'
        >;
        label: string;
        min: number;
        max: number;
        step: number;
    }[] = [
        { field: 'nodeRadius', label: 'Node size', min: 2, max: 20, step: 1 },
        { field: 'edgeWidth', label: 'Line width', min: 0.5, max: 5, step: 0.5 },
        { field: 'charge', label: 'Repulsion', min: -1000, max: 0, step: 10 },
        { field: 'linkDistance', label: 'Link distance', min: 10, max: 300, step: 5 },
        { field: 'linkStrength', label: 'Link strength', min: 0, max: 1, step: 0.05 },
        { field: 'collisionRadius', label: 'Collision spacing', min: 1, max: 80, step: 1 }
    ];
    const renderSlider = ({ field, label, min, max, step }: (typeof sliders)[number]) => (
        <label key={field} className="grid gap-1.5 text-xs">
            <span className="flex justify-between">
                <span>{label}</span>
                <span className="text-muted-foreground tabular-nums">{settings[field]}</span>
            </span>
            <input
                aria-label={label}
                type="range"
                min={min}
                max={max}
                step={step}
                value={settings[field]}
                onChange={(event) =>
                    setSettings((previous) => ({
                        ...previous,
                        [field]: Number(event.target.value)
                    }))
                }
                className="w-full accent-primary"
            />
        </label>
    );
    const groups = [...new Set(data.nodes.map((node) => node.group ?? ''))].sort();

    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open) onClose();
            }}
        >
            <DialogContent className="flex max-h-[90vh] w-[min(1100px,95vw)] flex-col overflow-hidden">
                <div className="border-b px-6 py-4">
                    <DialogTitle>{initial ? 'Edit network' : 'Add network'}</DialogTitle>
                    <DialogDescription>
                        Turn relationships into a graph. Place it on your stage and share it across
                        the wall.
                    </DialogDescription>
                </div>
                <div className="grid min-h-0 gap-6 overflow-auto p-6 md:grid-cols-[270px_minmax(0,1fr)]">
                    <div className="flex flex-col gap-4">
                        <label htmlFor={nameId} className="grid gap-1.5 text-xs font-medium">
                            Layer name
                            <Input
                                id={nameId}
                                maxLength={100}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                            <Button variant="outline" onClick={useExample}>
                                Use example
                            </Button>
                            <Button
                                variant="outline"
                                onClick={() => fileRef.current?.click()}
                                disabled={reading}
                            >
                                <UploadSimpleIcon />
                                {reading ? 'Reading…' : 'Import file'}
                            </Button>
                        </div>
                        <input
                            ref={fileRef}
                            type="file"
                            accept=".csv,.json"
                            aria-label="Network data file"
                            className="sr-only"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) void readFile(file);
                                e.target.value = '';
                            }}
                        />
                        <p className="text-xs text-muted-foreground">
                            CSV or JSON · up to 1,000 nodes and 3,000 links · 2 MB
                        </p>
                        {table && (
                            <fieldset className="grid gap-2 rounded-lg border p-3">
                                <legend className="px-1 text-xs font-medium">CSV columns</legend>
                                {(['source', 'target', 'weight'] as const).map((field) => (
                                    <label className="grid gap-1 text-xs capitalize" key={field}>
                                        {field}
                                        {field === 'weight' ? ' (optional)' : ''}
                                        <select
                                            aria-label={`${field} column`}
                                            value={mapping[field]}
                                            onChange={(event) =>
                                                changeMapping(field, event.target.value)
                                            }
                                            className="h-8 rounded-md border bg-background px-2 text-foreground"
                                        >
                                            {field === 'weight' && <option value="">None</option>}
                                            {table.headers.map((column) => (
                                                <option key={column} value={column}>
                                                    {column}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                ))}
                            </fieldset>
                        )}
                        <details className="text-xs text-muted-foreground">
                            <summary className="cursor-pointer">Data format examples</summary>
                            <p className="mt-2">
                                CSV: each row connects two node IDs. Nodes are created from those
                                IDs.
                            </p>
                            <pre className="my-2 overflow-auto rounded bg-muted p-2">
                                {'source,target,weight\nAlice,Bob,2\nBob,Carol,1'}
                            </pre>
                            <p>
                                JSON: optional labels and groups give nodes names and colours. IDs
                                must be strings; every edge must reference a node.
                            </p>
                            <pre className="mt-2 overflow-auto rounded bg-muted p-2">
                                {
                                    '{\n  "nodes": [\n    {"id":"a","label":"Alice","group":"Team"},\n    {"id":"b","label":"Bob"}\n  ],\n  "edges": [{"source":"a","target":"b"}]\n}'
                                }
                            </pre>
                        </details>
                        <div className="grid gap-3 border-t pt-4">
                            {sliders.slice(0, 2).map(renderSlider)}
                            <label className="flex items-center gap-2 text-xs">
                                <input
                                    type="checkbox"
                                    checked={settings.showLabels}
                                    onChange={(event) =>
                                        setSettings((previous) => ({
                                            ...previous,
                                            showLabels: event.target.checked
                                        }))
                                    }
                                />
                                Show labels
                            </label>
                            <label className="flex items-center justify-between text-xs">
                                Background
                                <input
                                    aria-label="Network background"
                                    type="color"
                                    value={settings.background}
                                    onChange={(event) =>
                                        setSettings((previous) => ({
                                            ...previous,
                                            background: event.target.value
                                        }))
                                    }
                                />
                            </label>
                        </div>
                        <details className="border-t pt-3">
                            <summary className="cursor-pointer text-xs font-medium">
                                Layout settings
                            </summary>
                            <div className="mt-3 grid gap-3">
                                {sliders.slice(2).map(renderSlider)}
                            </div>
                        </details>
                    </div>
                    <div className="min-w-0">
                        <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                            <span>Preview</span>
                            <span>
                                {data.nodes.length} nodes · {data.edges.length} links
                            </span>
                        </div>
                        <div className="relative overflow-hidden rounded-xl border bg-[#101827]">
                            <canvas
                                ref={canvasRef}
                                width={1000}
                                height={650}
                                aria-label="Network preview"
                                className="block aspect-[1000/650] w-full"
                            />
                            {busy && (
                                <output className="absolute inset-0 flex items-center justify-center bg-black/40 text-sm text-white">
                                    Arranging network…
                                </output>
                            )}
                        </div>
                        {groups.some(Boolean) && (
                            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
                                {groups.map((group, index) => (
                                    <span key={group} className="flex items-center gap-1.5">
                                        <span
                                            className="h-2 w-2 rounded-full"
                                            style={{
                                                background:
                                                    NETWORK_COLORS[index % NETWORK_COLORS.length]
                                            }}
                                        />
                                        {group || 'Ungrouped'}
                                    </span>
                                ))}
                            </div>
                        )}
                        <p className="mt-4 text-xs text-muted-foreground">
                            Move, resize and rotate the network on the stage. All screens share the
                            same layout, including links across screen boundaries.
                        </p>
                        {(error || currentResult?.error) && (
                            <p
                                role="alert"
                                className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                            >
                                {error || currentResult?.error}
                            </p>
                        )}
                    </div>
                </div>
                <div className="flex justify-end gap-2 border-t px-6 py-4">
                    <Button variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        disabled={
                            busy || reading || !!error || !currentResult?.positions || !name.trim()
                        }
                        onClick={() => {
                            try {
                                const network = NetworkSchema.parse({
                                    name: name.trim(),
                                    data,
                                    settings,
                                    positions: currentResult?.positions
                                });
                                onSave(network);
                            } catch (err) {
                                setError(
                                    err instanceof Error ? err.message : 'Could not save network.'
                                );
                            }
                        }}
                    >
                        {initial ? 'Apply changes' : 'Add to stage'}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

export function NetworkTool({ layer }: { layer?: Extract<Layer, { type: 'graph' }> }) {
    const scope = useEditorStore((s) => `${s.projectId}/${s.commitId}/${s.activeSlideId}`);
    return <NetworkToolForScope key={scope} layer={layer} scope={scope} />;
}

function NetworkToolForScope({
    layer,
    scope
}: {
    layer?: Extract<Layer, { type: 'graph' }>;
    scope: string;
}) {
    const [draft, setDraft] = useState<{ initial?: Network; scope: string } | null>(null);
    const close = () => setDraft(null);
    return (
        <>
            <TipButton
                tip={layer ? 'Edit network' : 'Add network'}
                aria-label={layer ? 'Edit network' : 'Add network'}
                disabled={!!layer?.config.locked}
                onClick={() => setDraft({ initial: layer?.network, scope })}
            >
                <GraphIcon />
            </TipButton>
            {draft && draft.scope === scope && (
                <NetworkEditor
                    initial={draft.initial}
                    onClose={close}
                    onSave={(network) => {
                        const store = useEditorStore.getState();
                        if (
                            `${store.projectId}/${store.commitId}/${store.activeSlideId}` !==
                            draft.scope
                        )
                            throw new Error('The slide changed. Reopen the Network editor.');
                        if (layer) {
                            const current = store.layers.get(layer.numericId);
                            if (current?.type !== 'graph' || current.config.locked)
                                throw new Error('This network was removed or locked.');
                            store.updateNetworkLayer(layer.numericId, network);
                        } else store.addNetworkLayer(network);
                        close();
                    }}
                />
            )}
        </>
    );
}
