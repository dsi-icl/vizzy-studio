import { createFileRoute } from '@tanstack/react-router';
import { defineHooks } from 'crossws';

import { YCrossws } from '~/server/yjs/yjs.session';

// Route modules can be evaluated more than once during HMR. Keep one owner per
// process so peers never land in independent in-memory document registries.
const yc = (process.__YJS_SERVER__ ??= new YCrossws());

const hooks = defineHooks({
    async open(peer) {
        await yc.onOpen(peer);
    },
    async message(peer, message) {
        await yc.onMessage(peer, message);
    },
    async close(peer) {
        await yc.onClose(peer);
    }
});

process.__YJS_RECOMPUTE_AUTH_CONTEXT__ = async (input?: { email?: string }) => {
    return yc.recomputePeerAuthContexts(input ?? {});
};

export const Route = createFileRoute('/yjs/$')({
    server: {
        handlers: {
            GET: async () => {
                // HTTP fallback response: this endpoint is a websocket upgrade target.
                return Object.assign(
                    new Response('WebSocket upgrade is required.', { status: 426 }),
                    { crossws: hooks }
                );
            }
        }
    }
});
