import {
    GraphIcon,
    UploadSimpleIcon,
    SlidersHorizontalIcon,
    PaletteIcon,
    QuestionIcon
} from '@phosphor-icons/react';
import { Button } from '@repo/ui/components/button';
import { Dialog, DialogContent, DialogTitle } from '@repo/ui/components/dialog';
import { Input } from '@repo/ui/components/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@repo/ui/components/tabs';
import { TipButton } from '@repo/ui/components/tip-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/components/tooltip';
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
import { drawNetwork, networkFit, type NetworkSelection } from '~/lib/network/render';
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
import { appendNetworkLink, removeNetworkNode } from '~/lib/network/topology';
import { useNetworkPreview } from '~/lib/network/useNetworkPreview';
import type { Layer } from '~/lib/types';

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

type NetworkLinkDrag = {
    pointerId: number;
    sourceId: string;
    startX: number;
    startY: number;
    active: boolean;
    point: { x: number; y: number } | null;
    targetId: string | null;
};

type NetworkEditorDraft = {
    name: string;
    source: Network['source'];
    data: NetworkData;
    settings: NetworkSettings;
    table: CsvTable | null;
    mapping: CsvMapping;
    tab: string;
    selection: NetworkSelection;
    navigation: NetworkTopologyNavigation;
    positions?: Network['positions'];
    error: string;
};

const networkEditorDrafts = new Map<string, NetworkEditorDraft>();

function NetworkEditorHelp() {
    const triggerId = useId();
    const [open, setOpen] = useState(false);
    return (
        <Tooltip open={open} onOpenChange={setOpen} triggerId={triggerId}>
            <TooltipTrigger
                id={triggerId}
                delay={0}
                closeOnClick={false}
                onClick={() => setOpen(true)}
                render={
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Network preview help"
                        className="size-6 rounded-full text-muted-foreground hover:text-foreground"
                    />
                }
            >
                <QuestionIcon className="size-4" />
            </TooltipTrigger>
            <TooltipContent
                role="tooltip"
                side="bottom"
                align="start"
                className="w-64 max-w-[calc(100vw-2rem)] py-3 leading-relaxed"
            >
                <div className="space-y-2">
                    <p>Click a node or link in the preview to select it.</p>
                    <p>Drag from one node to another to add a link.</p>
                    <p>
                        With the preview focused, press Delete or Backspace to remove the selection,
                        or Escape to clear it.
                    </p>
                    <p>Click empty space to clear the selection.</p>
                </div>
            </TooltipContent>
        </Tooltip>
    );
}

