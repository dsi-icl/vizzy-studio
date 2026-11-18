import {
    GraphIcon,
    UploadSimpleIcon,
    SlidersHorizontalIcon,
    PaletteIcon
} from '@phosphor-icons/react';
import { Button } from '@repo/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@repo/ui/components/dialog';
import { Input } from '@repo/ui/components/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@repo/ui/components/tabs';
import { TipButton } from '@repo/ui/components/tip-button';
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';

import { useEditorStore } from '~/lib/editorStore';
import {
    networkFromCsv,
    parseNetworkCsv,
    parseNetworkJson,
    type CsvMapping,
    type CsvTable
} from '~/lib/network/import';
import {
    hitTestNetwork,
    networkPointerPosition,
    networkPreviewView
} from '~/lib/network/interaction';
import { drawNetwork, type NetworkSelection } from '~/lib/network/render';
import {
    DEFAULT_NETWORK_SETTINGS,
    EXAMPLE_NETWORK,
    MAX_NETWORK_FILE_BYTES,
    NetworkSchema,
    type Network,
    type NetworkData,
    type NetworkSettings,
    type NetworkView
} from '~/lib/network/schema';
import { removeNetworkNode } from '~/lib/network/topology';
import { useNetworkPreview } from '~/lib/network/useNetworkPreview';
import type { Layer } from '~/lib/types';

import { NetworkLiveControls } from './NetworkLiveControls';
import {
    NetworkMotionSettings,
    NetworkStyleSettings,
    NetworkPlaybackControls
} from './NetworkSettingsControls';
import {
    NetworkTopologyEditor,
    NETWORK_TOPOLOGY_PAGE_SIZE,
    type NetworkTopologyNavigation
} from './NetworkTopologyEditor';

