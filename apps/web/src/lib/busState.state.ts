import type { Peer } from 'crossws';

import { makeScopeLabel, type Layer, type ScopeState } from '~/lib/types';
import type { AuthContext } from '~/server/requestAuthContext';

// All hot-path maps are keyed by a small integer
// V8 uses a faster internal representation for integer-keyed Maps.
export type ScopeId = number;

export type PeerMeta =
    | {
          specimen: 'editor';
          scope?: {
              projectId: string;
              commitId: string;
              slideId: string;
              scopeId: ScopeId;
          };
          authContext?: AuthContext;
      }
    | {
          specimen: 'wall';
          wallId: string;
          intendedWallSlug?: string;
          col: number;
          row: number;
          authContext?: AuthContext;
      }
    | { specimen: 'controller'; wallId: string; authContext?: AuthContext }
    | { specimen: 'gallery'; wallId?: string; authContext?: AuthContext };

export interface PeerEntry {
    peer: Peer;
    meta: PeerMeta;
}

const _hmr = (process as any).__BUS_HMR__ ?? {
    scopedState: new Map<ScopeId, ScopeState>(),
    scopeKeyToId: new Map<string, ScopeId>(),
    scopeIdToKey: new Map<ScopeId, string>(),
    commitToScopeIds: new Map<string, Set<ScopeId>>(),
    nextScopeId: 1,
    peers: new Map<string, PeerEntry>(),
    editorsByScope: new Map<ScopeId, Set<PeerEntry>>(),
    wallsByWallId: new Map<string, Set<PeerEntry>>(),
    wallsByIntendedWallSlug: new Map<string, Set<PeerEntry>>(),
    controllersByWallId: new Map<string, Set<PeerEntry>>(),
    galleriesByWallId: new Map<string, Set<PeerEntry>>(),
    allGalleries: new Set<PeerEntry>(),
    allEditors: new Set<PeerEntry>(),
    wallBindings: new Map<string, ScopeId>(),
    wallBindingSources: new Map<string, 'live' | 'gallery' | 'signage'>(),
    signageBlankWalls: new Set<string>(),
    scopeWatchers: new Map<ScopeId, Set<string>>(),
    wallPeersByScope: new Map<ScopeId, Set<PeerEntry>>(),
    activeVideos: new Map<number, { scopeId: ScopeId; layer: Layer }>(),
    peerCounts: { editor: 0, wall: 0, controller: 0, gallery: 0 },
    lastPingSeen: new Map<string, number>(),
    scopeCleanupTimers: new Map<ScopeId, ReturnType<typeof setTimeout>>(),
    wallUnbindTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    controllerTransientByWallId: new Map<string, Map<number, Layer>>()
};
if (!_hmr.controllerTransientByWallId) {
    _hmr.controllerTransientByWallId = new Map<string, Map<number, Layer>>();
}
if (!_hmr.wallsByIntendedWallSlug) {
    _hmr.wallsByIntendedWallSlug = new Map<string, Set<PeerEntry>>();
}
if (!_hmr.galleriesByWallId) {
    _hmr.galleriesByWallId = new Map<string, Set<PeerEntry>>();
}
if (!_hmr.allGalleries) {
    _hmr.allGalleries = new Set<PeerEntry>();
}
if (!_hmr.wallUnbindTimers) {
    _hmr.wallUnbindTimers = new Map<string, ReturnType<typeof setTimeout>>();
}
if (!_hmr.signageBlankWalls) {
    _hmr.signageBlankWalls = new Set<string>();
}
if (typeof _hmr.peerCounts.gallery !== 'number') {
    _hmr.peerCounts.gallery = 0;
}
(process as any).__BUS_HMR__ = _hmr;

export const scopedState: Map<ScopeId, ScopeState> = _hmr.scopedState;
export const scopeKeyToId: Map<string, ScopeId> = _hmr.scopeKeyToId;
export const scopeIdToKey: Map<ScopeId, string> = _hmr.scopeIdToKey;
export const commitToScopeIds: Map<string, Set<ScopeId>> = _hmr.commitToScopeIds;

const _telemetry = (process as any).__BUS_TELEMETRY__ ?? {
    incomingJson: 0,
    incomingBinary: 0,
    outgoingJson: 0,
    outgoingBinary: 0,
    videoSyncFrames: 0,
    videoSyncEntries: 0,
    startedAt: Date.now()
};
(process as any).__BUS_TELEMETRY__ = _telemetry;

export function markOutgoing(jsonRecipients: number, binaryRecipients: number) {
    if (jsonRecipients > 0) _telemetry.outgoingJson += jsonRecipients;
    if (binaryRecipients > 0) _telemetry.outgoingBinary += binaryRecipients;
}

