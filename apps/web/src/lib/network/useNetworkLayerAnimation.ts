import { useEffect, useMemo, useRef } from 'react';

import { initialNetworkPositions, networkDocumentKey } from './document';
import type { NetworkFrameBuffer } from './frames';
import type { Network, NetworkView } from './schema';

// The server also refreshes paused/settled graphs once per second.
const SHARED_FRAME_MAX_AGE_MS = 2500;

/** An editor layer animates locally until shared coordinates are available.
 * Walls keep using their authoritative frame stream; they never run this fallback.
 */
export function useNetworkLayerAnimation(
    network: Network | undefined,
    numericId: number,
    frames: NetworkFrameBuffer | undefined,
    onDraw: () => void
) {
    const view = useRef<NetworkView | undefined>(undefined);
    const documentKey = useMemo(() => (network ? networkDocumentKey(network) : ''), [network]);
    const inputs = useRef({ network, documentKey, onDraw });
    useEffect(() => {
        inputs.current = { network, documentKey, onDraw };
    }, [network, documentKey, onDraw]);

    useEffect(() => {
        let raf = 0;
        let worker: Worker | undefined;
        let local: NetworkView | undefined;
        let attempted = false;
        let lastToken: unknown;
        let activeKey = '';
        let workerKey = '';

        const stopLocal = () => {
            worker?.terminate();
            worker = undefined;
            local = undefined;
            attempted = false;
        };
        const configureLocal = (authored: Network) => {
            // Continue from the last displayed positions, including after Apply.
            // Match by ID so importing a new topology cannot misassign positions.
            const previous = new Map(
                view.current?.data.nodes.map(
                    (node, i) => [node.id, view.current!.positions[i]] as const
                )
            );
            const fallback = authored.positions ?? initialNetworkPositions(authored.data);
            const positions =
                authored.settings.paused && authored.positions
                    ? authored.positions
                    : authored.data.nodes.map((node, i) => previous.get(node.id) ?? fallback[i]!);
            local = { data: authored.data, positions };
            // Reuse an existing simulation across settings changes.
            const next = worker ? authored : { ...authored, positions };
            workerKey = networkDocumentKey(next);
            if (worker) {
                worker.postMessage(next);
                return;
            }
            if (attempted) return;
            attempted = true;
            try {
                worker = new Worker(new URL('./live.worker.ts', import.meta.url), {
                    type: 'module'
                });
                worker.onmessage = (
                    event: MessageEvent<{ view?: NetworkView; documentKey?: string }>
                ) => {
                    if (event.data.documentKey === workerKey && event.data.view)
                        local = event.data.view;
                };
                worker.postMessage(next);
            } catch (error) {
                console.warn('[Network] Could not start editor animation', error);
            }
        };
        const draw = () => {
            const { network: authored, documentKey } = inputs.current;
            if (!authored) {
                stopLocal();
                view.current = undefined;
                raf = requestAnimationFrame(draw);
                return;
            }
            const shared = frames?.sample(
                numericId,
                documentKey,
                undefined,
                SHARED_FRAME_MAX_AGE_MS
            );
            let token: unknown;
            if (shared) {
                if (attempted) stopLocal();
                view.current = shared.view;
                token = shared.token;
            } else {
                if (!attempted || activeKey !== documentKey) configureLocal(authored);
                view.current = local;
                token = local;
            }
            activeKey = documentKey;
            if (token !== lastToken) {
                lastToken = token;
                inputs.current.onDraw();
            }
            raf = requestAnimationFrame(draw);
        };
        draw();
        return () => {
            cancelAnimationFrame(raf);
            stopLocal();
        };
    }, [numericId, frames]);
    return view;
}
