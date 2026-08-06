import type { LayerWithEditorState } from './types';

const byZIndex = (a: LayerWithEditorState, b: LayerWithEditorState) =>
    a.config.zIndex - b.config.zIndex;

/** Highest z-index held by a background layer, or -Infinity when there is none. */
function backgroundZIndexOf(allLayers: LayerWithEditorState[]) {
    return allLayers.reduce(
        (max, l) => (l.type === 'background' ? Math.max(max, l.config.zIndex) : max),
        Number.NEGATIVE_INFINITY
    );
}

/** Hand out consecutive z-indices from `floorZIndex` up, keeping only what moved. */
function restack(stack: LayerWithEditorState[], floorZIndex: number) {
    const updates: LayerWithEditorState[] = [];
    stack.forEach((layer, index) => {
        const zIndex = floorZIndex + index;
        if (layer.config.zIndex === zIndex) return;
        updates.push({ ...layer, config: { ...layer.config, zIndex } });
    });
    return updates;
}

function splitSelection(layers: Iterable<LayerWithEditorState>, numericIds: number[]) {
    const allLayers = Array.from(layers);
    const moving = new Set(numericIds);
    // The background owns the floor of the stack and is never moved by these actions.
    const foreground = allLayers.filter((l) => l.type !== 'background');
    return {
        allLayers,
        selected: foreground.filter((l) => moving.has(l.numericId)).sort(byZIndex),
        others: foreground.filter((l) => !moving.has(l.numericId)).sort(byZIndex)
    };
}

/**
 * The background is a layer in its own right, and the wall paints it at the very
 * bottom of the stack. "Send to back" therefore means "just above the
 * background": anything pushed below it renders behind the background canvas and
 * vanishes on the wall.
 *
 * Returns only the layers whose zIndex changed — empty when the selection is
 * already at the back. When the slots directly above the background are taken,
 * the whole foreground stack is restacked from that floor upwards (zIndex must
 * stay an integer, so there is nothing to squeeze in between).
 */
export function computeSendToBackUpdates(
    layers: Iterable<LayerWithEditorState>,
    numericIds: number[]
): LayerWithEditorState[] {
    const { allLayers, selected, others } = splitSelection(layers, numericIds);
    if (!selected.length) return [];

    // -Infinity when there is no background layer, i.e. no floor at all.
    const floorZIndex = backgroundZIndexOf(allLayers) + 1;
    const isAtBack = selected.every((s) => others.every((o) => s.config.zIndex < o.config.zIndex));
    if (isAtBack && selected[0].config.zIndex >= floorZIndex) return [];

    // No others left to sit under: the selection can only go to the floor, which
    // the check above proved is finite.
    const blockStart = others.length ? others[0].config.zIndex - selected.length : floorZIndex;
    if (blockStart >= floorZIndex) return restack(selected, blockStart);

    return restack([...selected, ...others], floorZIndex);
}

/**
 * Nothing caps the top of the stack, so the selection simply takes the next free
 * z-indices — `topZIndex` is expected to sit above every layer in play. Relative
 * order within the selection is preserved.
 */
export function computeBringToFrontUpdates(
    layers: Iterable<LayerWithEditorState>,
    numericIds: number[],
    topZIndex: number
): LayerWithEditorState[] {
    const { selected, others } = splitSelection(layers, numericIds);
    if (!selected.length) return [];

    const isAtFront = selected.every((s) => others.every((o) => s.config.zIndex > o.config.zIndex));
    const isOrdered = selected.every(
        (l, index) => index === 0 || l.config.zIndex > selected[index - 1].config.zIndex
    );
    if (isAtFront && isOrdered) return [];

    return restack(selected, topZIndex);
}

/**
 * A background dropped into an existing deck claims the floor, so any layer
 * sharing or sitting below its z-index has to move up — a tie is enough to lose
 * the layer, since the slide previews sort the background inline and draw it
 * last.
 */
export function computeBackgroundFloorUpdates(
    layers: Iterable<LayerWithEditorState>,
    backgroundZIndex: number
): LayerWithEditorState[] {
    const foreground = Array.from(layers)
        .filter((l) => l.type !== 'background')
        .sort(byZIndex);
    if (!foreground.length || foreground[0].config.zIndex > backgroundZIndex) return [];

    return restack(foreground, backgroundZIndex + 1);
}
