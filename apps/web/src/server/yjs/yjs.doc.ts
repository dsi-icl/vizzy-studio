import { createHash } from 'node:crypto';

import * as encoding from 'lib0/encoding';
import { Binary } from 'mongodb';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';

import type { Layer } from '~/lib/types';
import { dbCol } from '~/server/collections';

import { retryTextLayerLookup, TextLayerLookupError } from './yjs.layerLookup';
import { mergeYjsSnapshots } from './yjs.state';

export const messageSync = 0;
export const messageAwareness = 1;
export const SYNC_INTERVAL_MS = 1000;
export const LEXICAL_YJS_BINDING_VERSION = 'lexical-yjs-v1';
export const PERSISTENCE_ORIGIN = Symbol.for('vizzy/yjs/persistence');
export const INITIALIZATION_ORIGIN = Symbol.for('vizzy/yjs/initialization');

export type TextLayer = Extract<Layer, { type: 'text' }>;

export type DocScope = {
    projectId: string;
    commitId: string;
    slideId: string;
    layerId: number;
};

export type PersistedDocState = {
    update: Uint8Array;
    revision: number;
    stateHash: string;
    htmlHash?: string;
    sourceTextHash?: string;
    bindingVersion?: string;
    updatedAt: number;
};

export type PersistedWriteResult = PersistedDocState & { mergedConcurrentState: boolean };

export type SnapshotMetadata = {
    stateHash: string;
    htmlHash: string;
    sourceTextHash: string;
    bindingVersion: string;
    /** Replace only the corrupt/obsolete revision observed during hydration. */
    replaceRevision?: number;
};

export type PendingBridgeProjection = {
    html: string;
    revision: number;
    stateHash: string;
};

type AwarenessChanges = {
    added: number[];
    updated: number[];
    removed: number[];
};

export interface Persistence {
    readState: (scope: string) => Promise<PersistedDocState | null>;
    writeState: (
        scope: string,
        update: Uint8Array,
        metadata: SnapshotMetadata
    ) => Promise<PersistedWriteResult>;
}

/**
 * Minimal callback surface that SharedDoc needs from YCrossws.
 * Using an interface instead of the concrete class avoids a circular import
 * between yjs.doc.ts and yjs.session.ts.
 */
export interface YcRef {
    onDocUpdate: (
        update: Uint8Array,
        origin: unknown,
        doc: Y.Doc,
        transaction: Y.Transaction
    ) => void;
    flushDoc: (doc: SharedDoc) => Promise<void>;
    syncDoc: (doc: SharedDoc) => Promise<void>;
}

export function hashBytes(input: Uint8Array): string {
    return createHash('sha256').update(input).digest('hex');
}

export function hashText(input: string): string {
    return createHash('sha256').update(input).digest('hex');
}

