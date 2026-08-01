import { type Message, type Peer } from 'crossws';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import type { PeerMeta } from '~/lib/busState';
import { logAuditDenied } from '~/server/audit';
import { dbCol } from '~/server/collections';
import { canEditProject } from '~/server/projectAuthz';
import { resolveAuthContextFromRequest } from '~/server/requestAuthContext';

import { applyHtmlToDoc, yDocToHtml } from './lexical';
import {
    messageSync,
    messageAwareness,
    hashBytes,
    hashText,
    INITIALIZATION_ORIGIN,
    LEXICAL_YJS_BINDING_VERSION,
    MongoYDocPersistence,
    PERSISTENCE_ORIGIN,
    SharedDoc,
    loadTextLayer,
    type DocScope,
    type Persistence,
    type TextLayer
} from './yjs.doc';
import { shouldRebuildYjsFromCommit } from './yjs.hydration';
import { ReadyDocumentRegistry } from './yjs.lifecycle';

const YJS_DEBUG = process.env.YJS_DEBUG === 'true';
const YJS_OPEN_WAIT_TIMEOUT_MS = 15_000;

type EditorPeerMeta = Extract<PeerMeta, { specimen: 'editor' }>;

type YjsPeerState = {
    meta?: EditorPeerMeta;
    openReady?: boolean;
    openPromise?: Promise<void>;
    doc?: SharedDoc;
    scope?: DocScope;
    closed?: boolean;
};

type BridgePayload = {
    projectId: string;
    commitId: string;
    slideId: string;
    layerId: number;
    textHtml: string;
    textRevision: number;
    textStateHash: string;
    textBindingVersion: string;
    fallbackLayer?: TextLayer;
};

const YJS_PEER_STATE_KEY = '__yjsState';

function debugLog(...args: unknown[]) {
    if (YJS_DEBUG) console.log('[YJS]', ...args);
}

