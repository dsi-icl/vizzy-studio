import { MIN_LAYER_DIMENSION } from '~/lib/fitSizeToViewport';
import type { LayerPositionState } from '~/lib/types';

/**
 * Text layers are centre-anchored — every renderer draws them at `cx`/`cy` with
 * `offsetY = height / 2` — but their glyphs flow from the top of the box. Changing
 * the height around a fixed centre therefore slides the text by half the delta,
 * which is what made an auto-height commit look like it moved the layer.
 *
 * This returns a config whose top edge stays where the author put it, mirroring
 * what the reflow drag in `EditorSlate` does by re-projecting the node origin.
 */
export function resizeHeightFromTopEdge<T extends LayerPositionState>(
    config: T,
    nextHeight: number
): T {
    const height = Math.max(MIN_LAYER_DIMENSION, Math.round(nextHeight));
    const delta = height - config.height;
    if (delta === 0) return config;

    // The top edge sits half a scaled box above the centre, measured along the
    // layer's own rotated Y axis. Growing downwards moves the centre the same
    // distance along that axis, which is a plain `cy` shift only at rotation 0.
    const radians = (config.rotation * Math.PI) / 180;
    const travel = (delta * config.scaleY) / 2;

    return {
        ...config,
        height,
        cx: Math.round(config.cx - Math.sin(radians) * travel),
        cy: Math.round(config.cy + Math.cos(radians) * travel)
    };
}
