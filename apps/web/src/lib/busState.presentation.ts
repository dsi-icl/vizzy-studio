import type { Peer } from 'crossws';

import { estimatePlaybackLeadMs } from './busState.broadcast';
import { getWallHydratePayload } from './busState.scopes';
import { markOutgoing, wallBindings, wallsByWallId, type ScopeId } from './busState.state';
import type { GSMessage } from './types';

// The wall spends 1s fading out, then at most 8s waiting for resources.
// Leave room for its ready message before the server chooses a shared start.
const WALL_READY_TIMEOUT_MS = 9_500;

type PendingPresentation = {
    id: string;
    scopeId: ScopeId;
    hydratePayload: string;
    expectedPeers: Set<string>;
    readyPeers: Set<string>;
    timer: ReturnType<typeof setTimeout>;
};

const pendingByWall = new Map<string, PendingPresentation>();

export function cancelWallPresentation(wallId: string) {
    const pending = pendingByWall.get(wallId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingByWall.delete(wallId);
}

function startWallPresentation(wallId: string, pending: PendingPresentation) {
    if (pendingByWall.get(wallId) !== pending) return;
    cancelWallPresentation(wallId);
    if (wallBindings.get(wallId) !== pending.scopeId) return;

    // Every wall receives the same future start time after the ready barrier.
    const startAt = Date.now() + Math.max(500, estimatePlaybackLeadMs(pending.scopeId) + 250);
    const payload = JSON.stringify({
        type: 'wall_slide_start',
        presentationId: pending.id,
        startAt
    } satisfies GSMessage);
    let sent = 0;
    for (const entry of wallsByWallId.get(wallId) ?? []) {
        if (!pending.expectedPeers.has(entry.peer.id)) continue;
        try {
            entry.peer.send(payload);
            sent++;
        } catch {
            // This peer left after the ready barrier completed.
        }
    }
    markOutgoing(sent, 0);
}

/** Prepare video slides on every connected wall before choosing a common reveal time. */
export function prepareWallPresentation(wallId: string, scopeId: ScopeId): boolean {
    cancelWallPresentation(wallId);
    const wallPeers = wallsByWallId.get(wallId);
    if (!wallPeers?.size) return false;

    const hydrate = JSON.parse(getWallHydratePayload(scopeId, wallId)) as Extract<
        GSMessage,
        { type: 'hydrate' }
    >;
    if (
        hydrate.type !== 'hydrate' ||
        !hydrate.layers.some((layer) => layer.type === 'video' && layer.config.visible)
    ) {
        return false;
    }

    const id = crypto.randomUUID();
    const payload = JSON.stringify({ ...hydrate, presentationId: id } satisfies GSMessage);
    const pending: PendingPresentation = {
        id,
        scopeId,
        hydratePayload: payload,
        expectedPeers: new Set(),
        readyPeers: new Set(),
        timer: setTimeout(() => {
            startWallPresentation(wallId, pending);
        }, WALL_READY_TIMEOUT_MS)
    };
    pendingByWall.set(wallId, pending);
    let sent = 0;
    for (const entry of wallPeers) {
        try {
            entry.peer.send(payload);
            pending.expectedPeers.add(entry.peer.id);
            sent++;
        } catch {
            // A failed peer is excluded from this presentation's ready barrier.
        }
    }
    markOutgoing(sent, 0);
    if (!pending.expectedPeers.size) {
        cancelWallPresentation(wallId);
        return false;
    }
    return true;
}

/** A wall joining during preparation participates in the same start barrier. */
export function sendPendingWallPresentation(wallId: string, peer: Peer): boolean {
    const pending = pendingByWall.get(wallId);
    if (!pending || wallBindings.get(wallId) !== pending.scopeId) return false;
    try {
        peer.send(pending.hydratePayload);
        pending.expectedPeers.add(peer.id);
        markOutgoing(1, 0);
        return true;
    } catch {
        return false;
    }
}

export function markWallPresentationReady(wallId: string, peerId: string, presentationId: string) {
    const pending = pendingByWall.get(wallId);
    if (
        !pending ||
        pending.id !== presentationId ||
        wallBindings.get(wallId) !== pending.scopeId ||
        !pending.expectedPeers.has(peerId)
    ) {
        return;
    }
    pending.readyPeers.add(peerId);
    if (pending.readyPeers.size === pending.expectedPeers.size) {
        startWallPresentation(wallId, pending);
    }
}

export function dropWallPresentationPeer(wallId: string, peerId: string) {
    const pending = pendingByWall.get(wallId);
    if (!pending || !pending.expectedPeers.delete(peerId)) return;
    pending.readyPeers.delete(peerId);
    if (!pending.expectedPeers.size) {
        cancelWallPresentation(wallId);
    } else if (pending.readyPeers.size === pending.expectedPeers.size) {
        startWallPresentation(wallId, pending);
    }
}

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        for (const wallId of pendingByWall.keys()) cancelWallPresentation(wallId);
    });
}