function isSemanticallyEmptyHtml(html: string): boolean {
    return (
        html
            .replace(/<br\s*\/?>/gi, '')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;|&#160;/gi, '')
            .trim().length === 0
    );
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

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('open_timeout')), timeoutMs);
    });

    try {
        await Promise.race([state.openPromise, timeout]);
    } catch {
        return false;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
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
    registry = new ReadyDocumentRegistry<SharedDoc>();
    docs = this.registry.ready;
    initializing = this.registry.initializing;
    closing = this.registry.closing;
    initializationWaiters: Map<string, number> = new Map();
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
                if (latestAuthed.closed) throw new Error('peer_closed');
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
                if (getYjsPeerState(peer)?.closed) {
                    await this.releasePeer(peer, doc);
                    return;
                }
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
                this.peers.delete(peer);
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
            } else if (message === 'peer_closed') {
                debugLog(`Peer ${peer.id} closed during initialization`);
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
        if (state) {
            setYjsPeerState(peer, { ...state, closed: true, openReady: false });
        }
        const doc = state?.doc;
        if (!doc) return;
        await this.releasePeer(peer, doc);
    }

    private async releasePeer(peer: Peer, doc: SharedDoc) {
        if (!doc.peerIds.has(peer)) return;

        const controlledIds = doc.peerIds.get(peer) || [];
        doc.peerIds.delete(peer);
        awarenessProtocol.removeAwarenessStates(doc.awareness, [...controlledIds], undefined);

        await this.closeDocIfUnused(doc);
    }

    private async closeDocIfUnused(doc: SharedDoc) {
        if (doc.peerIds.size > 0 || doc.lifecycle !== 'ready') return;

        // Quarantine the document synchronously. A reconnect must wait for this
        // close to finish and can never attach to a doc that is about to be destroyed.
        doc.lifecycle = 'closing';
        doc.stopSyncLoop();

        await this.registry.close(doc.name, doc, async () => {
            let safeToDestroy = false;
            try {
                await this.syncDoc(doc);
                for (let attempt = 0; doc.dirty && attempt < 3; attempt += 1) {
                    await this.flushDoc(doc);
                }
                if (doc.dirty) throw new Error(`Yjs document remained dirty: ${doc.name}`);
                safeToDestroy = true;
            } catch (error) {
                console.error('[YJS] Failed to persist doc on close:', error);
                // Keep the live CRDT in memory and retry in the background. This
                // is preferable to acknowledging a close and losing edits during
                // a transient database/projection outage.
                doc.lifecycle = 'ready';
                this.docs.set(doc.name, doc);
                doc.startSyncLoop();
            } finally {
                if (safeToDestroy) {
                    doc.lifecycle = 'destroyed';
                    doc.destroy();
                }
            }
        });
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
        if (!doc.dirty || doc.lifecycle === 'destroyed') return;
        if (doc.flushPromise) {
            await doc.flushPromise;
            return;
        }

        doc.flushPromise = (async () => {
            const snapshot = Y.encodeStateAsUpdate(doc);
            const stateHash = hashBytes(snapshot);
            const html = await this.renderUpdate(snapshot, doc.name);
            const result = await this.persistence.writeState(doc.name, snapshot, {
                stateHash,
                htmlHash: hashText(html),
                sourceTextHash: doc.sourceTextHash,
                bindingVersion: LEXICAL_YJS_BINDING_VERSION,
                ...(doc.replacePersistenceRevision !== null
                    ? { replaceRevision: doc.replacePersistenceRevision }
                    : {})
            });
            doc.replacePersistenceRevision = null;
            Y.applyUpdate(doc, result.update, PERSISTENCE_ORIGIN);
            doc.persistenceRevision = result.revision;
            doc.persistedStateHash = result.stateHash;

            const persistedHtml = result.mergedConcurrentState
                ? await this.renderUpdate(result.update, doc.name)
                : html;
            await this.projectSnapshot(doc, persistedHtml, result.revision, result.stateHash);

            // An update may have arrived while the immutable snapshot was being
            // written. Never clear dirty unless the live doc is exactly persisted.
            doc.dirty = hashBytes(Y.encodeStateAsUpdate(doc)) !== result.stateHash;
        })()
            .catch((error) => {
                console.error('[YJS] flushDoc failed:', error);
                doc.dirty = true;
                throw error;
            })
            .finally(() => {
                doc.flushPromise = null;
            });

        await doc.flushPromise;
    }

    async syncDoc(doc: SharedDoc): Promise<void> {
        if (doc.lifecycle === 'destroyed') return;
        if (doc.syncPromise) {
            await doc.syncPromise;
            return;
        }

        doc.syncPromise = (async () => {
            const persisted = await this.persistence.readState(doc.name);
            let pulledRemoteState = false;
            if (persisted && persisted.revision > doc.persistenceRevision) {
                Y.applyUpdate(doc, persisted.update, PERSISTENCE_ORIGIN);
                doc.persistenceRevision = persisted.revision;
                doc.persistedStateHash = persisted.stateHash;
                pulledRemoteState = true;
            }

            if (doc.dirty) {
                await this.flushDoc(doc);
            } else if (pulledRemoteState && persisted) {
                const html = await this.renderUpdate(persisted.update, doc.name);
                await this.projectSnapshot(doc, html, persisted.revision, persisted.stateHash);
            } else {
                await this.retryBridge(doc);
            }
        })()
            .catch((error) => {
                console.error('[YJS] syncDoc failed:', error);
                throw error;
            })
            .finally(() => {
                doc.syncPromise = null;
                if (doc.lifecycle === 'ready' && doc.peerIds.size === 0) {
                    queueMicrotask(() => void this.closeDocIfUnused(doc));
                }
            });
        await doc.syncPromise;
    }

    private async renderUpdate(update: Uint8Array, docName: string): Promise<string> {
        const snapshotDoc = new Y.Doc();
        try {
            Y.applyUpdate(snapshotDoc, update, PERSISTENCE_ORIGIN);
            return await yDocToHtml(snapshotDoc, docName);
        } finally {
            snapshotDoc.destroy();
        }
    }

    private async projectSnapshot(
        doc: SharedDoc,
        html: string,
        revision: number,
        stateHash: string
    ): Promise<void> {
        if (revision < doc.lastProjectedRevision) return;
        const updated = await dbCol.commits.updateTextLayerProjection({
            commitId: doc.scope.commitId,
            slideId: doc.scope.slideId,
            layerId: doc.scope.layerId,
            textHtml: html,
            textRevision: revision,
            textStateHash: stateHash,
            textBindingVersion: LEXICAL_YJS_BINDING_VERSION
        });
        if (!updated) {
            const latest = await loadTextLayer(doc.scope);
            if ((latest.textRevision ?? 0) > revision) return;
            throw new Error(`Text layer projection target disappeared for ${doc.name}`);
        }
        doc.lastHtmlHash = hashText(html);
        doc.lastProjectedRevision = revision;
        doc.pendingBridgeProjection = { html, revision, stateHash };
        await this.retryBridge(doc);
    }

    private async retryBridge(doc: SharedDoc): Promise<void> {
        const projection = doc.pendingBridgeProjection;
        if (!projection) return;
        const payload: BridgePayload = {
            projectId: doc.scope.projectId,
            commitId: doc.scope.commitId,
            slideId: doc.scope.slideId,
            layerId: doc.scope.layerId,
            textHtml: projection.html,
            textRevision: projection.revision,
            textStateHash: projection.stateHash,
            textBindingVersion: LEXICAL_YJS_BINDING_VERSION,
            fallbackLayer: doc.fallbackLayer ?? undefined
        };
        const bridge = process.__YJS_UPSERT_LAYER__;
        if (!bridge) return;
        const sent = await bridge(payload);
        if (sent && doc.pendingBridgeProjection === projection) {
            doc.pendingBridgeProjection = null;
        }
        debugLog('projectSnapshot', doc.name, {
            sent,
            revision: projection.revision,
            hash: projection.stateHash
        });
    }

    private async createDoc(docName: string): Promise<SharedDoc> {
        const scope = parseScope(docName);
        const doc = new SharedDoc(docName, scope, this);
        doc.gc = true;

        try {
            const layer = await loadTextLayer(scope);
            doc.fallbackLayer = layer;
            doc.sourceTextHash = hashText(layer.textHtml);

            const persisted = await this.persistence.readState(docName);
            let persistedHtml: string | null = null;
            if (persisted) persistedHtml = await this.renderUpdate(persisted.update, docName);

            const layerRevision = layer.textRevision ?? 0;
            const legacyState = Boolean(
                persisted &&
                (persisted.revision === 0 || !persisted.sourceTextHash || !persisted.bindingVersion)
            );
            const rebuildFromCommit = shouldRebuildYjsFromCommit({
                hasPersistedState: Boolean(persisted),
                persistedRevision: persisted?.revision ?? 0,
                commitRevision: layerRevision,
                persistedIsLegacy: legacyState,
                persistedHtmlIsEmpty: isSemanticallyEmptyHtml(persistedHtml ?? ''),
                commitHtmlIsEmpty: isSemanticallyEmptyHtml(layer.textHtml),
                persistedSourceTextHash: persisted?.sourceTextHash,
                commitTextHash: doc.sourceTextHash
            });

            if (rebuildFromCommit) {
                await applyHtmlToDoc(doc, layer.textHtml, docName, INITIALIZATION_ORIGIN);
                doc.persistenceRevision = persisted?.revision ?? 0;
                doc.replacePersistenceRevision = persisted?.revision ?? null;
                doc.dirty = true;
                await this.flushDoc(doc);
            } else if (persisted) {
                Y.applyUpdate(doc, persisted.update, PERSISTENCE_ORIGIN);
                doc.persistenceRevision = persisted.revision;
                doc.persistedStateHash = persisted.stateHash;

                if (legacyState || !persisted.htmlHash) {
                    // Rewrite legacy snapshots once to stamp revision/hash metadata.
                    doc.dirty = true;
                    await this.flushDoc(doc);
                } else if (
                    layerRevision !== persisted.revision ||
                    layer.textStateHash !== persisted.stateHash ||
                    layer.textBindingVersion !== LEXICAL_YJS_BINDING_VERSION
                ) {
                    await this.projectSnapshot(
                        doc,
                        persistedHtml ?? '<p></p>',
                        persisted.revision,
                        persisted.stateHash
                    );
                } else {
                    doc.lastHtmlHash = persisted.htmlHash;
                    doc.lastProjectedRevision = persisted.revision;
                }
            }
            doc.lifecycle = 'ready';
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
        if (state.closed) throw new Error('peer_closed');
        if (state.doc?.lifecycle === 'ready') return state.doc;

        const docName = getDocName(peer);
        let doc = this.docs.get(docName);
        let waitedForInitialization = false;
        if (!doc) {
            waitedForInitialization = true;
            this.initializationWaiters.set(
                docName,
                (this.initializationWaiters.get(docName) ?? 0) + 1
            );
            try {
                doc = await this.registry.getOrCreate(docName, () => this.createDoc(docName));
            } catch (error) {
                const remaining = (this.initializationWaiters.get(docName) ?? 1) - 1;
                if (remaining > 0) this.initializationWaiters.set(docName, remaining);
                else this.initializationWaiters.delete(docName);
                waitedForInitialization = false;
                throw error;
            }
        }

        try {
            if (getYjsPeerState(peer)?.closed) throw new Error('peer_closed');
            if (!doc.peerIds.has(peer)) doc.peerIds.set(peer, new Set());
            setYjsPeerState(peer, { ...(getYjsPeerState(peer) ?? state), doc });
            return doc;
        } finally {
            if (waitedForInitialization) {
                const remaining = (this.initializationWaiters.get(docName) ?? 1) - 1;
                if (remaining > 0) {
                    this.initializationWaiters.set(docName, remaining);
                } else {
                    this.initializationWaiters.delete(docName);
                    if (doc.peerIds.size === 0) void this.closeDocIfUnused(doc);
                }
            }
        }
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