function NetworkEditor({
    initial,
    savedDraft,
    onClose,
    onDismiss,
    onSave
}: {
    initial?: Network;
    savedDraft?: NetworkEditorDraft;
    onClose: () => void;
    onDismiss: (draft: NetworkEditorDraft | null) => void;
    onSave: (network: Network) => void;
}) {
    const [name, setName] = useState(savedDraft?.name ?? initial?.name ?? 'Custom network');
    const [source, setSource] = useState<Network['source']>(
        savedDraft?.source ?? initial?.source ?? 'live-example'
    );
    const reheat = initial?.reheat ?? 0;
    const [data, setData] = useState<NetworkData>(
        savedDraft?.data ?? initial?.data ?? EXAMPLE_NETWORK
    );
    const [settings, setSettings] = useState<NetworkSettings>(
        savedDraft?.settings ?? initial?.settings ?? DEFAULT_NETWORK_SETTINGS
    );
    const [table, setTable] = useState<CsvTable | null>(savedDraft?.table ?? null);
    const [mapping, setMapping] = useState<CsvMapping>(
        savedDraft?.mapping ?? { source: '', target: '', weight: '' }
    );
    const [error, setError] = useState(savedDraft?.error ?? '');
    const [reading, setReading] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const readVersion = useRef(0);
    const nameId = useId();
    const previewHelpId = useId();
    const paintedView = useRef<NetworkView | undefined>(undefined);
    const linkDrag = useRef<NetworkLinkDrag | null>(null);
    const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
    const [tab, setTab] = useState(savedDraft?.tab ?? 'custom');
    const [selection, setSelection] = useState<NetworkSelection>(savedDraft?.selection ?? null);
    const [navigation, setNavigation] = useState<NetworkTopologyNavigation>(
        savedDraft?.navigation ?? { section: 'nodes', page: 0 }
    );
    const [topologySession, setTopologySession] = useState(0);
    const [previewError, setPreviewError] = useState('');
    const [ready, setReady] = useState(false);
    const draft = useMemo(
        () => ({
            name,
            data,
            settings,
            source,
            reheat,
            positions:
                savedDraft?.data === data
                    ? savedDraft.positions
                    : initial?.data === data
                      ? initial.positions
                      : undefined
        }),
        [name, data, settings, source, reheat, initial, savedDraft]
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
                view = networkPreviewView(
                    draft.data,
                    live.current ??
                        (draft.positions
                            ? { data: draft.data, positions: draft.positions }
                            : undefined)
                );
                previousLive = live.current;
            }
            paintedView.current = view;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            drawNetwork(ctx, draft, canvas.width, canvas.height, undefined, view, selection);
            const drag = linkDrag.current;
            if (drag?.active && drag.point) {
                const sourceIndex = view.data.nodes.findIndex((node) => node.id === drag.sourceId);
                const source = view.positions[sourceIndex];
                if (source) {
                    const fit = networkFit(canvas.width, canvas.height);
                    ctx.save();
                    ctx.translate(fit.x, fit.y);
                    ctx.scale(fit.scale, fit.scale);
                    ctx.strokeStyle = drag.targetId ? '#a5b4fc' : '#ffffff';
                    ctx.lineWidth = Math.max(2, settings.edgeWidth);
                    ctx.setLineDash([8, 6]);
                    ctx.beginPath();
                    ctx.moveTo(source.x, source.y);
                    ctx.lineTo(drag.point.x, drag.point.y);
                    ctx.stroke();
                    if (drag.targetId) {
                        const targetIndex = view.data.nodes.findIndex(
                            (node) => node.id === drag.targetId
                        );
                        const target = view.positions[targetIndex];
                        if (target) {
                            ctx.setLineDash([]);
                            ctx.lineWidth = 2;
                            ctx.beginPath();
                            ctx.arc(target.x, target.y, settings.nodeRadius + 6, 0, Math.PI * 2);
                            ctx.stroke();
                        }
                    }
                    ctx.restore();
                }
            }
            raf = requestAnimationFrame(paint);
        };
        paint();
        return () => cancelAnimationFrame(raf);
    }, [canvas, draft, live, selection, settings.edgeWidth, settings.nodeRadius]);

    const canvasPoint = (event: PointerEvent<HTMLCanvasElement>) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        return networkPointerPosition(event.clientX, event.clientY, {
            x: bounds.left,
            y: bounds.top,
            w: bounds.width,
            h: bounds.height
        });
    };
    const canvasTarget = (event: PointerEvent<HTMLCanvasElement>) => {
        if (!paintedView.current) return null;
        const point = canvasPoint(event);
        return point ? hitTestNetwork(paintedView.current, settings, point) : null;
    };
    const selectFromCanvas = (target: NetworkSelection) => {
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
    const moveLinkDrag = (event: PointerEvent<HTMLCanvasElement>) => {
        const drag = linkDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) {
            event.currentTarget.style.cursor = canvasTarget(event) ? 'pointer' : 'default';
            return;
        }
        if (
            !drag.active &&
            Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 6
        )
            drag.active = true;
        if (!drag.active) return;
        const point = canvasPoint(event);
        drag.point = point ? { x: point.x, y: point.y } : null;
        const target = canvasTarget(event);
        drag.targetId =
            target && 'nodeId' in target && target.nodeId !== drag.sourceId ? target.nodeId : null;
        event.currentTarget.style.cursor = drag.targetId ? 'copy' : 'crosshair';
    };
    const finishLinkDrag = (event: PointerEvent<HTMLCanvasElement>) => {
        const drag = linkDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        linkDrag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        const target = canvasTarget(event);
        event.currentTarget.style.cursor = target ? 'pointer' : 'default';
        if (!drag.active || !target || !('nodeId' in target) || target.nodeId === drag.sourceId)
            return;
        try {
            const next = appendNetworkLink(data, drag.sourceId, target.nodeId);
            changeTopology(next);
            const edgeIndex = next.edges.length - 1;
            setSelection({ edgeIndex });
            setTab('custom');
            setNavigation({
                section: 'links',
                page: Math.floor(edgeIndex / NETWORK_TOPOLOGY_PAGE_SIZE)
            });
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not add link.');
        }
    };

    useEffect(
        () => () => {
            readVersion.current++;
        },
        []
    );

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
    const hasChanges = () => {
        const originalName = initial?.name ?? 'Custom network';
        const originalSource = initial?.source ?? 'live-example';
        const originalData = initial?.data ?? EXAMPLE_NETWORK;
        const originalSettings = initial?.settings ?? DEFAULT_NETWORK_SETTINGS;
        return (
            name !== originalName ||
            source !== originalSource ||
            (data !== originalData && JSON.stringify(data) !== JSON.stringify(originalData)) ||
            (settings !== originalSettings &&
                JSON.stringify(settings) !== JSON.stringify(originalSettings)) ||
            table !== null ||
            Boolean(mapping.source || mapping.target || mapping.weight || error)
        );
    };
    const save = () => {
        try {
            const positions = settings.paused
                ? networkPreviewView(data, paintedView.current).positions.map(({ x, y }) => ({
                      x,
                      y
                  }))
                : undefined;
            onSave(
                NetworkSchema.parse({
                    name: name.trim(),
                    data,
                    settings,
                    source,
                    reheat,
                    positions
                })
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not save network.');
        }
    };
    const dismiss = () => {
        if (reading) return;
        onDismiss(
            hasChanges()
                ? {
                      name,
                      source,
                      data,
                      settings,
                      table,
                      mapping,
                      tab,
                      selection,
                      navigation,
                      positions: settings.paused
                          ? networkPreviewView(data, paintedView.current).positions.map(
                                ({ x, y }) => ({ x, y })
                            )
                          : undefined,
                      error
                  }
                : null
        );
    };

    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open) dismiss();
            }}
        >
            <DialogContent className="flex max-h-[90vh] w-[min(1160px,96vw)] flex-col overflow-hidden">
                <header className="flex items-center gap-3 border-b px-6 py-4">
                    <span className="flex size-10 items-center justify-center rounded-xl border bg-muted/40">
                        {initial ? (
                            <SlidersHorizontalIcon className="size-5" />
                        ) : (
                            <GraphIcon className="size-5" />
                        )}
                    </span>
                    <div className="flex items-center gap-1">
                        <DialogTitle>{initial ? 'Edit network' : 'Add network'}</DialogTitle>
                        <NetworkEditorHelp />
                    </div>
                </header>
                <div className="grid min-h-0 flex-1 overflow-auto md:grid-cols-[minmax(0,1fr)_360px] md:overflow-hidden">
                    <div
                        data-testid="network-preview-pane"
                        className="relative min-h-[390px] bg-black md:min-h-[530px]"
                    >
                        <div className="absolute inset-0">
                            <canvas
                                ref={setCanvas}
                                width={1000}
                                height={650}
                                aria-label="Network preview"
                                aria-describedby={previewHelpId}
                                tabIndex={0}
                                onPointerDown={(event) => {
                                    if (event.button !== 0) return;
                                    const target = canvasTarget(event);
                                    selectFromCanvas(target);
                                    if (target && 'nodeId' in target) {
                                        linkDrag.current = {
                                            pointerId: event.pointerId,
                                            sourceId: target.nodeId,
                                            startX: event.clientX,
                                            startY: event.clientY,
                                            active: false,
                                            point: null,
                                            targetId: null
                                        };
                                        event.currentTarget.setPointerCapture(event.pointerId);
                                    }
                                }}
                                onPointerMove={(event) => {
                                    moveLinkDrag(event);
                                }}
                                onPointerUp={finishLinkDrag}
                                onPointerCancel={(event) => {
                                    if (linkDrag.current?.pointerId === event.pointerId)
                                        linkDrag.current = null;
                                    event.currentTarget.style.cursor = 'default';
                                }}
                                onLostPointerCapture={(event) => {
                                    if (linkDrag.current?.pointerId === event.pointerId)
                                        linkDrag.current = null;
                                }}
                                onPointerLeave={(event) => {
                                    if (!linkDrag.current)
                                        event.currentTarget.style.cursor = 'default';
                                }}
                                onKeyDown={(event) => {
                                    // Keep canvas shortcuts inside this draft, not the editor
                                    // underneath the dialog (where Delete removes a whole layer).
                                    if (event.key === 'Escape' && !selection && !linkDrag.current)
                                        return;
                                    event.stopPropagation();
                                    if (event.key === 'Escape') {
                                        event.preventDefault();
                                        const drag = linkDrag.current;
                                        if (
                                            drag &&
                                            event.currentTarget.hasPointerCapture(drag.pointerId)
                                        )
                                            event.currentTarget.releasePointerCapture(
                                                drag.pointerId
                                            );
                                        linkDrag.current = null;
                                        event.currentTarget.style.cursor = 'default';
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
                                className="absolute inset-0 h-full w-full touch-none object-contain"
                            />
                            {busy && (
                                <output
                                    aria-label="Starting preview"
                                    className="absolute inset-0 flex items-center justify-center"
                                >
                                    <span className="size-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                                </output>
                            )}
                        </div>
                    </div>
                    <aside className="min-h-0 min-w-0 border-l bg-popover md:overflow-y-auto">
                        <span id={previewHelpId} className="sr-only">
                            Click to select a node or link. Drag from one node to another to add a
                            link. Press Delete to remove a selection.
                        </span>
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
                                    onChange={(event) => {
                                        setName(event.target.value);
                                        setError('');
                                    }}
                                    className="h-9 rounded-lg border-border bg-background text-sm text-foreground shadow-none"
                                />
                            </label>
                            <NetworkPlaybackControls
                                paused={settings.paused}
                                onPause={() => changeSettings({ paused: !settings.paused })}
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
                                <div className="border-t pt-4">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="w-full text-xs"
                                        onClick={() => fileRef.current?.click()}
                                        disabled={reading}
                                    >
                                        <UploadSimpleIcon />
                                        {reading ? 'Reading…' : 'Import file'}
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
                <footer className="flex flex-col items-end gap-2 border-t px-6 py-4">
                    {(error || previewError) && (
                        <p role="alert" className="max-w-full text-right text-xs text-destructive">
                            {error || previewError}
                        </p>
                    )}
                    <div className="flex gap-2">
                        <Button variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            disabled={busy || reading || !!error || !!previewError || !name.trim()}
                            onClick={save}
                        >
                            {initial ? 'Apply' : 'Add'}
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
    const draftKey = `${scope}/${layer?.numericId ?? 'new'}`;
    const close = () => {
        networkEditorDrafts.delete(draftKey);
        setDraft(null);
    };
    return (
        <>
            <TipButton
                tip={`${layer ? 'Edit network' : 'Add network'}${networkEditorDrafts.has(draftKey) ? ' (draft saved)' : ''}`}
                aria-label={layer ? 'Edit network' : 'Add network'}
                disabled={!!layer?.config.locked}
                onClick={() => setDraft({ initial: layer?.network, scope })}
            >
                {layer ? <SlidersHorizontalIcon /> : <GraphIcon />}
            </TipButton>
            {draft && draft.scope === scope && (
                <NetworkEditor
                    initial={draft.initial}
                    savedDraft={networkEditorDrafts.get(draftKey)}
                    onClose={close}
                    onDismiss={(value) => {
                        if (value) networkEditorDrafts.set(draftKey, value);
                        else networkEditorDrafts.delete(draftKey);
                        setDraft(null);
                    }}
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
