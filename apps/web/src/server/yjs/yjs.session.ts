import { createHash } from 'node:crypto';

import { type Message, type Peer } from 'crossws';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import type { PeerMeta } from '~/lib/busState';
import { logAuditDenied } from '~/server/audit';
import { canEditProject } from '~/server/projectAuthz';
import { resolveAuthContextFromRequest } from '~/server/requestAuthContext';

import { applyHtmlToDoc, yDocToHtml } from './lexical';
import {
    messageSync,
    messageAwareness,
    MongoYDocPersistence,
    SharedDoc,
    loadTextLayer,
    type DocScope,
    type Persistence,
    type TextLayer
} from './yjs.doc';

const YJS_DEBUG = process.env.YJS_DEBUG === 'true';
const YJS_OPEN_WAIT_TIMEOUT_MS = 5_000;

type EditorPeerMeta = Extract<PeerMeta, { specimen: 'editor' }>;

type YjsPeerState = {
    meta?: EditorPeerMeta;
    openReady?: boolean;
    openPromise?: Promise<void>;
    doc?: SharedDoc;
    scope?: DocScope;
};

type BridgePayload = {
    projectId: string;
    commitId: string;
    slideId: string;
    layerId: number;
    textHtml: string;
    fallbackLayer?: TextLayer;
};

const YJS_PEER_STATE_KEY = '__yjsState';

function debugLog(...args: unknown[]) {
    if (YJS_DEBUG) console.log('[YJS]', ...args);
}

function sha1(input: string): string {
    return createHash('sha1').update(input).digest('hex');
}

export function getYjsPeerState(peer: Peer): YjsPeerState | null {
    const state = (peer as any)[YJS_PEER_STATE_KEY];
    if (!state || typeof state !== 'object') return null;
    return state as YjsPeerState;
}

export function setYjsPeerState(peer: Peer, state: YjsPeerState) {
    (peer as any)[YJS_PEER_STATE_KEY] = state;
}

export function clearYjsPeerState(peer: Peer) {
    delete (peer as any)[YJS_PEER_STATE_KEY];
}

export async function waitForOpenCompletion(
    peer: Peer,
    timeoutMs = YJS_OPEN_WAIT_TIMEOUT_MS
): Promise<boolean> {
    const state = getYjsPeerState(peer);
    if (!state) return false;
    if (state.openReady) return true;
    if (!state.openPromise) return false;

    const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('open_timeout')), timeoutMs);
    });

    try {
        await Promise.race([state.openPromise, timeout]);
    } catch {
        return false;
    }

    return getYjsPeerState(peer)?.openReady === true;
}

export function getDocName(peer: Peer): string {
    const rawUrl = peer.request?.url;
    if (!rawUrl) throw new Error('Peer URL missing');
    const url = new URL(rawUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 0) throw new Error('Invalid YJS doc path');
    if (parts[0] === 'yjs' && parts.length > 1) {
        return decodeURIComponent(parts.slice(1).join('/'));
    }
    return decodeURIComponent(parts.join('/'));
}

export function parseScope(docName: string): DocScope {
    const parts = docName.split('_');
    if (parts.length !== 4) {
        throw new Error(`Invalid docName format: ${docName}`);
    }
    const [projectId, commitId, slideId, layerIdRaw] = parts;
    if (!/^[0-9a-f]{24}$/i.test(projectId) || !/^[0-9a-f]{24}$/i.test(commitId)) {
        throw new Error(`Invalid projectId/commitId in docName: ${docName}`);
    }
    const layerId = Number.parseInt(layerIdRaw, 10);
    if (!Number.isInteger(layerId)) {
        throw new Error(`Invalid numeric layerId in docName: ${docName}`);
    }
    return { projectId, commitId, slideId, layerId };
}

export class YCrossws {
    persistence: Persistence;
    docs: Map<string, SharedDoc> = new Map();
    initializing: Map<string, Promise<SharedDoc>> = new Map();
    peers: Set<Peer> = new Set();

    constructor() {
        this.persistence = new MongoYDocPersistence();
    }

