import {
    broadcastToControllersByWallRaw,
    broadcastToWallNodesRaw,
    upsertControllerTransientLayer,
    type PeerEntry
} from '~/lib/busState';
import type { GSMessage, Layer } from '~/lib/types';

export type ControllerTransientUpsertOrigin = 'controller:add_line_layer' | 'controller:image_zoom';

interface ControllerTransientLayerInput {
    wallId: string;
    layer: Layer;
    origin: ControllerTransientUpsertOrigin;
    rawText?: string;
    exclude?: PeerEntry;
}

export function relayControllerTransientLayer(input: ControllerTransientLayerInput) {
    const payload =
        input.rawText ??
        JSON.stringify({
            type: 'upsert_layer',
            origin: input.origin,
            layer: input.layer
        } satisfies GSMessage);

    broadcastToWallNodesRaw(input.wallId, payload);
    broadcastToControllersByWallRaw(input.wallId, payload, input.exclude);
}

export function applyControllerTransientLayer(input: ControllerTransientLayerInput) {
    upsertControllerTransientLayer(input.wallId, input.layer);
    relayControllerTransientLayer(input);
}
