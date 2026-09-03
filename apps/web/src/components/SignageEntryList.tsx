import {
    DndContext,
    KeyboardSensor,
    PointerSensor,
    closestCenter,
    useSensor,
    useSensors,
    type DragEndEvent
} from '@dnd-kit/core';
import {
    SortableContext,
    arrayMove,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
    ArrowDownIcon,
    ArrowUpIcon,
    DotsSixVerticalIcon,
    TrashIcon,
    WarningIcon
} from '@phosphor-icons/react';
import type { SignageSlideEntry } from '@repo/db/documents';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';

type EntryStatus = {
    entry: SignageSlideEntry;
    valid: boolean;
    reason?: string;
    projectName?: string;
    stageName?: string;
    slideName?: string;
};

function optionalSecondsToMs(value: string, minimumMs: number): number | undefined {
    if (!value.trim()) return undefined;
    const seconds = Number.parseFloat(value);
    if (!Number.isFinite(seconds)) return undefined;
    return Math.max(minimumMs, Math.round(seconds * 1_000));
}

function SortableEntry({
    entry,
    index,
    count,
    status,
    defaultDisplayDurationMs,
    defaultGapDurationMs,
    onUpdate,
    onMove,
    onRemove,
    readOnly
}: {
    entry: SignageSlideEntry;
    index: number;
    count: number;
    status?: EntryStatus;
    defaultDisplayDurationMs: number;
    defaultGapDurationMs: number;
    onUpdate: (patch: Partial<SignageSlideEntry>) => void;
    onMove: (direction: -1 | 1) => void;
    onRemove: () => void;
    readOnly: boolean;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: entry.id,
        disabled: readOnly
    });

    return (
        <div
            ref={setNodeRef}
            style={{
                transform: CSS.Transform.toString(transform),
                transition,
                opacity: isDragging ? 0.55 : 1
            }}
            className="grid items-center gap-2 rounded-lg border bg-card p-3 shadow-xs md:grid-cols-[auto_1fr_150px_150px_auto]"
        >
            <button
                type="button"
                disabled={readOnly}
                className="cursor-grab rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
                aria-label={`Reorder ${status?.slideName ?? entry.slideId}`}
                {...attributes}
                {...listeners}
            >
                <DotsSixVerticalIcon size={18} />
            </button>

            <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                    {status?.slideName ?? entry.slideId}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                    {status?.projectName ?? entry.projectId}
                    {status?.stageName ? ` · ${status.stageName}` : ''}
                </div>
                {status && !status.valid && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-amber-600">
                        <WarningIcon /> Skipped: {status.reason}
                    </div>
                )}
                {!status && (
                    <div className="mt-1 text-xs text-muted-foreground">
                        Save to validate this new entry.
                    </div>
                )}
            </div>

            <Input
                aria-label="Display duration override in seconds"
                type="number"
                min={0.1}
                step={0.1}
                placeholder={`Default (${defaultDisplayDurationMs / 1_000}s)`}
                disabled={readOnly}
                value={entry.displayDurationMs === undefined ? '' : entry.displayDurationMs / 1_000}
                onChange={(event) =>
                    onUpdate({
                        displayDurationMs: optionalSecondsToMs(event.target.value, 100)
                    })
                }
            />
            <Input
                aria-label="Gap duration override in seconds"
                type="number"
                min={0}
                step={0.1}
                placeholder={`Default (${defaultGapDurationMs / 1_000}s)`}
                disabled={readOnly}
                value={entry.gapDurationMs === undefined ? '' : entry.gapDurationMs / 1_000}
                onChange={(event) =>
                    onUpdate({
                        gapDurationMs: optionalSecondsToMs(event.target.value, 0)
                    })
                }
            />

            <div className="flex gap-1">
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Move entry up"
                    disabled={readOnly || index === 0}
                    onClick={() => onMove(-1)}
                >
                    <ArrowUpIcon />
                </Button>
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Move entry down"
                    disabled={readOnly || index === count - 1}
                    onClick={() => onMove(1)}
                >
                    <ArrowDownIcon />
                </Button>
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Remove entry"
                    disabled={readOnly}
                    onClick={onRemove}
                >
                    <TrashIcon />
                </Button>
            </div>
        </div>
    );
}

export function SignageEntryList({
    entries,
    statuses,
    defaultDisplayDurationMs,
    defaultGapDurationMs,
    onChange,
    readOnly = false
}: {
    entries: SignageSlideEntry[];
    statuses: EntryStatus[];
    defaultDisplayDurationMs: number;
    defaultGapDurationMs: number;
    onChange: (entries: SignageSlideEntry[]) => void;
    readOnly?: boolean;
}) {
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );
    const statusByEntryId = new Map(statuses.map((status) => [status.entry.id, status]));

    const handleDragEnd = ({ active, over }: DragEndEvent) => {
        if (readOnly) return;
        if (!over || active.id === over.id) return;
        const from = entries.findIndex(({ id }) => id === active.id);
        const to = entries.findIndex(({ id }) => id === over.id);
        if (from < 0 || to < 0) return;
        onChange(arrayMove(entries, from, to));
    };

    return (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext
                items={entries.map(({ id }) => id)}
                strategy={verticalListSortingStrategy}
            >
                <div className="space-y-2">
                    {entries.map((entry, index) => (
                        <SortableEntry
                            key={entry.id}
                            entry={entry}
                            index={index}
                            count={entries.length}
                            status={statusByEntryId.get(entry.id)}
                            defaultDisplayDurationMs={defaultDisplayDurationMs}
                            defaultGapDurationMs={defaultGapDurationMs}
                            onUpdate={(patch) =>
                                onChange(
                                    entries.map((candidate) =>
                                        candidate.id === entry.id
                                            ? { ...candidate, ...patch }
                                            : candidate
                                    )
                                )
                            }
                            onMove={(direction) => {
                                const target = index + direction;
                                if (target < 0 || target >= entries.length) return;
                                onChange(arrayMove(entries, index, target));
                            }}
                            onRemove={() => onChange(entries.filter(({ id }) => id !== entry.id))}
                            readOnly={readOnly}
                        />
                    ))}
                </div>
            </SortableContext>
        </DndContext>
    );
}
