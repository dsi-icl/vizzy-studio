import type { Peer } from 'crossws';

import { cancelWallUnbindGrace } from './busState.binding';
import { cancelScopeCleanup, scheduleScopeCleanup } from './busState.persistence';
import {
    addToIndex,
    allEditors,
    allGalleries,
    controllersByWallId,
    editorsByScope,
    galleriesByWallId,
    lastPingSeen,
    peerCounts,
    peers,
    removeFromIndex,
    wallBindings,
    signageBlankWalls,
    wallPeersByScope,
    wallsByIntendedWallSlug,
    wallsByWallId,
    type PeerEntry,
    type PeerMeta
} from './busState.state';

export function registerPeer(peer: Peer, meta: PeerMeta): PeerEntry {
    const entry: PeerEntry = { peer, meta };
    peers.set(peer.id, entry);

    // Seed ping timestamp for editors and walls (they run clock sync)
    if (meta.specimen === 'editor' || meta.specimen === 'wall') {
        lastPingSeen.set(peer.id, Date.now());
    }

    switch (meta.specimen) {
        case 'editor':
            allEditors.add(entry);
            if (meta.scope) {
                addToIndex(editorsByScope, meta.scope.scopeId, entry);
                cancelScopeCleanup(meta.scope.scopeId);
            }
            break;
        case 'wall': {
            cancelWallUnbindGrace(meta.wallId);
            addToIndex(wallsByWallId, meta.wallId, entry);
            if (meta.intendedWallSlug) {
                addToIndex(wallsByIntendedWallSlug, meta.intendedWallSlug, entry);
            }
            const boundScopeId = wallBindings.get(meta.wallId);
            if (boundScopeId !== undefined && !signageBlankWalls.has(meta.wallId)) {
                addToIndex(wallPeersByScope, boundScopeId, entry);
            }
            break;
        }
        case 'controller':
            addToIndex(controllersByWallId, meta.wallId, entry);
            break;
        case 'gallery':
            allGalleries.add(entry);
            if (meta.wallId) addToIndex(galleriesByWallId, meta.wallId, entry);
            break;
    }

    peerCounts[meta.specimen]++;
    return entry;
}

export function unregisterPeer(peerId: string): PeerMeta | null {
    const entry = peers.get(peerId);
    if (!entry) return null;

    const { meta } = entry;
    switch (meta.specimen) {
        case 'editor':
            if (meta.scope) {
                removeFromIndex(editorsByScope, meta.scope.scopeId, entry);
                scheduleScopeCleanup(meta.scope.scopeId);
            }
            allEditors.delete(entry);
            break;
        case 'wall': {
            removeFromIndex(wallsByWallId, meta.wallId, entry);
            if (meta.intendedWallSlug) {
                removeFromIndex(wallsByIntendedWallSlug, meta.intendedWallSlug, entry);
            }
            const boundScopeId = wallBindings.get(meta.wallId);
            if (boundScopeId !== undefined) {
                removeFromIndex(wallPeersByScope, boundScopeId, entry);
            }
            break;
        }
        case 'controller':
            removeFromIndex(controllersByWallId, meta.wallId, entry);
            break;
        case 'gallery':
            allGalleries.delete(entry);
            if (meta.wallId) removeFromIndex(galleriesByWallId, meta.wallId, entry);
            break;
    }

    peerCounts[meta.specimen]--;
    peers.delete(peerId);
    lastPingSeen.delete(peerId);
    return meta;
}
