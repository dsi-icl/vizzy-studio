import type { LayerWithEditorState } from './types';

/**
 * The background is a layer in its own right, and the wall paints it at the very
 * bottom of the stack. "Send to back" therefore means "just above the
 * background": anything pushed below it renders behind the background canvas and
 * vanishes on the wall.
 *
 * Returns only the layers whose zIndex changed — empty when the layer is already
 * at the back. When the slot directly above the background is taken, the whole
 * foreground stack is restacked from that floor upwards (zIndex must stay an
 * integer, so there is nothing to squeeze in between).
 */
export function computeSendToBackUpdates(
    layers: Iterable<LayerWithEditorState>,
    numericId: number
): LayerWithEditorState[] {
    const allLayers = Array.from(layers);
    const target = allLayers.find((l) => l.numericId === numericId);
    if (!target || target.type === 'background') return [];

    const foreground = allLayers.filter((l) => l.type !== 'background');
    const backgroundZIndex = allLayers.reduce(
        (max, l) => (l.type === 'background' ? Math.max(max, l.config.zIndex) : max),
        Number.NEGATIVE_INFINITY
    );
    // -Infinity when there is no background layer, i.e. no floor at all.
    const floorZIndex = backgroundZIndex + 1;

    const isStrictlyLowest = foreground.every(
        (l) => l.numericId === numericId || l.config.zIndex > target.config.zIndex
    );
    if (isStrictlyLowest && target.config.zIndex >= floorZIndex) return [];

    const minZIndex = foreground.reduce((min, l) => Math.min(min, l.config.zIndex), Infinity);
    const desiredZIndex = minZIndex - 1;
    if (desiredZIndex >= floorZIndex)
        return [{ ...target, config: { ...target.config, zIndex: desiredZIndex } }];

    const restacked = [
        target,
        ...foreground
            .filter((l) => l.numericId !== numericId)
            .sort((a, b) => a.config.zIndex - b.config.zIndex)
    ];

    const updates: LayerWithEditorState[] = [];
    restacked.forEach((layer, index) => {
        const zIndex = floorZIndex + index;
        if (layer.config.zIndex === zIndex) return;
        updates.push({ ...layer, config: { ...layer.config, zIndex } });
    });
    return updates;
}
