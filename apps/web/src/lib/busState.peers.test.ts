import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Peer } from 'crossws';

// Importing the persistence module creates collection objects, but these
// in-memory peer tests never connect to MongoDB.
process.env.SERVER_DATABASE_URL ??= 'mongodb://127.0.0.1:27017/vizzy_peer_test';
const { registerPeer, unregisterPeer } = await import('./busState.peers');
const { reapStalePeers } = await import('./busState.persistence');
const { peerCounts, peers, wallsByWallId } = await import('./busState.state');

function fakePeer(id: string) {
    const transportPeers = new Set<Peer>();
    const peer = {
        id,
        peers: transportPeers,
        close() {
            transportPeers.delete(peer as Peer);
        }
    } as unknown as Peer;
    transportPeers.add(peer);
    return peer;
}

test('repeated wall registration keeps one indexed entry per socket', () => {
    const wallId = 'test-repeat-registration';
    const peer = fakePeer('test-repeat-registration-peer');
    const before = peerCounts.wall;
    try {
        registerPeer(peer, { specimen: 'wall', wallId, col: 0, row: 0 });
        registerPeer(peer, { specimen: 'wall', wallId, col: 0, row: 0 });
        assert.equal(wallsByWallId.get(wallId)?.size, 1);
        assert.equal(peerCounts.wall, before + 1);
    } finally {
        unregisterPeer(peer.id);
    }
    assert.equal(wallsByWallId.has(wallId), false);
    assert.equal(peerCounts.wall, before);
});

test('reaper requests cleanup when a wall transport closed without a close hook', () => {
    const wallId = 'test-closed-transport';
    const peer = fakePeer('test-closed-transport-peer');
    const before = peerCounts.wall;
    try {
        registerPeer(peer, { specimen: 'wall', wallId, col: 0, row: 0 });
        peer.peers.delete(peer);
        const reaped = reapStalePeers((peerId) => unregisterPeer(peerId));
        assert.equal(reaped, 1);
        assert.equal(peers.has(peer.id), false);
        assert.equal(wallsByWallId.has(wallId), false);
        assert.equal(peerCounts.wall, before);
    } finally {
        unregisterPeer(peer.id);
    }
});

test('gallery peers with a live transport are not timed out by the wall ping reaper', () => {
    const peer = fakePeer('test-gallery-peer');
    const before = peerCounts.gallery;
    try {
        registerPeer(peer, { specimen: 'gallery' });
        const reaped = reapStalePeers((peerId) => unregisterPeer(peerId));
        assert.equal(reaped, 0);
        assert.equal(peers.has(peer.id), true);
        assert.equal(peerCounts.gallery, before + 1);
    } finally {
        unregisterPeer(peer.id);
    }
    assert.equal(peerCounts.gallery, before);
});