function NetworkEditor({
    initial,
    onClose,
    onSave
}: {
    initial?: Network;
    onClose: () => void;
    onSave: (network: Network) => void;
}) {
    const [name, setName] = useState(initial?.name ?? 'Custom network');
    const [source, setSource] = useState<Network['source']>(initial?.source ?? 'live-example');
    const [reheat, setReheat] = useState(initial?.reheat ?? 0);
    const [data, setData] = useState<NetworkData>(initial?.data ?? EXAMPLE_NETWORK);
    const [settings, setSettings] = useState<NetworkSettings>(
        initial?.settings ?? DEFAULT_NETWORK_SETTINGS
    );
    const [table, setTable] = useState<CsvTable | null>(null);
    const [mapping, setMapping] = useState<CsvMapping>({ source: '', target: '', weight: '' });
    const [error, setError] = useState('');
    const [reading, setReading] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const readVersion = useRef(0);
    const nameId = useId();
    const previewHelpId = useId();
    const paintedView = useRef<NetworkView | undefined>(undefined);
    const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
    const [tab, setTab] = useState('custom');
    const [selection, setSelection] = useState<NetworkSelection>(null);
    const [navigation, setNavigation] = useState<NetworkTopologyNavigation>({
        section: 'nodes',
        page: 0
    });
    const [topologySession, setTopologySession] = useState(0);
    const [previewError, setPreviewError] = useState('');
    const [ready, setReady] = useState(false);
    const draft = useMemo(
        () => ({ name, data, settings, source, reheat }),
        [name, data, settings, source, reheat]
    );
    const live = useNetworkPreview(draft, true, (message) => {
        setPreviewError(message ?? '');
        if (!message) setReady(true);
    });
    const busy = !ready && !previewError;
    useEffect(() => {
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        let raf = 0;
        let previousLive: NetworkView | undefined;
        let view: NetworkView | undefined;
        const paint = () => {
            if (!view || previousLive !== live.current) {
                view = networkPreviewView(draft.data, live.current);
                previousLive = live.current;
            }
            paintedView.current = view;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            drawNetwork(ctx, draft, canvas.width, canvas.height, undefined, view, selection);
            raf = requestAnimationFrame(paint);
        };
        paint();
        return () => cancelAnimationFrame(raf);
    }, [canvas, draft, live, selection]);

    const canvasTarget = (event: PointerEvent<HTMLCanvasElement>) => {
        if (!paintedView.current) return null;
        const bounds = event.currentTarget.getBoundingClientRect();
        const point = networkPointerPosition(event.clientX, event.clientY, {
            x: bounds.left,
            y: bounds.top,
            w: bounds.width,
            h: bounds.height
        });
        return point ? hitTestNetwork(paintedView.current, settings, point) : null;
    };
    const selectFromCanvas = (event: PointerEvent<HTMLCanvasElement>) => {
        if (event.button !== 0) return;
        const target = canvasTarget(event);
        setSelection(target);
        if (!target) return;
        const index =
            'nodeId' in target
                ? data.nodes.findIndex((node) => node.id === target.nodeId)
                : target.edgeIndex;
        if (index < 0) return;
        setTab('custom');
        setNavigation({
            section: 'nodeId' in target ? 'nodes' : 'links',
            page: Math.floor(index / NETWORK_TOPOLOGY_PAGE_SIZE)
        });
    };

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
        setSelection(null);
        setNavigation({ section: 'nodes', page: 0 });
        setTopologySession((value) => value + 1);
        setTab('custom');
        setSource('live-example');
        setSettings((previous) => ({ ...previous, paused: false }));
        if (fileRef.current) fileRef.current.value = '';
    };

    const readFile = async (file: File) => {
        setTab('custom');
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
            setSource('import');
            setSelection(null);
            setNavigation({ section: 'nodes', page: 0 });
            setTopologySession((value) => value + 1);
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
            setSource('import');
            setError('');
            setSelection(null);
            setNavigation({ section: 'nodes', page: 0 });
            setTopologySession((value) => value + 1);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Invalid column mapping.');
        }
    };

    const changeTopology = (next: NetworkData) => {
        readVersion.current++;
        setReading(false);
        setError('');
        setTable(null);
        setData(next);
        setSource('custom');
    };

    const changeSettings = (patch: Partial<NetworkSettings>) =>
        setSettings((previous) => ({ ...previous, ...patch }));
    const nudge = () => {
        setReheat((value) => value + 1);
        changeSettings({ paused: false });
    };
    const save = () => {
        try {
            onSave(NetworkSchema.parse({ name: name.trim(), data, settings, source, reheat }));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not save network.');
        }
    };

    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open) onClose();
            }}
        >
            <DialogContent className="flex max-h-[90vh] w-[min(1160px,96vw)] flex-col overflow-hidden">
                <header className="flex items-center gap-3 border-b px-6 py-4">
                    <span className="flex size-10 items-center justify-center rounded-xl border bg-muted/40">
                        <GraphIcon className="size-5" />
                    </span>
                    <div>
                        <DialogTitle>{initial ? 'Edit network' : 'Add network'}</DialogTitle>
                        <DialogDescription className="mt-0.5 text-xs">
                            Arrange connections. Bring them to life.
                        </DialogDescription>
                    </div>
                </header>
                <div className="grid min-h-0 flex-1 overflow-auto md:grid-cols-[minmax(0,1fr)_360px] md:overflow-hidden">
                    <div className="flex min-h-[390px] flex-col bg-black text-white md:min-h-[530px]">
                        <div className="flex items-center justify-between gap-3 px-6 py-5 text-[11px]">
                            <span className="flex items-center gap-2">
                                <span
                                    className={`size-1.5 rounded-full ${settings.paused ? 'bg-white/30' : 'bg-white'}`}
                                />
                                {settings.paused
                                    ? 'Paused'
                                    : settings.motionStrength > 0
                                      ? 'Live motion'
                                      : 'Natural settling'}
                            </span>
                            <span className="font-mono text-white/50 tabular-nums">
                                {data.nodes.length} {data.nodes.length === 1 ? 'node' : 'nodes'} ·{' '}
                                {data.edges.length} {data.edges.length === 1 ? 'link' : 'links'}
                            </span>
                        </div>
                        <div className="relative min-h-[250px] flex-1">
                            <canvas
                                ref={setCanvas}
                                width={1000}
                                height={650}
                                aria-label="Network preview"
                                aria-describedby={previewHelpId}
                                tabIndex={0}
                                onPointerDown={selectFromCanvas}
                                onPointerMove={(event) => {
                                    event.currentTarget.style.cursor = canvasTarget(event)
                                        ? 'pointer'
                                        : 'default';
                                }}
                                onPointerLeave={(event) => {
                                    event.currentTarget.style.cursor = 'default';
                                }}
                                onKeyDown={(event) => {
                                    // Keep canvas shortcuts inside this draft, not the editor
                                    // underneath the dialog (where Delete removes a whole layer).
                                    if (event.key === 'Escape' && !selection) return;
                                    event.stopPropagation();
                                    if (event.key === 'Escape') {
                                        event.preventDefault();
                                        setSelection(null);
                                    } else if (
                                        event.key === 'Delete' ||
                                        event.key === 'Backspace'
                                    ) {
                                        event.preventDefault();
                                        if (!selection) return;
                                        if ('nodeId' in selection) {
                                            if (data.nodes.length === 1) return;
                                            changeTopology(
                                                removeNetworkNode(data, selection.nodeId)
                                            );
                                        } else {
                                            changeTopology({
                                                ...data,
                                                edges: data.edges.filter(
                                                    (_, i) => i !== selection.edgeIndex
                                                )
                                            });
                                        }
                                        setSelection(null);
                                    }
                                }}
                                className="absolute inset-0 h-full w-full object-contain"
                            />
                            {busy && (
                                <output className="absolute inset-0 flex items-center justify-center text-xs text-white/60">
                                    Starting preview…
                                </output>
                            )}
                        </div>
                        <div className="flex items-center justify-between gap-3 border-t border-white/10 px-6 py-4">
                            <div className="text-[11px] leading-relaxed">
                                <p className="text-white/80">
                                    {source === 'live-example'
                                        ? 'Example · simulated data'
                                        : source === 'custom'
                                          ? 'Custom topology'
                                          : 'Imported data'}
                                </p>
                                <p className="mt-1 text-white/40">
                                    Black preview. Transparent layer.
                                </p>
                            </div>
                            <span
                                id={previewHelpId}
                                className="max-w-44 text-right text-[10px] text-white/50"
                            >
                                Click to select · Delete to remove
                            </span>
                        </div>
                    </div>
                    <aside className="min-h-0 min-w-0 border-l bg-popover md:overflow-y-auto">
                        <div className="space-y-4 border-b px-5 py-5">
                            <label
                                htmlFor={nameId}
                                className="grid gap-2 text-[11px] font-medium text-muted-foreground"
                            >
                                Layer name
                                <Input
                                    id={nameId}
                                    maxLength={100}
                                    value={name}
                                    onChange={(event) => setName(event.target.value)}
                                    className="h-9 rounded-lg border-border bg-background text-sm text-foreground shadow-none"
                                />
                            </label>
                            <NetworkPlaybackControls
                                paused={settings.paused}
                                onPause={() => changeSettings({ paused: !settings.paused })}
                                onNudge={nudge}
                            />
                        </div>
                        <Tabs
                            value={tab}
                            onValueChange={(value) => {
                                setTab(String(value));
                                setSelection(null);
                            }}
                            className="gap-0"
                        >
                            <TabsList className="mx-5 mt-4 w-[calc(100%-2.5rem)]">
                                <TabsTrigger value="custom" className="text-xs">
                                    <GraphIcon />
                                    Custom
                                </TabsTrigger>
                                <TabsTrigger value="motion" className="text-xs">
                                    <SlidersHorizontalIcon />
                                    Motion
                                </TabsTrigger>
                                <TabsTrigger value="style" className="text-xs">
                                    <PaletteIcon />
                                    Style
                                </TabsTrigger>
                            </TabsList>
                            <TabsContent value="motion" className="p-5">
                                <NetworkMotionSettings
                                    settings={settings}
                                    onChange={changeSettings}
                                />
                            </TabsContent>
                            <TabsContent value="style" className="p-5">
                                <NetworkStyleSettings
                                    settings={settings}
                                    onChange={changeSettings}
                                />
                            </TabsContent>
                            <TabsContent value="custom" className="space-y-5 p-5">
                                <div>
                                    <p className="text-sm font-medium">
                                        Make the connections your own
                                    </p>
                                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                                        Start with this example, or import your own graph.
                                    </p>
                                </div>
                                <NetworkTopologyEditor
                                    key={topologySession}
                                    data={data}
                                    selection={selection}
                                    navigation={navigation}
                                    onNavigate={setNavigation}
                                    onChange={changeTopology}
                                    onSelect={setSelection}
                                />
                                <div className="flex gap-2 border-t pt-4">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="flex-1 text-xs"
                                        onClick={() => fileRef.current?.click()}
                                        disabled={reading}
                                    >
                                        <UploadSimpleIcon />
                                        {reading ? 'Reading…' : 'Import file'}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-xs"
                                        onClick={useExample}
                                    >
                                        Reset to example
                                    </Button>
                                </div>
                                {table && (
                                    <fieldset className="grid gap-3 border-t pt-4">
                                        <legend className="text-xs font-medium">CSV columns</legend>
                                        {(['source', 'target', 'weight'] as const).map((field) => (
                                            <label
                                                className="grid gap-1.5 text-xs capitalize"
                                                key={field}
                                            >
                                                {field}
                                                {field === 'weight' ? ' (optional)' : ''}
                                                <select
                                                    aria-label={`${field} column`}
                                                    value={mapping[field]}
                                                    onChange={(event) =>
                                                        changeMapping(field, event.target.value)
                                                    }
                                                    className="h-9 rounded-lg border bg-background px-2 text-foreground"
                                                >
                                                    {field === 'weight' && (
                                                        <option value="">None</option>
                                                    )}
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
                                <details className="border-t pt-4 text-xs text-muted-foreground">
                                    <summary className="cursor-pointer font-medium">
                                        Data format examples
                                    </summary>
                                    <p className="mt-3">
                                        Up to 1,000 nodes · 3,000 links · 2 MB per file
                                    </p>
                                    <p className="mt-3">CSV: one connection per row.</p>
                                    <pre className="mt-2 overflow-auto rounded-lg bg-muted p-3">
                                        {'source,target,weight\nAlice,Bob,2\nBob,Carol,1'}
                                    </pre>
                                    <p className="mt-3">
                                        JSON: nodes and edges; labels and groups are optional.
                                    </p>
                                    <pre className="mt-2 overflow-auto rounded-lg bg-muted p-3">
                                        {
                                            '{\n  "nodes": [{"id":"a"},{"id":"b"}],\n  "edges": [{"source":"a","target":"b"}]\n}'
                                        }
                                    </pre>
                                </details>
                            </TabsContent>
                        </Tabs>
                    </aside>
                </div>
                <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,.json"
                    aria-label="Network data file"
                    className="sr-only"
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void readFile(file);
                        event.target.value = '';
                    }}
                />
                <footer className="flex items-center justify-between gap-4 border-t px-6 py-4">
                    <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                        {error || previewError ? (
                            <p role="alert" className="text-destructive">
                                {error || previewError}
                            </p>
                        ) : (
                            <span>Same nodes and links. One shared motion across the wall.</span>
                        )}
                    </div>
                    <div className="flex gap-2">
                        <Button variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            disabled={busy || reading || !!error || !!previewError || !name.trim()}
                            onClick={save}
                        >
                            {initial ? 'Apply changes' : 'Add to stage'}
                        </Button>
                    </div>
                </footer>
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
            {layer?.network && <NetworkLiveControls layer={layer} />}
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
