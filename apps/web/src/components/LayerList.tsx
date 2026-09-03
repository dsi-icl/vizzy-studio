import { CaretDownIcon, StackSimpleIcon } from '@phosphor-icons/react';

import { useEditorStore } from '~/lib/editorStore';

import { DraggableList } from './DraggableList';
import { LayerItem } from './LayerItem';

interface LayerListProps {
    titleBarSize?: number;
    collapsed?: boolean;
    onCollapse?: () => void;
    onExpand?: () => void;
}

export function LayerList({ collapsed, onCollapse, onExpand, titleBarSize = 48 }: LayerListProps) {
    const layers = useEditorStore((s) => s.layers);
    const selectedLayerIds = useEditorStore((s) => s.selectedLayerIds);
    const reorderLayers = useEditorStore((s) => s.reorderLayers);
    const toggleLayerSelection = useEditorStore((s) => s.toggleLayerSelection);
    const setHoveredLayerId = useEditorStore((s) => s.setHoveredLayerId);
    const stageLayout = useEditorStore((s) => s.stageLayout);

    const sortedLayers = Array.from(layers.values()).sort(
        (a, b) => b.config.zIndex - a.config.zIndex
    );
    // Background layer is managed via the toolbar popover — filter it from the list
    const displayLayers = sortedLayers.filter((l) => l.type !== 'background');
    const bgLayers = sortedLayers.filter((l) => l.type === 'background');

    const toggleCollapse = () => {
        setHoveredLayerId(null);
        if (collapsed) onExpand?.();
        else onCollapse?.();
    };
    const goToLayer = (layerId: string) => {
        const numericId = Number.parseInt(layerId, 10);
        if (!Number.isFinite(numericId)) return;
        const layer = layers.get(numericId);
        if (!layer) return;

        const slate = document.getElementById('slate');
        if (!(slate instanceof HTMLDivElement)) return;

        const logicalWidth = stageLayout.columns * stageLayout.screenWidth;
        const logicalHeight = stageLayout.rows * stageLayout.screenHeight;
        const scaleX = slate.scrollWidth / Math.max(1, logicalWidth);
        const scaleY = slate.scrollHeight / Math.max(1, logicalHeight);
        const targetLeft = layer.config.cx * scaleX - slate.clientWidth / 2;
        const targetTop = layer.config.cy * scaleY - slate.clientHeight / 2;
        const maxLeft = Math.max(0, slate.scrollWidth - slate.clientWidth);
        const maxTop = Math.max(0, slate.scrollHeight - slate.clientHeight);

        slate.scrollTo({
            left: Math.max(0, Math.min(maxLeft, targetLeft)),
            top: Math.max(0, Math.min(maxTop, targetTop)),
            behavior: 'smooth'
        });
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-muted/30">
            <button
                onClick={toggleCollapse}
                className="flex shrink-0 cursor-pointer items-center justify-between border-b border-border bg-muted/50 px-4"
                style={{ height: titleBarSize }}
            >
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <StackSimpleIcon size={18} weight="bold" /> Layers
                </h2>
                <CaretDownIcon
                    size={14}
                    weight="bold"
                    className={`text-muted-foreground transition-transform ${collapsed ? '' : 'rotate-180'}`}
                />
            </button>

            {!collapsed && (
                <div className="flex-1 space-y-1 overflow-y-auto p-2">
                    <DraggableList
                        items={displayLayers.map((layer) => ({
                            ...layer,
                            id: layer.numericId.toString()
                        }))}
                        selectedIds={selectedLayerIds}
                        onReorder={(reorderedItems) => {
                            const newLayers = reorderedItems.map((item) => {
                                const existingLayer = layers.get(parseInt(item.id));
                                if (!existingLayer) {
                                    throw new Error('Could not find existing layer');
                                }
                                return existingLayer;
                            });
                            // Preserve background layers at z-index 0 (prepend to z-ordered array)
                            reorderLayers([...bgLayers, ...newLayers.reverse()]);
                        }}
                        onSelect={toggleLayerSelection}
                        onItemDoubleClick={(item) => goToLayer(item.id)}
                        onItemHover={(item) => setHoveredLayerId(item?.id ?? null)}
                        isItemDisabled={(item) => Boolean(item.config.locked)}
                        itemRenderer={(layer, { isSelected }) => (
                            <LayerItem layer={layer} isSelected={isSelected} />
                        )}
                        overlayRenderer={(layer) => (
                            <LayerItem
                                layer={layer}
                                isSelected={selectedLayerIds.includes(layer.id)}
                            />
                        )}
                        multiDragLabel={(count) => (
                            <div className="rounded-md border border-border bg-card p-2 text-primary shadow-lg">
                                {count} layers
                            </div>
                        )}
                    />
                </div>
            )}
        </div>
    );
}
