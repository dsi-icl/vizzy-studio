import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    useDndContext,
    DragEndEvent,
    DragStartEvent,
    DragOverlay
} from '@dnd-kit/core';
import {
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import React, { useState } from 'react';

interface DraggableItem {
    id: string;
}

interface DraggableListProps<T extends DraggableItem> {
    items: T[];
    selectedIds: string[];
    onReorder: (items: T[]) => void;
    onSelect: (id: string, shiftKey: boolean, ctrlKey: boolean) => void;
    onItemDoubleClick?: (item: T) => void;
    onItemHover?: (item: T | null) => void;
    isItemDisabled?: (item: T) => boolean;
    itemRenderer: (item: T, props: { isSelected: boolean }) => React.ReactNode;
    overlayRenderer: (item: T) => React.ReactNode;
    multiDragLabel?: (count: number) => React.ReactNode;
}

function SortableItem<T extends DraggableItem>({
    item,
    selectedIds,
    onSelect,
    onItemDoubleClick,
    onItemHover,
    isItemDisabled,
    itemRenderer
}: {
    item: T;
    selectedIds: string[];
    onSelect: (id: string, shiftKey: boolean, ctrlKey: boolean) => void;
    onItemDoubleClick?: (item: T) => void;
    onItemHover?: (item: T | null) => void;
    isItemDisabled?: (item: T) => boolean;
    itemRenderer: (item: T, props: { isSelected: boolean }) => React.ReactNode;
}) {
    const isDisabled = isItemDisabled?.(item) ?? false;
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: item.id,
        disabled: isDisabled
    });
    const { active } = useDndContext();

    const isSelected = selectedIds.includes(item.id);

    const isAnotherSelectedDragging =
        active && active.id !== item.id && selectedIds.includes(active.id as string);

    if (isAnotherSelectedDragging && isSelected) {
        return null;
    }

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1
    };

    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        onSelect(item.id, e.shiftKey, e.ctrlKey || e.metaKey);
    };
    const handleDoubleClick = () => {
        onItemDoubleClick?.(item);
    };
    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(item.id, e.shiftKey, e.ctrlKey || e.metaKey);
        }
    };

    return (
        <div
            ref={setNodeRef}
            style={style}
            {...attributes}
            {...listeners}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onKeyDown={handleKeyDown}
            onMouseEnter={() => onItemHover?.(item)}
            onMouseLeave={() => onItemHover?.(null)}
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
            role="button"
            tabIndex={0}
            className={isDisabled ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'}
        >
            {itemRenderer(item, { isSelected })}
        </div>
    );
}

export function DraggableList<T extends DraggableItem>({
    items,
    selectedIds,
    onReorder,
    onSelect,
    onItemDoubleClick,
    onItemHover,
    isItemDisabled,
    itemRenderer,
    overlayRenderer,
    multiDragLabel
}: DraggableListProps<T>) {
    const [activeId, setActiveId] = useState<string | null>(null);
    const activeItem = items.find((item) => item.id === activeId);

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 5
            }
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates
        })
    );

    const handleDragStart = (event: DragStartEvent) => {
        onItemHover?.(null);
        setActiveId(event.active.id as string);
    };

    const handleDragEnd = (event: DragEndEvent) => {
        setActiveId(null);
        const { active, over } = event;
        if (!over) return;

        const activeId = active.id as string;
        const overId = over.id as string;
        if (activeId === overId) return;

        const itemsToMove =
            selectedIds.length > 1 && selectedIds.includes(activeId) ? selectedIds : [activeId];

        if (itemsToMove.some((id) => id === overId)) return;

        const activeIndex = items.findIndex((item) => item.id === activeId);
        const overIndex = items.findIndex((item) => item.id === overId);
        const draggingDown = activeIndex < overIndex;

        const selectedAndSorted = itemsToMove
            .map((id) => items.find((item) => item.id === id)!)
            .filter(Boolean)
            .sort((a, b) => items.indexOf(a) - items.indexOf(b));

        const newItems = items.filter((item) => !itemsToMove.includes(item.id));
        const overItemIndex = newItems.findIndex((item) => item.id === overId);

        const slicePoint = overItemIndex + (draggingDown ? 1 : 0);
        const part1 = newItems.slice(0, slicePoint);
        const part2 = newItems.slice(slicePoint);

        onReorder([...part1, ...selectedAndSorted, ...part2]);
    };

    const isMultiDrag =
        activeItem && selectedIds.length > 1 && selectedIds.includes(activeId as string);

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
        >
            <SortableContext
                items={items.map((item) => item.id)}
                strategy={verticalListSortingStrategy}
            >
                {items.map((item) => (
                    <SortableItem
                        key={item.id}
                        item={item}
                        selectedIds={selectedIds}
                        onSelect={onSelect}
                        onItemDoubleClick={onItemDoubleClick}
                        onItemHover={onItemHover}
                        isItemDisabled={isItemDisabled}
                        itemRenderer={itemRenderer}
                    />
                ))}
            </SortableContext>
            <DragOverlay>
                {activeItem
                    ? isMultiDrag && multiDragLabel
                        ? multiDragLabel(selectedIds.length)
                        : overlayRenderer(activeItem)
                    : null}
            </DragOverlay>
        </DndContext>
    );
}
