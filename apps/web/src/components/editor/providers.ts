import { Provider } from '@lexical/yjs';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

import { getWebSocketUrl } from '../../lib/runtimeUrl';

/** Notified as a text layer's provider connects, syncs or drops. */
export type ProviderStatusListener = (event: 'attempt' | 'synced' | 'interrupted') => void;

const statusListeners = new Map<string, Set<ProviderStatusListener>>();

/** Subscribe to connection events for one text layer scope. */
export function observeProviderStatus(id: string, listener: ProviderStatusListener): () => void {
    let listeners = statusListeners.get(id);
    if (!listeners) {
        listeners = new Set();
        statusListeners.set(id, listeners);
    }
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) statusListeners.delete(id);
    };
}

function emitProviderStatus(id: string, event: Parameters<ProviderStatusListener>[0]) {
    const listeners = statusListeners.get(id);
    if (!listeners) return;
    for (const listener of listeners) listener(event);
}

export function createWebsocketProvider(id: string, yjsDocMap: Map<string, Y.Doc>): Provider {
    const doc = getDocFromMap(id, yjsDocMap);

    const provider = new WebsocketProvider(getWebSocketUrl('/yjs'), id, doc, {
        connect: false
    });

    provider.on('status', ({ status }: { status: string }) => {
        if (status === 'connecting') emitProviderStatus(id, 'attempt');
        if (status === 'disconnected') emitProviderStatus(id, 'interrupted');
    });
    provider.on('sync', (isSynced: boolean) => {
        if (isSynced) emitProviderStatus(id, 'synced');
    });

    return provider as unknown as Provider;
}

function getDocFromMap(id: string, yjsDocMap: Map<string, Y.Doc>): Y.Doc {
    let doc = yjsDocMap.get(id);

    if (doc === undefined) {
        doc = new Y.Doc();
        yjsDocMap.set(id, doc);
    } else {
        doc.load();
    }

    return doc;
}
