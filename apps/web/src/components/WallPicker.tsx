import { CircleNotchIcon, MonitorIcon, XIcon } from '@phosphor-icons/react';
import { stageLayoutsEqual } from '@repo/db/schema';
import { Button } from '@repo/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/popover';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useEditorStore } from '~/lib/editorStore';
import { wallsQueryOptions } from '~/server/walls.queries';

function WallList({ onSelect }: { onSelect: (wallId: string) => void }) {
    const { data: walls = [], isLoading } = useQuery(wallsQueryOptions());
    const liveNodeCounts = useEditorStore((s) => s.wallNodeCounts);
    const stageLayout = useEditorStore((s) => s.stageLayout);

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-4">
                <CircleNotchIcon size={20} className="animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (walls.length === 0) {
        return (
            <div className="py-4 text-center text-xs text-muted-foreground">No walls connected</div>
        );
    }

    return (
        <div className="flex flex-col gap-1">
            {walls.map((wall) => {
                const connectedNodes = liveNodeCounts[wall.wallId] ?? wall.connectedNodes;
                const mismatched = Boolean(
                    wall.layoutTemplate && !stageLayoutsEqual(stageLayout, wall.layoutTemplate)
                );
                return (
                    <button
                        key={wall.id}
                        disabled={mismatched}
                        onClick={() => onSelect(wall.wallId)}
                        className="flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors not-disabled:cursor-pointer not-disabled:hover:bg-accent disabled:opacity-50"
                    >
                        <div>
                            <div className="font-medium">{wall.name}</div>
                            <div className="text-xs text-muted-foreground">
                                {mismatched ? (
                                    <>
                                        Needs {wall.layoutTemplate!.columns}×
                                        {wall.layoutTemplate!.rows} layout
                                    </>
                                ) : (
                                    <>
                                        {connectedNodes} node{connectedNodes !== 1 ? 's' : ''}
                                        {wall.boundProjectId && ' · bound'}
                                    </>
                                )}
                            </div>
                        </div>
                        <MonitorIcon
                            size={16}
                            weight={connectedNodes > 0 ? 'fill' : 'regular'}
                            className={
                                connectedNodes > 0 ? 'text-green-500' : 'text-muted-foreground'
                            }
                        />
                    </button>
                );
            })}
        </div>
    );
}

// ── Popover mode (for toolbar / inline triggers) ─────────────────────────────

interface WallPickerPopoverProps {
    onSelect: (wallId: string) => void;
    trigger?: React.ReactNode;
}

export function WallPickerPopover({ onSelect, trigger }: WallPickerPopoverProps) {
    const [open, setOpen] = useState(false);

    const handleSelect = (wallId: string) => {
        setOpen(false);
        onSelect(wallId);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger nativeButton={false} render={<div />}>
                {trigger ?? (
                    <Button variant="ghost" size="icon">
                        <MonitorIcon />
                    </Button>
                )}
            </PopoverTrigger>
            <PopoverContent className="w-64 p-2" side="bottom" align="start">
                <WallList onSelect={handleSelect} />
            </PopoverContent>
        </Popover>
    );
}

// ── Overlay mode (for gallery / standalone) ──────────────────────────────────

interface WallPickerOverlayProps {
    onSelect: (wallId: string) => void;
    onClose: () => void;
}

export function WallPicker({ onSelect, onClose }: WallPickerOverlayProps) {
    const handleSelect = (wallId: string) => {
        onSelect(wallId);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="w-72 rounded-xl border border-border bg-card p-4 shadow-lg">
                <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">Select a wall</h3>
                    <button
                        onClick={onClose}
                        className="cursor-pointer text-muted-foreground hover:text-foreground"
                    >
                        <XIcon size={16} />
                    </button>
                </div>
                <WallList onSelect={handleSelect} />
            </div>
        </div>
    );
}
