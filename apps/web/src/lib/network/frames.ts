import { z } from '~/lib/zod';

import {
    MAX_NETWORK_NODES,
    NetworkDataSchema,
    type NetworkPositions,
    type NetworkView
} from './schema';

export const NETWORK_FRAME_OPCODE = 0x16;
const HEADER_BYTES = 35;
export const NetworkTopologySchema = z.object({
    type: z.literal('network_topology'),
    scopeKey: z.string(),
    scopeId: z.number().int().nonnegative(),
    numericId: z.number(),
    epoch: z.number().int().nonnegative(),
    topologyVersion: z.number().int().nonnegative(),
    documentKey: z.string(),
    data: NetworkDataSchema
});
export type NetworkTopology = z.infer<typeof NetworkTopologySchema>;
export type NetworkFrame = {
    scopeId: number;
    numericId: number;
    epoch: number;
    sequence: number;
    topologyVersion: number;
    serverTime: number;
    positions: NetworkPositions;
};

export function encodeNetworkFrame(frame: NetworkFrame): ArrayBuffer {
    const buffer = new ArrayBuffer(HEADER_BYTES + frame.positions.length * 8);
    const view = new DataView(buffer);
    view.setUint8(0, NETWORK_FRAME_OPCODE);
    view.setUint32(1, frame.scopeId, true);
    view.setFloat64(5, frame.numericId, true);
    view.setUint32(13, frame.epoch, true);
    view.setUint32(17, frame.sequence, true);
    view.setUint32(21, frame.topologyVersion, true);
    view.setFloat64(25, frame.serverTime, true);
    view.setUint16(33, frame.positions.length, true);
    frame.positions.forEach((p, i) => {
        view.setFloat32(HEADER_BYTES + i * 8, p.x, true);
        view.setFloat32(HEADER_BYTES + i * 8 + 4, p.y, true);
    });
    return buffer;
}

export function decodeNetworkFrame(buffer: ArrayBuffer): NetworkFrame | null {
    if (buffer.byteLength < HEADER_BYTES) return null;
    const view = new DataView(buffer);
    const count = view.getUint16(33, true);
    if (
        view.getUint8(0) !== NETWORK_FRAME_OPCODE ||
        count > MAX_NETWORK_NODES ||
        buffer.byteLength !== HEADER_BYTES + count * 8
    )
        return null;
    const positions = Array.from({ length: count }, (_, i) => ({
        x: view.getFloat32(HEADER_BYTES + i * 8, true),
        y: view.getFloat32(HEADER_BYTES + i * 8 + 4, true)
    }));
    const frame = {
        scopeId: view.getUint32(1, true),
        numericId: view.getFloat64(5, true),
        epoch: view.getUint32(13, true),
        sequence: view.getUint32(17, true),
        topologyVersion: view.getUint32(21, true),
        serverTime: view.getFloat64(25, true),
        positions
    };
    return Number.isFinite(frame.numericId) &&
        Number.isFinite(frame.serverTime) &&
        positions.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
        ? frame
        : null;
}

/** Coordinates stay out of React/Zustand and the saved project. All wall tiles
 * interpolate the same server timestamps, rather than their own arrival times. */
export class NetworkFrameBuffer {
    private scopeKey: string | null = null;
    private layers = new Map<
        number,
        { topology: NetworkTopology; frames: NetworkFrame[]; view: NetworkView; receivedAt: number }
    >();
    constructor(private readonly serverTime: () => number = Date.now) {}
    setScope(key: string | null) {
        if (key !== this.scopeKey) {
            this.layers.clear();
            this.scopeKey = key;
        }
    }
    clear() {
        this.layers.clear();
    }
    remove(numericId: number) {
        this.layers.delete(numericId);
    }
    topology(topology: NetworkTopology) {
        if (topology.scopeKey !== this.scopeKey) return;
        const old = this.layers.get(topology.numericId);
        if (
            old &&
            old.topology.epoch === topology.epoch &&
            old.topology.topologyVersion === topology.topologyVersion &&
            old.topology.documentKey === topology.documentKey
        )
            return;
        this.layers.set(topology.numericId, {
            topology,
            frames: [],
            view: { data: topology.data, positions: [] },
            receivedAt: 0
        });
    }
    receive(buffer: ArrayBuffer) {
        const frame = decodeNetworkFrame(buffer);
        if (!frame) return;
        const layer = this.layers.get(frame.numericId);
        if (
            !layer ||
            layer.topology.scopeId !== frame.scopeId ||
            layer.topology.epoch !== frame.epoch ||
            layer.topology.topologyVersion !== frame.topologyVersion ||
            layer.topology.data.nodes.length !== frame.positions.length
        )
            return;
        const last = layer.frames.at(-1);
        if (last && (frame.sequence <= last.sequence || frame.serverTime < last.serverTime)) return;
        layer.frames.push(frame);
        layer.receivedAt = performance.now();
        if (layer.frames.length > 8) layer.frames.shift();
    }
    sample(
        numericId: number,
        documentKey: string,
        at = this.serverTime() - 100,
        maxAgeMs = Infinity
    ): { view: NetworkView; token: string } | null {
        const layer = this.layers.get(numericId);
        if (!layer || layer.topology.documentKey !== documentKey || !layer.frames.length)
            return null;
        if (performance.now() - layer.receivedAt > maxAgeMs) return null;
        const frames = layer.frames;
        const b = frames.find((frame) => frame.serverTime >= at) ?? frames[frames.length - 1]!;
        const a = frames[Math.max(0, frames.indexOf(b) - 1)]!;
        const t =
            a === b
                ? 1
                : Math.max(
                      0,
                      Math.min(1, (at - a.serverTime) / Math.max(1, b.serverTime - a.serverTime))
                  );
        const out = layer.view.positions;
        b.positions.forEach((p, i) => {
            const start = a.positions[i]!;
            out[i] ??= { x: 0, y: 0 };
            out[i]!.x = start.x + (p.x - start.x) * t;
            out[i]!.y = start.y + (p.y - start.y) * t;
        });
        return {
            view: layer.view,
            token: `${layer.topology.epoch}:${b.sequence}:${t}`
        };
    }
}