    async onOpen(peer: Peer) {
        const existing = getYjsPeerState(peer) ?? ({} satisfies YjsPeerState);
        if (!getYjsPeerState(peer)) setYjsPeerState(peer, existing);

        if (existing.openReady) return;
        if (existing.openPromise) {
            await existing.openPromise;
            return;
        }

        const openPromise = (async (): Promise<void> => {
            try {
                const {
                    authContext: { user }
                } = await resolveAuthContextFromRequest(peer.request);
                if (!user) {
                    const latest = getYjsPeerState(peer) ?? existing;
                    setYjsPeerState(peer, { ...latest });
                    await logAuditDenied({
                        action: 'YJS_SESSION_DENIED',
                        reasonCode: 'MISSING_SESSION',
                        resourceType: 'scope',
                        executionContext: {
                            surface: 'yjs',
                            operation: 'onOpen',
                            peerId: peer.id
                        }
                    });
                    throw new Error('unauthenticated');
                }
                const userEmail = user.email;
                const docName = getDocName(peer);
                const scope = parseScope(docName);
                const canEdit = await canEditProject(
                    { email: userEmail, role: user.role },
                    scope.projectId
                );
                if (!canEdit) {
                    await logAuditDenied({
                        action: 'YJS_SESSION_DENIED',
                        reasonCode: 'PROJECT_EDIT_FORBIDDEN',
                        projectId: scope.projectId,
                        resourceType: 'scope',
                        resourceId: docName,
                        authContext: { user: { email: userEmail, role: user.role } },
                        executionContext: {
                            surface: 'yjs',
                            operation: 'onOpen',
                            peerId: peer.id
                        }
                    });
                    throw new Error('forbidden');
                }

                const latestAuthed = getYjsPeerState(peer) ?? existing;
                setYjsPeerState(peer, {
                    ...latestAuthed,
                    meta: {
                        specimen: 'editor',
                        authContext: {
                            user: { email: userEmail, role: user.role }
                        }
                    },
                    scope
                });

                this.peers.add(peer);

                const doc = await this.getDoc(peer);
                const encoder = encoding.createEncoder();
                encoding.writeVarUint(encoder, messageSync);
                syncProtocol.writeSyncStep1(encoder, doc);
                peer.send(encoding.toUint8Array(encoder));

                const awarenessStates = doc.awareness.getStates();
                if (awarenessStates.size > 0) {
                    const awarenessEncoder = encoding.createEncoder();
                    encoding.writeVarUint(awarenessEncoder, messageAwareness);
                    encoding.writeVarUint8Array(
                        awarenessEncoder,
                        awarenessProtocol.encodeAwarenessUpdate(doc.awareness, [
                            ...awarenessStates.keys()
                        ])
                    );
                    peer.send(encoding.toUint8Array(awarenessEncoder));
                }
                const latest = getYjsPeerState(peer) ?? existing;
                setYjsPeerState(peer, {
                    ...latest,
                    openReady: true,
                    openPromise: undefined
                });
            } catch (error) {
                const latest = getYjsPeerState(peer) ?? existing;
                setYjsPeerState(peer, {
                    ...latest,
                    openReady: false,
                    openPromise: undefined
                });
                throw error;
            }
        })();

        setYjsPeerState(peer, {
            ...(getYjsPeerState(peer) ?? existing),
            openReady: false,
            openPromise
        });

        try {
            await openPromise;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message === 'unauthenticated') {
                console.warn(`[YJS] Rejecting unauthenticated peer ${peer.id}`);
            } else if (message === 'forbidden') {
                console.warn(`[YJS] Rejecting unauthorized peer ${peer.id}`);
            } else {
                console.error('[YJS] Failed to open peer:', error);
            }
            peer.close();
        }
    }

    async onMessage(peer: Peer, message: Message) {
        const ready = await waitForOpenCompletion(peer);
        if (!ready) {
            console.warn(`[YJS] Message from unknown peer ${peer.id}`);
            peer.close();
            return;
        }

        let doc: SharedDoc;
        try {
            doc = await this.getDoc(peer);
        } catch (error) {
            console.error('[YJS] Failed to resolve doc on message:', error);
            peer.close();
            return;
        }

        try {
            const encoder = encoding.createEncoder();
            const data = message.uint8Array();
            const decoder = decoding.createDecoder(data);
            const messageType = decoding.readVarUint(decoder);
            switch (messageType) {
                case messageSync: {
                    encoding.writeVarUint(encoder, messageSync);
                    syncProtocol.readSyncMessage(decoder, encoder, doc, peer);
                    if (encoding.length(encoder) > 1) {
                        peer.send(encoding.toUint8Array(encoder));
                    }
                    break;
                }
                case messageAwareness: {
                    awarenessProtocol.applyAwarenessUpdate(
                        doc.awareness,
                        decoding.readVarUint8Array(decoder),
                        peer
                    );
                    break;
                }
            }
        } catch (error) {
            console.error(error);
            // @ts-expect-error yjs event typing
            doc.emit('error', [error]);
        }
    }

    async onClose(peer: Peer) {
        this.peers.delete(peer);
        const state = getYjsPeerState(peer);
        const doc = state?.doc;
        clearYjsPeerState(peer);
        if (!doc) return;
        if (!doc.peerIds.has(peer)) return;

        const controlledIds = doc.peerIds.get(peer) || [];
        doc.peerIds.delete(peer);
        awarenessProtocol.removeAwarenessStates(doc.awareness, [...controlledIds], undefined);

        if (doc.peerIds.size === 0) {
            doc.stopSyncLoop();
            await this.flushDoc(doc);
            await this.persistence.writeState(doc.name, doc).catch((err) => {
                console.error('[YJS] Failed to persist doc on close:', err);
            });
            doc.destroy();
            this.docs.delete(doc.name);
        }
    }

    onDocUpdate(update: Uint8Array, _origin: unknown, doc: Y.Doc, _transaction: Y.Transaction) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.writeUpdate(encoder, update);
        const message = encoding.toUint8Array(encoder);
        for (const peer of (doc as SharedDoc).peerIds.keys()) {
            peer.send(message);
        }
    }

    async flushDoc(doc: SharedDoc): Promise<void> {
        if (!doc.dirty) return;
        if (doc.flushPromise) {
            await doc.flushPromise;
            return;
        }

        doc.flushPromise = (async () => {
            doc.dirty = false;
            await this.persistence.writeState(doc.name, doc);

            const html = await yDocToHtml(doc, doc.name);
            const nextHash = sha1(html);
            if (doc.lastHtmlHash === nextHash) return;
            doc.lastHtmlHash = nextHash;

            const payload: BridgePayload = {
                projectId: doc.scope.projectId,
                commitId: doc.scope.commitId,
                slideId: doc.scope.slideId,
                layerId: doc.scope.layerId,
                textHtml: html,
                fallbackLayer: doc.fallbackLayer ?? undefined
            };

            const sent = await process.__YJS_UPSERT_LAYER__?.(payload);
            debugLog('flushDoc', doc.name, { sent, hash: nextHash });
        })()
            .catch((error) => {
                console.error('[YJS] flushDoc failed:', error);
                doc.dirty = true;
            })
            .finally(() => {
                doc.flushPromise = null;
            });

        await doc.flushPromise;
    }

    private async createDoc(docName: string): Promise<SharedDoc> {
        const scope = parseScope(docName);
        const doc = new SharedDoc(docName, scope, this);
        doc.gc = true;
        this.docs.set(docName, doc);

        try {
            const layer = await loadTextLayer(scope);
            doc.fallbackLayer = layer;

            const hydrated = await this.persistence.bindState(docName, doc);
            if (!hydrated) {
                await applyHtmlToDoc(doc, layer.textHtml, docName);
                // Seeding from stored HTML is a read, not an edit. Persist the
                // snapshot so later opens use the faithful CRDT state, but leave
                // the layer alone — the importer narrows markup it cannot model
                // (a heading becomes a paragraph), and a read must never write
                // that narrowing back. The first real edit upgrades the record.
                doc.lastHtmlHash = sha1(layer.textHtml);
                doc.dirty = false;
                await this.persistence.writeState(docName, doc);
            }
            doc.startSyncLoop();
            return doc;
        } catch (error) {
            this.docs.delete(docName);
            doc.stopSyncLoop();
            doc.destroy();
            throw error;
        }
    }

    async getDoc(peer: Peer): Promise<SharedDoc> {
        const state = getYjsPeerState(peer);
        const email = state?.meta?.authContext?.user?.email;
        if (!state || typeof email !== 'string' || email.length === 0) {
            throw new Error('Missing authenticated YJS peer state');
        }
        if (state.doc) return state.doc;

        const docName = getDocName(peer);
        let doc = this.docs.get(docName);
        if (!doc) {
            let pending = this.initializing.get(docName);
            if (!pending) {
                pending = this.createDoc(docName);
                this.initializing.set(docName, pending);
            }
            try {
                doc = await pending;
            } finally {
                this.initializing.delete(docName);
            }
        }

        if (!doc.peerIds.has(peer)) doc.peerIds.set(peer, new Set());
        setYjsPeerState(peer, { ...state, doc });
        return doc;
    }

    async recomputePeerAuthContexts(input: { email?: string } = {}) {
        let inspected = 0;
        let refreshed = 0;
        let disconnected = 0;

        for (const peer of this.peers) {
            const state = getYjsPeerState(peer);
            const currentEmail = state?.meta?.authContext?.user?.email ?? null;
            if (input.email && currentEmail !== input.email) continue;
            inspected += 1;

            const {
                authContext: { user }
            } = await resolveAuthContextFromRequest(peer.request);
            if (!user) {
                if (state) {
                    setYjsPeerState(peer, { ...state });
                }
                await logAuditDenied({
                    action: 'YJS_SESSION_DENIED',
                    reasonCode: 'MISSING_SESSION_RECOMPUTE',
                    projectId: state?.scope?.projectId ?? null,
                    resourceType: 'scope',
                    resourceId: state?.scope
                        ? `${state.scope.projectId}_${state.scope.commitId}_${state.scope.slideId}_${state.scope.layerId}`
                        : null,
                    authContext: state?.meta?.authContext ?? { guest: true },
                    executionContext: {
                        surface: 'yjs',
                        operation: 'recomputePeerAuthContexts',
                        peerId: peer.id
                    }
                });
                try {
                    peer.close();
                } catch {
                    // no-op
                }
                disconnected += 1;
                continue;
            }
            const nextEmail = user.email;
            const scopeProjectId = state?.scope?.projectId ?? null;
            if (scopeProjectId) {
                const allowed = await canEditProject(
                    { email: nextEmail, role: user.role },
                    scopeProjectId
                );
                if (!allowed) {
                    await logAuditDenied({
                        action: 'YJS_SESSION_DENIED',
                        reasonCode: 'PROJECT_EDIT_FORBIDDEN_RECOMPUTE',
                        projectId: scopeProjectId,
                        resourceType: 'scope',
                        resourceId: state?.scope
                            ? `${state.scope.projectId}_${state.scope.commitId}_${state.scope.slideId}_${state.scope.layerId}`
                            : null,
                        authContext: {
                            ...(state?.meta?.authContext ?? {}),
                            user: { email: nextEmail, role: user.role }
                        },
                        executionContext: {
                            surface: 'yjs',
                            operation: 'recomputePeerAuthContexts',
                            peerId: peer.id
                        }
                    });
                    try {
                        peer.close();
                    } catch {
                        // no-op
                    }
                    disconnected += 1;
                    continue;
                }
            }

            if (state) {
                setYjsPeerState(peer, {
                    ...state,
                    meta: {
                        specimen: 'editor',
                        ...(state.meta?.scope ? { scope: state.meta.scope } : {}),
                        authContext: {
                            ...(state.meta?.authContext ?? {}),
                            user: { email: nextEmail, role: user.role }
                        }
                    }
                });
            }

            if (nextEmail !== currentEmail) {
                refreshed += 1;
            }
        }

        return { inspected, refreshed, disconnected };
    }
}
