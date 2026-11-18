import {
    canSendNonCritical,
    controllersByWallId,
    editorsByScope,
    scopedState,
    scopeWatchers,
    wallPeersByScope,
    type PeerEntry
} from '~/lib/busState.state';
import { encodeNetworkFrame, type NetworkTopology } from '~/lib/network/frames';
import { NetworkSchema, type Network } from '~/lib/network/schema';
import { createNetworkSimulation } from '~/lib/network/simulation';
import { makeScopeLabel } from '~/lib/types';

type Runtime = {
    authored: Network;
    simulation: ReturnType<typeof createNetworkSimulation>;
    epoch: number;
    sequence: number;
    lastSent: number;
    versions: WeakMap<PeerEntry, string>;
};

/** One simulation per active slide/layer, regardless of the number of wall tiles. */
export function startNetworkRuntime() {
    const runtimes = new Map<string, Runtime>();
    const timer = setInterval(() => {
        const active = new Set<string>();
        const now = Date.now();
        for (const [scopeId, scope] of scopedState) {
            if (scope.customRenderUrl) continue;
            const peers = new Set<PeerEntry>([
                ...(editorsByScope.get(scopeId) ?? []),
                ...(wallPeersByScope.get(scopeId) ?? [])
            ]);
            for (const wallId of scopeWatchers.get(scopeId) ?? []) {
                for (const peer of controllersByWallId.get(wallId) ?? []) peers.add(peer);
            }
            if (!peers.size) continue;
            for (const layer of scope.layers.values()) {
                if (layer.type !== 'graph' || !layer.network || !layer.config.visible) continue;
                const key = `${scopeId}:${layer.numericId}`;
                let runtime = runtimes.get(key);
                if (!runtime || runtime.authored !== layer.network) {
                    const parsed = NetworkSchema.safeParse(layer.network);
                    if (!parsed.success) continue;
                    if (!runtime) {
                        runtime = {
                            authored: layer.network,
                            simulation: createNetworkSimulation(parsed.data),
                            epoch: crypto.getRandomValues(new Uint32Array(1))[0]!,
                            sequence: 0,
                            lastSent: 0,
                            versions: new WeakMap()
                        };
                        runtimes.set(key, runtime);
                    } else {
                        runtime.authored = layer.network;
                        runtime.simulation.configure(parsed.data);
                    }
                }
                active.add(key);
                const sim = runtime.simulation;
                const moved = sim.advance(now);
                const version = `${sim.documentKey}:${sim.topologyVersion}`;
                // Refresh a stable/paused graph for rejoining or previously congested peers.
                if (
                    !moved &&
                    now - runtime.lastSent < 1000 &&
                    [...peers].every((peer) => runtime.versions.get(peer) === version)
                )
                    continue;
                const view = sim.view;
                const metadata: NetworkTopology = {
                    type: 'network_topology',
                    scopeKey: makeScopeLabel(scope.projectId, scope.commitId, scope.slideId),
                    scopeId,
                    numericId: layer.numericId,
                    epoch: runtime.epoch,
                    topologyVersion: sim.topologyVersion,
                    documentKey: sim.documentKey,
                    data: view.data
                };
                let json: string | undefined;
                const packet = encodeNetworkFrame({
                    scopeId,
                    numericId: layer.numericId,
                    epoch: runtime.epoch,
                    sequence: ++runtime.sequence,
                    topologyVersion: sim.topologyVersion,
                    serverTime: now,
                    positions: view.positions
                });
                runtime.lastSent = now;
                for (const entry of peers) {
                    if (!canSendNonCritical(entry.peer)) continue;
                    try {
                        if (runtime.versions.get(entry) !== version) {
                            entry.peer.send((json ??= JSON.stringify(metadata)));
                            runtime.versions.set(entry, version);
                        }
                        entry.peer.send(packet);
                    } catch {
                        runtime.versions.delete(entry);
                    }
                }
            }
        }
        for (const [key, runtime] of runtimes) {
            if (!active.has(key)) {
                runtime.simulation.stop();
                runtimes.delete(key);
            }
        }
    }, 50);
    timer.unref?.();
    return () => {
        clearInterval(timer);
        for (const runtime of runtimes.values()) runtime.simulation.stop();
        runtimes.clear();
    };
}
