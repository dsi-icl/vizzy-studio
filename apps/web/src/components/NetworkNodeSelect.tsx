import { CaretDownIcon, CheckIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { Input } from '@repo/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/popover';
import { cn } from '@repo/ui/lib/utils';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { NetworkData } from '~/lib/network/schema';

export function NetworkNodeSelect({
    label,
    nodes,
    value,
    onValueChange,
    className
}: {
    label: string;
    nodes: NetworkData['nodes'];
    value: string;
    onValueChange: (value: string) => void;
    className?: string;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const searchRef = useRef<HTMLInputElement>(null);
    const optionsRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const frame = requestAnimationFrame(() => searchRef.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, [open]);
    const selected = nodes.find((node) => node.id === value);
    const matchingNodes = nodes.filter((node) =>
        (node.label || node.id).toLowerCase().includes(query.trim().toLowerCase())
    );
    const moveOptionFocus = (event: KeyboardEvent, direction: number) => {
        const options = Array.from(
            optionsRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []
        );
        if (!options.length) return;
        const current = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = Math.max(0, Math.min(options.length - 1, current + direction));
        options[next]?.focus();
        event.preventDefault();
    };

    return (
        <Popover
            open={open && nodes.length > 0}
            onOpenChange={(next) => {
                setOpen(next);
                if (!next) setQuery('');
            }}
        >
            <PopoverTrigger
                aria-label={label}
                data-value={value}
                disabled={nodes.length === 0}
                className={cn(
                    'flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-input/30 px-2.5 text-left text-sm text-foreground transition-colors outline-none hover:bg-input/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
                    className
                )}
            >
                <span className="min-w-0 truncate">
                    {selected?.label ||
                        selected?.id ||
                        (nodes.length ? 'Select node' : 'No displayed nodes')}
                </span>
                <CaretDownIcon className="size-4 shrink-0 text-muted-foreground" />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 max-w-[calc(100vw-2rem)] gap-2 p-2">
                <div className="relative">
                    <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        ref={searchRef}
                        aria-label={`Search ${label.toLowerCase()}`}
                        placeholder="Find a node…"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'ArrowDown') moveOptionFocus(event, 0);
                        }}
                        className="h-9 rounded-lg pl-8 text-sm"
                    />
                </div>
                <div
                    ref={optionsRef}
                    className="max-h-56 space-y-0.5 overflow-y-auto overscroll-contain"
                >
                    {matchingNodes.map((node) => (
                        <button
                            key={node.id}
                            type="button"
                            aria-pressed={node.id === value}
                            onClick={() => {
                                onValueChange(node.id);
                                setOpen(false);
                                setQuery('');
                            }}
                            onKeyDown={(event) => {
                                if (event.key === 'ArrowDown') moveOptionFocus(event, 1);
                                if (event.key === 'ArrowUp') moveOptionFocus(event, -1);
                            }}
                            className={cn(
                                'flex w-full items-start justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm leading-snug outline-none hover:bg-accent focus-visible:bg-accent',
                                node.id === value && 'bg-accent text-accent-foreground'
                            )}
                        >
                            <span className="min-w-0 break-words">{node.label || node.id}</span>
                            {node.id === value && <CheckIcon className="mt-0.5 size-4 shrink-0" />}
                        </button>
                    ))}
                    {!matchingNodes.length && (
                        <p className="px-2.5 py-4 text-center text-xs text-muted-foreground">
                            No matching nodes
                        </p>
                    )}
                </div>
                <p className="px-2 text-[11px] text-muted-foreground">
                    {matchingNodes.length} of {nodes.length} nodes
                </p>
            </PopoverContent>
        </Popover>
    );
}
