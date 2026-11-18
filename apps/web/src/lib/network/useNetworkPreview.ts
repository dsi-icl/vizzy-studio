import { useEffect, useRef } from 'react';

import type { Network, NetworkView } from './schema';

/** Runs a private worker for the draft/dialog preview. */
export function useNetworkPreview(
    network: Network | undefined,
    enabled: boolean,
    onStatus?: (error: string | null) => void
) {
    const worker = useRef<Worker | null>(null);
    const latest = useRef<NetworkView | undefined>(undefined);
    const status = useRef(onStatus);
    useEffect(() => {
        status.current = onStatus;
    }, [onStatus]);
    useEffect(() => {
        if (!enabled) return;
        try {
            const next = new Worker(new URL('./live.worker.ts', import.meta.url), {
                type: 'module'
            });
            worker.current = next;
            next.onmessage = (event: MessageEvent<{ view?: NetworkView; error?: string }>) => {
                if (event.data.view) latest.current = event.data.view;
                status.current?.(event.data.error ?? null);
            };
            next.onerror = () =>
                status.current?.('Could not start the live preview. Reopen the Network editor.');
            return () => {
                next.terminate();
                worker.current = null;
                latest.current = undefined;
            };
        } catch {
            status.current?.('Could not start the live preview in this browser.');
        }
    }, [enabled]);
    useEffect(() => {
        if (enabled && network) worker.current?.postMessage(network);
    }, [network, enabled]);
    return latest;
}