export function markVideoSyncTelemetry(frames: number, entries: number) {
    _telemetry.videoSyncFrames += frames;
    _telemetry.videoSyncEntries += entries;
}

export function markIncomingJson() {
    _telemetry.incomingJson += 1;
}

export function markIncomingBinary() {
    _telemetry.incomingBinary += 1;
}

export function getBusRuntimeTelemetry() {
    let dirtyScopes = 0;
    let layerCount = 0;
    for (const scope of scopedState.values()) {
        if (scope.dirty) dirtyScopes += 1;
        layerCount += scope.layers.size;
    }

    return {
        incomingJson: _telemetry.incomingJson,
        incomingBinary: _telemetry.incomingBinary,
        outgoingJson: _telemetry.outgoingJson,
        outgoingBinary: _telemetry.outgoingBinary,
        videoSyncFrames: _telemetry.videoSyncFrames,
        videoSyncEntries: _telemetry.videoSyncEntries,
        activeVideos: activeVideos.size,
        scopes: scopedState.size,
        dirtyScopes,
        layers: layerCount,
        startedAt: _telemetry.startedAt
    };
}

// Intern a (projectId, commitId, slideId) triple into a numeric ScopeId
export function internScope(projectId: string, commitId: string, slideId: string): ScopeId {
    const raw = makeScopeLabel(projectId, commitId, slideId);
    let id = scopeKeyToId.get(raw);
    if (id === undefined) {
        id = _hmr.nextScopeId++;
        scopeKeyToId.set(raw, id);
        scopeIdToKey.set(id, raw);
    }
    return id;
}

export function scopeLabel(id: ScopeId): string {
    return scopeIdToKey.get(id) ?? `<unknown:${id}>`;
}

/** Remove a scope from the interning maps. Called during scope GC. */
export function purgeScopeInterning(scopeId: ScopeId) {
    const key = scopeIdToKey.get(scopeId);
    if (key) {
        scopeKeyToId.delete(key);
        scopeIdToKey.delete(scopeId);
    }
}

// Master peer registry: peerId > PeerEntry
export const peers: Map<string, PeerEntry> = _hmr.peers;

// Editor scope index: scopeId > Set<PeerEntry> — direct refs, no map lookup in broadcast
export const editorsByScope: Map<ScopeId, Set<PeerEntry>> = _hmr.editorsByScope;

// Wall peer index: wallId > Set<PeerEntry>
export const wallsByWallId: Map<string, Set<PeerEntry>> = _hmr.wallsByWallId;
export const wallsByIntendedWallSlug: Map<string, Set<PeerEntry>> = _hmr.wallsByIntendedWallSlug;

// Controller index: wallId > Set<PeerEntry>
export const controllersByWallId: Map<string, Set<PeerEntry>> = _hmr.controllersByWallId;

// Gallery watcher index: wallId > Set<PeerEntry>
export const galleriesByWallId: Map<string, Set<PeerEntry>> = _hmr.galleriesByWallId;

// Flat set of every gallery entry
export const allGalleries: Set<PeerEntry> = _hmr.allGalleries;

// Flat set of every editor entry — for the __BROADCAST_EDITORS__ bridge
export const allEditors: Set<PeerEntry> = _hmr.allEditors;

// wallId > ScopeId: which content a wall displays
export const wallBindings: Map<string, ScopeId> = _hmr.wallBindings;
export const wallBindingSources: Map<string, 'live' | 'gallery' | 'signage'> =
    _hmr.wallBindingSources;
export const signageBlankWalls: Set<string> = _hmr.signageBlankWalls;

// scopeId > Set<wallId>: reverse index used only for binding cleanup
export const scopeWatchers: Map<ScopeId, Set<string>> = _hmr.scopeWatchers;

/**
 * Flattened broadcast index: scopeId > Set<PeerEntry> of wall peers watching this scope.
 * Updated on bind/unbind/register/unregister (cold path) so broadcast (hot path) is one loop.
 */
export const wallPeersByScope: Map<ScopeId, Set<PeerEntry>> = _hmr.wallPeersByScope;
export const controllerTransientByWallId: Map<
    string,
    Map<number, Layer>
> = _hmr.controllerTransientByWallId;

// Active video registry for the VSYNC loop — only playing videos are tracked
export const activeVideos: Map<number, { scopeId: ScopeId; layer: Layer }> = _hmr.activeVideos;

/** Running peer counts — O(1) reads instead of iterating all peers */
export const peerCounts: {
    editor: number;
    wall: number;
    controller: number;
    gallery: number;
} = _hmr.peerCounts;

/** Last clock-ping timestamp per peer. Updated in handleBinary CLOCK_PING handler. */
export const lastPingSeen: Map<string, number> = _hmr.lastPingSeen;

