import {
    PlusIcon,
    TrashIcon,
    ArrowRightIcon,
    CaretLeftIcon,
    CaretRightIcon
} from '@phosphor-icons/react';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { useEffect, useId, useRef, useState } from 'react';

import type { NetworkSelection } from '~/lib/network/render';
import { MAX_NETWORK_EDGES, MAX_NETWORK_NODES, type NetworkData } from '~/lib/network/schema';
import { appendNetworkLink, appendNetworkNode, removeNetworkNode } from '~/lib/network/topology';

import { NetworkNodeSelect } from './NetworkNodeSelect';

export const NETWORK_TOPOLOGY_PAGE_SIZE = 6;
export type NetworkTopologyNavigation = { section: 'nodes' | 'links'; page: number };

export function NetworkTopologyEditor({
    data,
    selection,
    navigation,
    onNavigate,
    onChange,
    onSelect
}: {
    data: NetworkData;
    selection: NetworkSelection;
    navigation: NetworkTopologyNavigation;
    onNavigate: (navigation: NetworkTopologyNavigation) => void;
    onChange: (data: NetworkData) => void;
    onSelect: (selection: NetworkSelection) => void;
}) {
    const { section, page } = navigation;
    const [focusId, setFocusId] = useState<string | null>(null);
    const nodeTypeId = useId();
    const newNodeInput = useRef<HTMLInputElement>(null);
    useEffect(() => {
        // Focus only after the user's Add node action, never when the dialog opens.
        if (focusId) newNodeInput.current?.select();
    }, [focusId]);
    const edgeIndex = selection && 'edgeIndex' in selection ? selection.edgeIndex : null;
    const selectedNodeId = selection && 'nodeId' in selection ? selection.nodeId : undefined;
    const selectedRow = useRef<HTMLDivElement>(null);
    const linkEditor = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!selection) return;
        const element = 'nodeId' in selection ? selectedRow.current : linkEditor.current;
        element?.scrollIntoView({ block: 'nearest' });
    }, [selection]);
    const count = section === 'nodes' ? data.nodes.length : data.edges.length;
    const pages = Math.max(1, Math.ceil(count / NETWORK_TOPOLOGY_PAGE_SIZE));
    const currentPage = Math.min(page, pages - 1);
    const offset = currentPage * NETWORK_TOPOLOGY_PAGE_SIZE;
    const edge = edgeIndex === null ? undefined : data.edges[edgeIndex];
    const selectedNode = data.nodes.find((node) => node.id === selectedNodeId);
    const nodeName = (id: string) => data.nodes.find((node) => node.id === id)?.label?.trim() || id;
    const switchSection = (next: 'nodes' | 'links') => {
        onNavigate({ section: next, page: 0 });
        onSelect(null);
    };
    const add = () => {
        if (section === 'nodes') {
            const next = appendNetworkNode(data);
            const id = next.nodes.at(-1)!.id;
            onChange(next);
            onNavigate({
                section,
                page: Math.floor((next.nodes.length - 1) / NETWORK_TOPOLOGY_PAGE_SIZE)
            });
            setFocusId(id);
            onSelect({ nodeId: id });
        } else {
            const next = appendNetworkLink(
                data,
                data.nodes[0]!.id,
                (data.nodes[1] ?? data.nodes[0])!.id
            );
            onChange(next);
            onNavigate({
                section,
                page: Math.floor((next.edges.length - 1) / NETWORK_TOPOLOGY_PAGE_SIZE)
            });
            onSelect({ edgeIndex: next.edges.length - 1 });
        }
    };
    const changeEndpoint = (field: 'source' | 'target', value: string) => {
        onChange({
            ...data,
            edges: data.edges.map((item, index) =>
                index === edgeIndex ? { ...item, [field]: value } : item
            )
        });
    };
    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
                <fieldset
                    className="flex gap-1 rounded-lg bg-muted/60 p-1"
                    aria-label="Topology lists"
                >
                    <Button
                        variant={section === 'nodes' ? 'secondary' : 'ghost'}
                        size="sm"
                        className="h-7 px-2 text-xs aria-pressed:bg-background aria-pressed:shadow-sm"
                        aria-pressed={section === 'nodes'}
                        onClick={() => switchSection('nodes')}
                    >
                        Nodes <span className="text-muted-foreground">{data.nodes.length}</span>
                    </Button>
                    <Button
                        variant={section === 'links' ? 'secondary' : 'ghost'}
                        size="sm"
                        className="h-7 px-2 text-xs aria-pressed:bg-background aria-pressed:shadow-sm"
                        aria-pressed={section === 'links'}
                        onClick={() => switchSection('links')}
                    >
                        Links <span className="text-muted-foreground">{data.edges.length}</span>
                    </Button>
                </fieldset>
                <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1 px-2 text-xs"
                    onClick={add}
                    disabled={
                        section === 'nodes'
                            ? data.nodes.length >= MAX_NETWORK_NODES
                            : data.edges.length >= MAX_NETWORK_EDGES
                    }
                >
                    <PlusIcon />
                    {section === 'nodes' ? 'Add node' : 'Add link'}
                </Button>
            </div>
            {section === 'links' && edge && (
                <div
                    ref={linkEditor}
                    className="grid grid-cols-2 gap-3 rounded-xl border bg-muted/20 p-3"
                >
                    <p className="col-span-2 text-[11px] font-medium text-muted-foreground">
                        Link {edgeIndex! + 1}
                    </p>
                    {(['source', 'target'] as const).map((field) => (
                        <div key={field} className="grid min-w-0 gap-1.5 text-xs">
                            <span>{field === 'source' ? 'From node' : 'To node'}</span>
                            <NetworkNodeSelect
                                label={field === 'source' ? 'From node' : 'To node'}
                                nodes={data.nodes}
                                value={edge[field]}
                                onValueChange={(value) => changeEndpoint(field, value)}
                                className="rounded-lg text-xs"
                            />
                        </div>
                    ))}
                </div>
            )}
            {section === 'nodes' && selectedNode && (
                <label
                    htmlFor={nodeTypeId}
                    className="grid gap-1.5 rounded-xl border bg-muted/20 p-3 text-xs"
                >
                    Node type
                    <Input
                        id={nodeTypeId}
                        aria-label={`Node type ${selectedNode.id}`}
                        maxLength={80}
                        placeholder="e.g. Health or Environment"
                        value={selectedNode.group ?? ''}
                        onChange={(event) =>
                            onChange({
                                ...data,
                                nodes: data.nodes.map((node) =>
                                    node.id === selectedNode.id
                                        ? { ...node, group: event.target.value || undefined }
                                        : node
                                )
                            })
                        }
                        className="h-8 text-xs"
                    />
                </label>
            )}
            <div
                className="overflow-hidden rounded-xl border"
                aria-label={section === 'nodes' ? 'Network nodes' : 'Network links'}
            >
                {section === 'nodes' ? (
                    data.nodes
                        .slice(offset, offset + NETWORK_TOPOLOGY_PAGE_SIZE)
                        .map((node, index) => (
                            <div
                                key={node.id}
                                ref={selectedNodeId === node.id ? selectedRow : undefined}
                                data-selected={selectedNodeId === node.id}
                                className="flex items-center gap-2 border-b px-2 py-1.5 last:border-b-0 focus-within:bg-muted/40 data-[selected=true]:bg-muted/60"
                            >
                                <span className="w-5 shrink-0 text-center font-mono text-[10px] text-muted-foreground">
                                    {offset + index + 1}
                                </span>
                                <Input
                                    aria-label={`Node name ${node.id}`}
                                    maxLength={160}
                                    ref={focusId === node.id ? newNodeInput : undefined}
                                    value={node.label ?? node.id}
                                    onFocus={() => onSelect({ nodeId: node.id })}
                                    onChange={(event) =>
                                        onChange({
                                            ...data,
                                            nodes: data.nodes.map((item) =>
                                                item.id === node.id
                                                    ? { ...item, label: event.target.value }
                                                    : item
                                            )
                                        })
                                    }
                                    className="h-8 min-w-0 border-transparent bg-transparent text-xs shadow-none"
                                />
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                                    aria-label={`Delete node ${node.id}`}
                                    disabled={data.nodes.length === 1}
                                    title={
                                        data.nodes.length === 1
                                            ? 'Keep at least one node'
                                            : 'Delete node and its links'
                                    }
                                    onClick={() => {
                                        onChange(removeNetworkNode(data, node.id));
                                        setFocusId(null);
                                        onSelect(null);
                                    }}
                                >
                                    <TrashIcon className="size-3.5" />
                                </Button>
                            </div>
                        ))
                ) : data.edges.length ? (
                    data.edges
                        .slice(offset, offset + NETWORK_TOPOLOGY_PAGE_SIZE)
                        .map((item, index) => {
                            const id = offset + index;
                            return (
                                <div
                                    key={id}
                                    className={`flex items-center border-b px-2 py-1.5 last:border-b-0 ${edgeIndex === id ? 'bg-muted/60' : ''}`}
                                >
                                    <button
                                        type="button"
                                        aria-label={`Edit link ${id + 1}`}
                                        aria-pressed={edgeIndex === id}
                                        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        onClick={() => {
                                            onSelect({ edgeIndex: id });
                                        }}
                                    >
                                        <span className="min-w-0 flex-1 truncate">
                                            {nodeName(item.source)}
                                        </span>
                                        <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground" />
                                        <span className="min-w-0 flex-1 truncate">
                                            {nodeName(item.target)}
                                        </span>
                                    </button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                                        aria-label={`Delete link ${id + 1}`}
                                        onClick={() => {
                                            onChange({
                                                ...data,
                                                edges: data.edges.filter((_, i) => i !== id)
                                            });
                                            onSelect(null);
                                        }}
                                    >
                                        <TrashIcon className="size-3.5" />
                                    </Button>
                                </div>
                            );
                        })
                ) : (
                    <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                        No links yet. Connect two nodes to start.
                    </p>
                )}
            </div>
            {pages > 1 && (
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>
                        {offset + 1}–{Math.min(offset + NETWORK_TOPOLOGY_PAGE_SIZE, count)} of{' '}
                        {count}
                    </span>
                    <div className="flex gap-1">
                        <Button
                            variant="ghost"
                            size="icon"
                            className="size-6"
                            aria-label="Previous topology page"
                            disabled={currentPage === 0}
                            onClick={() => {
                                onNavigate({ section, page: currentPage - 1 });
                                onSelect(null);
                            }}
                        >
                            <CaretLeftIcon />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="size-6"
                            aria-label="Next topology page"
                            disabled={currentPage === pages - 1}
                            onClick={() => {
                                onNavigate({ section, page: currentPage + 1 });
                                onSelect(null);
                            }}
                        >
                            <CaretRightIcon />
                        </Button>
                    </div>
                </div>
            )}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
                {section === 'nodes'
                    ? 'Select a name to highlight its node. Deleting a node removes its links too.'
                    : 'Select a link to change its endpoints. Changes appear in the preview.'}
            </p>
        </div>
    );
}