export function binaryToUint8Array(data: unknown): Uint8Array | null {
    if (!data) return null;
    if (data instanceof Uint8Array) return data;
    if (data instanceof Binary) {
        const buffer = data.buffer;
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
    if (Buffer.isBuffer(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (typeof data === 'string') {
        return new Uint8Array(Buffer.from(data, 'base64'));
    }
    return null;
}

async function loadTextLayerOnce(scope: DocScope): Promise<TextLayer> {
    const commit = await dbCol.commits.findById(scope.commitId);
    if (
        !commit ||
        String(commit.projectId) !== scope.projectId ||
        !commit.content?.slides ||
        !Array.isArray(commit.content.slides)
    ) {
        throw new TextLayerLookupError(
            `Commit not found or invalid content for ${scope.commitId}`,
            'commit_invalid'
        );
    }

    const slide = commit.content.slides.find((s: any) => s?.id === scope.slideId);
    if (!slide?.layers || !Array.isArray(slide.layers)) {
        throw new TextLayerLookupError(
            `Slide ${scope.slideId} not found in commit ${scope.commitId}`,
            'slide_missing'
        );
    }

    const layer = slide.layers.find((l: any) => l?.numericId === scope.layerId);
    if (!layer) {
        throw new TextLayerLookupError(
            `Text layer ${scope.layerId} not found in slide ${scope.slideId}`,
            'layer_missing'
        );
    }
    if (layer.type !== 'text') {
        throw new TextLayerLookupError(
            `Layer ${scope.layerId} in slide ${scope.slideId} is not a text layer`,
            'layer_not_text'
        );
    }
    return layer as TextLayer;
}

export async function loadTextLayer(scope: DocScope): Promise<TextLayer> {
    return retryTextLayerLookup(() => loadTextLayerOnce(scope), {
        beforeRetry: async () => {
            try {
                await process.__YJS_WAIT_FOR_LAYER_PERSISTENCE__?.(scope);
            } catch (error) {
                // The database retry below remains authoritative. This bridge is
                // only a same-worker fast path and must not mask the final error.
                console.warn('[YJS] Waiting for pending layer persistence failed:', error);
            }
        }
    });
}

export class MongoYDocPersistence implements Persistence {
    private indexReady: Promise<void>;
    private indexError: unknown = null;

    constructor() {
        this.indexReady = dbCol.ydocs
            .ensureScopeIndex()
            .then(() => {
                if (process.env.YJS_DEBUG === 'true')
                    console.log('[YJS] ydocs.scope unique index ensured');
            })
            .catch((err) => {
                console.error('[YJS] Failed to ensure ydocs.scope unique index:', err);
                this.indexError = err;
            });
    }

    private async ensureReady(): Promise<void> {
        await this.indexReady;
        if (this.indexError) {
            throw new Error('Yjs persistence requires the unique scope index', {
                cause: this.indexError
            });
        }
    }

    async readState(scope: string): Promise<PersistedDocState | null> {
        await this.ensureReady();
        const state = await dbCol.ydocs.findStateByScope(scope);
        if (!state) return null;
        const update = binaryToUint8Array(state.data);
        if (!update || update.byteLength === 0) return null;
        return {
            update,
            revision: state.revision,
            stateHash: state.stateHash ?? hashBytes(update),
            ...(state.htmlHash ? { htmlHash: state.htmlHash } : {}),
            ...(state.sourceTextHash ? { sourceTextHash: state.sourceTextHash } : {}),
            ...(state.bindingVersion ? { bindingVersion: state.bindingVersion } : {}),
            updatedAt: state.updatedAt
        };
    }

    async writeState(
        scope: string,
        update: Uint8Array,
        metadata: SnapshotMetadata
    ): Promise<PersistedWriteResult> {
        await this.ensureReady();
        for (let attempt = 0; attempt < 12; attempt += 1) {
            const current = await this.readState(scope);
            const replaceObservedState =
                metadata.replaceRevision !== undefined &&
                current?.revision === metadata.replaceRevision;
            const mergedUpdate = mergeYjsSnapshots(
                current?.update ?? null,
                update,
                replaceObservedState
            );
            const mergedStateHash = hashBytes(mergedUpdate);
            const mergedConcurrentState = mergedStateHash !== metadata.stateHash;
            const revision = (current?.revision ?? 0) + 1;
            const nextState = {
                data: new Binary(Buffer.from(mergedUpdate)),
                revision,
                stateHash: mergedStateHash,
                ...(mergedConcurrentState ? {} : { htmlHash: metadata.htmlHash }),
                sourceTextHash: replaceObservedState
                    ? metadata.sourceTextHash
                    : (current?.sourceTextHash ?? metadata.sourceTextHash),
                bindingVersion: metadata.bindingVersion
            };
            const written = current
                ? await dbCol.ydocs.replaceStateAtRevision(scope, current.revision, nextState)
                : await dbCol.ydocs.insertStateIfAbsent(scope, nextState);
            if (!written) continue;
            return {
                update: mergedUpdate,
                revision,
                stateHash: mergedStateHash,
                ...(mergedConcurrentState ? {} : { htmlHash: metadata.htmlHash }),
                sourceTextHash: nextState.sourceTextHash,
                bindingVersion: metadata.bindingVersion,
                updatedAt: Date.now(),
                mergedConcurrentState
            };
        }
        throw new Error(`Yjs persistence CAS retries exhausted for ${scope}`);
    }
}

export class SharedDoc extends Y.Doc {
    name: string;
    yc: YcRef;
    scope: DocScope;
    awareness: awarenessProtocol.Awareness;
    peerIds: Map<import('crossws').Peer, Set<number>> = new Map();
    dirty = false;
    syncTimer: ReturnType<typeof setInterval> | null = null;
    flushPromise: Promise<void> | null = null;
    syncPromise: Promise<void> | null = null;
    lastHtmlHash: string | null = null;
    fallbackLayer: TextLayer | null = null;
    persistenceRevision = 0;
    persistedStateHash: string | null = null;
    sourceTextHash = '';
    lastProjectedRevision = 0;
    pendingBridgeProjection: PendingBridgeProjection | null = null;
    replacePersistenceRevision: number | null = null;
    lifecycle: 'initializing' | 'ready' | 'closing' | 'destroyed' = 'initializing';

    constructor(name: string, scope: DocScope, yc: YcRef) {
        super();
        this.name = name;
        this.scope = scope;
        this.yc = yc;
        this.awareness = new awarenessProtocol.Awareness(this);
        this.awareness.setLocalState(null);
        this.awareness.on('update', this.onAwarenessUpdate.bind(this));
        this.on('update', yc.onDocUpdate.bind(yc));
        this.on('update', (_update: Uint8Array, origin: unknown) => {
            if (origin !== PERSISTENCE_ORIGIN && origin !== INITIALIZATION_ORIGIN) {
                this.dirty = true;
            }
        });
    }

    startSyncLoop() {
        if (this.syncTimer) return;
        this.syncTimer = setInterval(() => {
            void this.yc.syncDoc(this).catch((error) => {
                console.error(`[YJS] Background sync failed for ${this.name}:`, error);
            });
        }, SYNC_INTERVAL_MS);
    }

    stopSyncLoop() {
        if (!this.syncTimer) return;
        clearInterval(this.syncTimer);
        this.syncTimer = null;
    }

    onAwarenessUpdate(changes: AwarenessChanges, peer?: import('crossws').Peer) {
        if (peer) {
            const peerControlledIDs = this.peerIds.get(peer);
            if (peerControlledIDs !== undefined) {
                for (const clientID of changes.added) peerControlledIDs.add(clientID);
                for (const clientID of changes.removed) peerControlledIDs.delete(clientID);
            }
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
                ...changes.added,
                ...changes.updated,
                ...changes.removed
            ])
        );
        const buff = encoding.toUint8Array(encoder);
        for (const peer of this.peerIds.keys()) {
            peer.send(buff);
        }
    }
}