/** Scope GC timers — exported so persistence.ts can schedule/cancel them. */
export const scopeCleanupTimers: Map<
    ScopeId,
    ReturnType<typeof setTimeout>
> = _hmr.scopeCleanupTimers;

/** Wall unbind grace timers — exported so binding.ts can schedule/cancel them. */
export const wallUnbindTimers: Map<string, ReturnType<typeof setTimeout>> = _hmr.wallUnbindTimers;

/** Live wall node count — O(1) read from in-memory index. */
export function getWallNodeCount(wallId: string): number {
    return wallsByWallId.get(wallId)?.size ?? 0;
}

/** Live wall node count keyed by advertised wall id (w query param). */
export function getIntendedWallNodeCount(wallId: string): number {
    return wallsByIntendedWallSlug.get(wallId)?.size ?? 0;
}

// Binary opcodes
export const OP = {
    SPATIAL_MOVE: 0x05,
    CLOCK_PING: 0x08,
    CLOCK_PONG: 0x09,
    // Reserved for future binary migration of JSON message types:
    UPSERT_LAYER: 0x10,
    DELETE_LAYER: 0x11,
    VIDEO_PLAY: 0x12,
    VIDEO_PAUSE: 0x13,
    VIDEO_SEEK: 0x14,
    VIDEO_SYNC: 0x15
} as const;

// ── Index helpers (generic over key type) ────────────────────────────────────

export function addToIndex<K>(index: Map<K, Set<PeerEntry>>, key: K, entry: PeerEntry) {
    let set = index.get(key);
    if (!set) {
        set = new Set();
        index.set(key, set);
    }
    set.add(entry);
}

export function removeFromIndex<K>(index: Map<K, Set<PeerEntry>>, key: K, entry: PeerEntry) {
    const set = index.get(key);
    if (set) {
        set.delete(entry);
        if (set.size === 0) index.delete(key);
    }
}

// Pre-allocated empty hydrate payload (avoids re-stringifying on every call).
export const EMPTY_HYDRATE: string = JSON.stringify({ type: 'hydrate', layers: [] });

export function invalidateHydrateCache(scopeId: ScopeId) {
    const scope = scopedState.get(scopeId);
    if (scope) scope.hydrateCache = null;
}

// ── Controller transient layer management ────────────────────────────────────

export function upsertControllerTransientLayer(wallId: string, layer: Layer) {
    let byId = controllerTransientByWallId.get(wallId);
    if (!byId) {
        byId = new Map<number, Layer>();
        controllerTransientByWallId.set(wallId, byId);
    }
    byId.set(layer.numericId, layer);
}

export function deleteControllerTransientLayer(wallId: string, numericId: number): boolean {
    const byId = controllerTransientByWallId.get(wallId);
    if (!byId) return false;
    const deleted = byId.delete(numericId);
    if (byId.size === 0) controllerTransientByWallId.delete(wallId);
    return deleted;
}

export function deleteControllerTransientLayerForScope(
    scopeId: ScopeId,
    numericId: number
): boolean {
    const watchers = scopeWatchers.get(scopeId);
    if (!watchers || watchers.size === 0) return false;
    let deleted = false;
    for (const wallId of watchers) {
        if (deleteControllerTransientLayer(wallId, numericId)) deleted = true;
    }
    return deleted;
}

export function clearControllerTransientForWall(wallId: string) {
    if (!controllerTransientByWallId.has(wallId)) return;
    controllerTransientByWallId.delete(wallId);
}

export function clearControllerTransientForScope(scopeId: ScopeId) {
    const watchers = scopeWatchers.get(scopeId);
    if (!watchers || watchers.size === 0) return;
    for (const wallId of watchers) clearControllerTransientForWall(wallId);
}

// ── Backpressure ─────────────────────────────────────────────────────────────

const BACKPRESSURE_THRESHOLD = 65536; // 64KB

// Returns false if the peer's send buffer is congested (to skip non-critical sends)
export function canSendNonCritical(peer: Peer): boolean {
    try {
        const buffered = (peer.websocket as any)?.bufferedAmount;
        return typeof buffered !== 'number' || buffered < BACKPRESSURE_THRESHOLD;
    } catch {
        return true;
    }
}

// ── Active video registry ─────────────────────────────────────────────────────

export function registerActiveVideo(numericId: number, scopeId: ScopeId, layer: Layer) {
    activeVideos.set(numericId, { scopeId, layer });
}

export function unregisterActiveVideo(numericId: number) {
    activeVideos.delete(numericId);
}

export function clearActiveVideosForScope(scopeId: ScopeId) {
    for (const [numericId, entry] of activeVideos) {
        if (entry.scopeId === scopeId) activeVideos.delete(numericId);
    }
}
