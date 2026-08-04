import { createFileRoute } from '@tanstack/react-router';
import { defineHooks } from 'crossws';

import { buildInfo } from '~/lib/buildInfo';
import {
    activeVideos,
    allEditors,
    broadcastAssetToEditorsByProject,
    broadcastToControllersByWallRaw,
    broadcastToEditors,
    broadcastToScope,
    broadcastToWallsBinary,
    broadcastVideoSyncBatchToWalls,
    editorsByScope,
    getOrCreateScope,
    getWallNodeCount,
    hydrateWallNodes,
    internScope,
    invalidateHydrateCache,
    logPeerCounts,
    markIncomingBinary,
    markIncomingJson,
    notifyControllers,
    peers,
    reapStalePeers,
    resolveScopeId,
    saveScope,
    scheduleWallUnbindGrace,
    scopeLabel,
    scopedState,
    touchPing,
    unbindWall,
    unregisterPeer,
    wallsByWallId,
    type PeerEntry
} from '~/lib/busState';
import { GSMessageSchema, makeScopeLabel, type GSMessage, type Layer } from '~/lib/types';
import { logAuditDenied } from '~/server/audit';
import {
    editorProjectPermissions,
    enforceWsHandshakeRateLimit,
    enforceWsRateLimit,
    isWsMessageAuthorized,
    wsRateLimitStrikes
} from '~/server/bus/bus.authz';
import {
    broadcastProjectsChanged,
    broadcastWallBindingToEditors,
    broadcastWallBindingToGalleries,
    broadcastWallNodeCountToEditors,
    clearPendingBindOverride,
    pendingBindOverrides
} from '~/server/bus/bus.binding';
import { clearPendingHelloAuth } from '~/server/bus/bus.crypto';
import { pendingHelloAuthByPeer } from '~/server/bus/bus.crypto';
import {
    handlers,
    handleHello,
    handleHelloAuth,
    handleSwitchScope
} from '~/server/bus/bus.handlers';
import { handleEditorScopeVacated, recomputePeerAuthContexts } from '~/server/bus/bus.peers';
import { dbCol } from '~/server/collections';
import { markDeviceDisconnectedById } from '~/server/devices';

// ── Binary opcodes ──────────────────────────────────────────────────────────

const OP = {
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

const pongBuf = new ArrayBuffer(25);
const pongView = new DataView(pongBuf);
pongView.setUint8(0, OP.CLOCK_PONG);

// ── Utilities ───────────────────────────────────────────────────────────────

function hasType(raw: unknown): raw is { type: string; [k: string]: unknown } {
    return (
        typeof raw === 'object' &&
        raw !== null &&
        typeof (raw as Record<string, unknown>).type === 'string'
    );
}

function toArrayBufferView(data: Uint8Array | Buffer): ArrayBuffer {
    const out = new Uint8Array(data.byteLength);
    out.set(data);
    return out.buffer;
}

function firstNonWhitespaceByte(data: Uint8Array): number | null {
    for (let i = 0; i < data.byteLength; i++) {
        const c = data[i];
        if (c === 0x09 || c === 0x0a || c === 0x0d || c === 0x20) continue;
        return c;
    }
    return null;
}

function hasAnyAuthenticatedActor(entry: PeerEntry): boolean {
    return Boolean(
        entry.meta.authContext?.user ||
        entry.meta.authContext?.device ||
        entry.meta.authContext?.portal
    );
}

function isControllerDevice(entry: PeerEntry): boolean {
    return entry.meta.authContext?.device?.kind === 'controller';
}

function isControllerPortal(entry: PeerEntry): boolean {
    return Boolean(entry.meta.authContext?.portal?.wallId);
}

function isWallDevice(entry: PeerEntry): boolean {
    return entry.meta.authContext?.device?.kind === 'wall';
}

function getScopeProjectId(scopeId: number | null): string | null {
    if (scopeId === null) return null;
    return scopedState.get(scopeId)?.projectId ?? null;
}

function getCachedEditorPermissionForBinary(entry: PeerEntry, projectId: string) {
    if (entry.meta.specimen !== 'editor') return null;
    const cached = editorProjectPermissions.get(entry.peer.id);
    if (!cached || cached.projectId !== projectId) return null;
    return { canView: cached.canView, canEdit: cached.canEdit };
}

// ── Binary message handler ──────────────────────────────────────────────────

function handleBinary(peer: import('crossws').Peer, rawData: ArrayBuffer) {
    markIncomingBinary();
    const view = new DataView(rawData);
    const opcode = view.getUint8(0);
    const senderEntry = peers.get(peer.id);
    if (!senderEntry) return;

    if (opcode === OP.CLOCK_PING) {
        if (!hasAnyAuthenticatedActor(senderEntry)) return;
        touchPing(peer.id);
        const t0 = view.getFloat64(1, true);
        const t1 = Date.now();
        const t2 = Date.now();
        pongView.setFloat64(1, t0, true);
        pongView.setFloat64(9, t1, true);
        pongView.setFloat64(17, t2, true);
        peer.send(pongBuf);
        return;
    }

    if (opcode === OP.SPATIAL_MOVE) {
        const senderScopeId = resolveScopeId(senderEntry.meta);
        if (senderScopeId === null) return;
        const projectId = getScopeProjectId(senderScopeId);
        if (!projectId) return;

        let allowed = false;
        if (senderEntry.meta.specimen === 'controller') {
            allowed = isControllerDevice(senderEntry) || isControllerPortal(senderEntry);
        } else if (senderEntry.meta.specimen === 'wall') {
            allowed = isWallDevice(senderEntry);
        } else if (senderEntry.meta.specimen === 'editor') {
            const perms = getCachedEditorPermissionForBinary(senderEntry, projectId);
            allowed = Boolean(perms?.canEdit);
        }
        if (!allowed) {
            console.warn(
                `[WS] Unauthorized binary SPATIAL_MOVE from peer ${peer.id} (${senderEntry.meta.specimen})`
            );
            void logAuditDenied({
                action: 'WS_MESSAGE_DENIED',
                reasonCode: 'WS_BINARY_UNAUTHORIZED',
                projectId,
                resourceType: 'ws_message',
                resourceId: 'SPATIAL_MOVE',
                authContext: senderEntry.meta.authContext,
                executionContext: {
                    surface: 'ws',
                    operation: 'binary:SPATIAL_MOVE',
                    peerId: peer.id,
                    details: { specimen: senderEntry.meta.specimen }
                }
            });
            return;
        }

        const editorEntries = editorsByScope.get(senderScopeId);
        if (editorEntries) {
            for (const entry of editorEntries) {
                if (entry !== senderEntry) entry.peer.send(rawData);
            }
        }

        // Relay to all walls in scope.
        // AABB spatial filtering disabled — see original bus.ts comment for context.
        broadcastToWallsBinary(senderScopeId, rawData);
    }
}

// ── JSON message dispatch ───────────────────────────────────────────────────

function dispatchJsonMessage(
    peer: import('crossws').Peer,
    data: Record<string, unknown>,
    rawText: string
) {
    if (!hasType(data)) {
        console.warn(`[WS] Invalid message from peer ${peer.id}: missing type`);
        return;
    }

    if (data.type === 'hello') {
        if (!enforceWsHandshakeRateLimit(peer, data.type)) return;
        void handleHello(peer, data).catch((err) => {
            console.error(`[WS] Hello handler failed for peer ${peer.id}:`, err);
        });
        return;
    }
    if (data.type === 'hello_auth') {
        if (!enforceWsHandshakeRateLimit(peer, data.type)) return;
        void handleHelloAuth(peer, data).catch((err) => {
            console.error(`[WS] Hello auth handler failed for peer ${peer.id}:`, err);
        });
        return;
    }
    if (data.type === 'switch_scope') {
        void handleSwitchScope(peer, data).catch((err) => {
            console.error(`[WS] switch_scope handler failed for peer ${peer.id}:`, err);
        });
        return;
    }

    const entry = peers.get(peer.id);
    if (!entry) {
        console.warn(`[WS] Message from unregistered peer ${peer.id}, ignoring`);
        return;
    }

    const handler = handlers.get(data.type);
    if (handler) {
        const scopeId = resolveScopeId(entry.meta);
        if (!isWsMessageAuthorized(entry, data, scopeId)) {
            console.warn(
                `[WS] Unauthorized message ${data.type} from peer ${peer.id} (${entry.meta.specimen})`
            );
            void logAuditDenied({
                action: 'WS_MESSAGE_DENIED',
                reasonCode: 'WS_JSON_UNAUTHORIZED',
                projectId: getScopeProjectId(scopeId),
                resourceType: 'ws_message',
                resourceId: data.type,
                authContext: entry.meta.authContext,
                executionContext: {
                    surface: 'ws',
                    operation: `json:${data.type}`,
                    peerId: peer.id,
                    details: { specimen: entry.meta.specimen }
                }
            });
            return;
        }
        void enforceWsRateLimit(peer, data.type, { entry }).then((allowed) => {
            if (!allowed) return;
            try {
                handler({ entry, data, scopeId, rawText });
            } catch (handlerError) {
                console.error('[WS] Handler error after rate-limit check:', handlerError);
            }
        });
    }
}

// ── WebSocket Hooks ─────────────────────────────────────────────────────────

const hooks = defineHooks({
    open(peer) {
        peer.websocket.binaryType = 'arraybuffer';
        peer.send(
            JSON.stringify({
                type: 'server_hello',
                commit: buildInfo.commitSha,
                builtAt: buildInfo.builtAt
            } satisfies GSMessage)
        );
        console.log(`[WS] Peer ${peer.id} connected`);
    },

    close(peer) {
        wsRateLimitStrikes.delete(peer.id);
        editorProjectPermissions.delete(peer.id);
        clearPendingHelloAuth(peer.id);
        // Cancel pending override requests from disconnected requester.
        for (const [requestId, pending] of pendingBindOverrides) {
            if (pending.requesterPeerId !== peer.id) continue;
            clearPendingBindOverride(requestId);
        }

        const meta = unregisterPeer(peer.id);
        const disconnectedDeviceId = meta?.authContext?.device?.id;
        if (typeof disconnectedDeviceId === 'string') {
            void markDeviceDisconnectedById(disconnectedDeviceId);
        }
        if (meta?.specimen === 'editor' && meta.scope?.scopeId !== undefined) {
            handleEditorScopeVacated(meta.scope.scopeId);
        }
        if (meta?.specimen === 'wall') {
            if (getWallNodeCount(meta.wallId) <= 0) {
                scheduleWallUnbindGrace(meta.wallId, () => {
                    // Wall may have reconnected during grace period.
                    if (getWallNodeCount(meta.wallId) > 0) return;

                    unbindWall(meta.wallId);
                    hydrateWallNodes(meta.wallId);
                    broadcastToControllersByWallRaw(
                        meta.wallId,
                        JSON.stringify({ type: 'hydrate', layers: [] } satisfies GSMessage)
                    );
                    notifyControllers(meta.wallId, false);
                    void dbCol.walls.updateByWallId(meta.wallId, {
                        boundProjectId: null,
                        boundCommitId: null,
                        boundSlideId: null,
                        boundSource: null
                    });
                    broadcastWallBindingToEditors(meta.wallId);
                    broadcastWallBindingToGalleries(meta.wallId);
                    broadcastWallNodeCountToEditors(meta.wallId);
                });
            }
            broadcastWallNodeCountToEditors(meta.wallId);
            broadcastWallBindingToEditors(meta.wallId);
            broadcastWallBindingToGalleries(meta.wallId);
        }
        logPeerCounts();
    },

    message(peer, message) {
        const raw = message.rawData;
        const knownPeer = peers.get(peer.id);
        if (knownPeer) {
            const specimen = knownPeer.meta.specimen;
            if (specimen === 'editor' || specimen === 'wall') {
                touchPing(peer.id);
            }
        }

        // ── Binary fast-path (ArrayBuffer) ───────────────────────────
        if (raw instanceof ArrayBuffer) {
            handleBinary(peer, raw);
            return;
        }

        // ── Mixed Buffer/Uint8Array path (text or binary) ────────────
        if (raw instanceof Buffer || raw instanceof Uint8Array) {
            const first = firstNonWhitespaceByte(raw);
            const looksLikeJson = first === 0x7b || first === 0x5b;

            if (!looksLikeJson) {
                handleBinary(peer, toArrayBufferView(raw));
                return;
            }

            const rawText = message.text();
            try {
                const data = JSON.parse(rawText);
                markIncomingJson();
                dispatchJsonMessage(peer, data, rawText);
            } catch (err) {
                // Fallback: run full Zod for diagnostic clarity
                try {
                    const reparsed = JSON.parse(rawText);
                    const result = GSMessageSchema.safeParse(reparsed);
                    if (!result.success) {
                        console.warn(
                            `[WS] Peer ${peer.id} sent invalid message:`,
                            result.error.issues
                        );
                    } else {
                        console.error(`[WS] Handler error for valid message:`, err);
                    }
                } catch {
                    console.error(`[WS] Unparseable message from peer ${peer.id}:`, err);
                }
            }
            return;
        }

        // ── JSON path (string payloads) ──────────────────────────────
        if (typeof raw === 'string') {
            try {
                const data = JSON.parse(raw);
                markIncomingJson();
                dispatchJsonMessage(peer, data, raw);
            } catch (err) {
                console.error(`[WS] Unparseable string message from peer ${peer.id}:`, err);
            }
        }
    }
});

// ── Route export ────────────────────────────────────────────────────────────

export const Route = createFileRoute('/bus')({
    server: {
        handlers: {
            GET: async () => {
                return Object.assign(
                    new Response('WebSocket upgrade is required.', { status: 426 }),
                    { crossws: hooks }
                );
            }
        }
    }
});

// ── Process bridges ─────────────────────────────────────────────────────────

process.__BROADCAST_EDITORS__ = (data: unknown) => {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    for (const entry of allEditors) {
        entry.peer.send(payload);
    }
};

process.__BROADCAST_ASSET_ADDED__ = (projectId: string, asset: Record<string, unknown>) => {
    broadcastAssetToEditorsByProject(projectId, asset);
};

process.__BROADCAST_WALL_BINDING_CHANGED__ = (wallId: string) => {
    broadcastWallBindingToEditors(wallId);
    broadcastWallBindingToGalleries(wallId);
};

process.__BROADCAST_PROJECTS_CHANGED__ = (projectId?: string) => {
    broadcastProjectsChanged(projectId);
};

process.__DISCONNECT_DEVICE__ = (deviceId: string) => {
    const normalized = deviceId.trim();
    if (!normalized) return 0;
    let closed = 0;
    for (const entry of peers.values()) {
        const peerDeviceId = entry.meta.authContext?.device?.id;
        if (peerDeviceId !== normalized) continue;
        try {
            entry.peer.close();
            closed += 1;
        } catch {
            // no-op
        }
    }
    return closed;
};

process.__BUS_RECOMPUTE_AUTH_CONTEXT__ = async (input?: { email?: string; projectId?: string }) => {
    return recomputePeerAuthContexts(input ?? {});
};

process.__REBOOT_WALL__ = (wallId: string, node?: { c: number; r: number }) => {
    const peersForWall = wallsByWallId.get(wallId);
    if (!peersForWall || peersForWall.size === 0) return 0;
    const payload = JSON.stringify({ type: 'reboot' } satisfies GSMessage);
    let sent = 0;
    for (const entry of peersForWall) {
        if (entry.meta.specimen !== 'wall') continue;
        if (node && (entry.meta.col !== node.c || entry.meta.row !== node.r)) continue;
        entry.peer.send(payload);
        sent += 1;
    }
    return sent;
};

process.__REBOOT_DEVICE__ = (deviceId: string, publicKey?: string) => {
    const normalized = deviceId.trim();
    if (!normalized) return 0;
    const payload = JSON.stringify({ type: 'reboot', immediate: true } satisfies GSMessage);
    let sent = 0;
    for (const entry of peers.values()) {
        const peerDeviceId = entry.meta.authContext?.device?.id;
        if (peerDeviceId !== normalized) continue;
        entry.peer.send(payload);
        sent += 1;
    }

    // Enrollment flow keeps device sockets in pending-hello until after auth.
    // Match those peers by device public key so they can reboot immediately.
    const normalizedKey = typeof publicKey === 'string' ? publicKey.trim() : '';
    if (normalizedKey) {
        for (const pending of pendingHelloAuthByPeer.values()) {
            if (pending.hello.devicePublicKey !== normalizedKey) continue;
            try {
                pending.peer.send(payload);
                sent += 1;
            } catch {
                // no-op
            }
        }
    }

    return sent;
};

process.__YJS_UPSERT_LAYER__ = (payload: {
    projectId: string;
    commitId: string;
    slideId: string;
    layerId: number;
    textHtml: string;
    fallbackLayer?: Extract<Layer, { type: 'text' }>;
}) => {
    try {
        const { projectId, commitId, slideId, layerId, textHtml, fallbackLayer } = payload;
        const scopeId = internScope(projectId, commitId, slideId);
        const scope = getOrCreateScope(scopeId, projectId, commitId, slideId);

        const existing = scope.layers.get(layerId);
        const nextLayer =
            existing?.type === 'text'
                ? { ...existing, textHtml }
                : fallbackLayer
                  ? { ...fallbackLayer, textHtml }
                  : null;

        if (!nextLayer || nextLayer.type !== 'text') {
            console.warn(
                `[WS] YJS upsert ignored: text layer ${layerId} not found for scope ${makeScopeLabel(projectId, commitId, slideId)}`
            );
            return false;
        }

        scope.layers.set(layerId, nextLayer);
        scope.dirty = true;
        invalidateHydrateCache(scopeId);
        broadcastToScope(scopeId, {
            type: 'upsert_layer',
            origin: 'yjs:sync',
            layer: nextLayer
        });
        return true;
    } catch (error) {
        console.error('[WS] YJS upsert bridge failed:', error);
        return false;
    }
};

// ── Background loops ────────────────────────────────────────────────────────

if (process.__VSYNC_INTERVAL__) clearInterval(process.__VSYNC_INTERVAL__);
process.__VSYNC_INTERVAL__ = setInterval(() => {
    const now = Date.now();
    const batch: Array<{
        numericId: number;
        scopeId: number;
        playback: {
            status: 'playing' | 'paused';
            anchorMediaTime: number;
            anchorServerTime: number;
        };
    }> = [];

    for (const [numericId, { scopeId, layer }] of activeVideos) {
        if (layer.type !== 'video' || !layer.playback || layer.playback.status !== 'playing') {
            activeVideos.delete(numericId);
            continue;
        }

        const duration = layer.duration;
        if (duration <= 0) continue;

        const elapsed = Math.max(0, (now - layer.playback.anchorServerTime) / 1000);
        const expected = layer.playback.anchorMediaTime + elapsed;

        if (expected >= duration) {
            if (layer.loop ?? true) {
                layer.playback.anchorMediaTime = !duration ? 0 : expected % duration;
                layer.playback.anchorServerTime = now;
            } else {
                layer.playback.status = 'paused';
                layer.playback.anchorMediaTime = duration;
                layer.playback.anchorServerTime = 0;
                activeVideos.delete(numericId);
            }

            batch.push({ numericId, scopeId, playback: { ...layer.playback } });
        }
    }

    if (batch.length > 0) broadcastVideoSyncBatchToWalls(batch);
}, 500);

const AUTO_SAVE_INTERVAL = 30_000;

if (process.__AUTO_SAVE_INTERVAL__) clearInterval(process.__AUTO_SAVE_INTERVAL__);
process.__AUTO_SAVE_INTERVAL__ = setInterval(() => {
    for (const [scopeId, scope] of scopedState) {
        if (scope.dirty) {
            saveScope(scopeId, 'Auto-save', true).then((result) => {
                if (result.success) {
                    broadcastToEditors(scopeId, {
                        type: 'stage_save_response',
                        success: true,
                        commitId: result.commitId
                    });
                } else {
                    console.error(
                        `[Bus] Auto-save failed for scope ${scopeLabel(scopeId)}:`,
                        result.error
                    );
                }
            });
        }
    }
}, AUTO_SAVE_INTERVAL);

if (process.__REAPER_INTERVAL__) clearInterval(process.__REAPER_INTERVAL__);
process.__REAPER_INTERVAL__ = setInterval(() => {
    reapStalePeers();
}, 10_000);

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        if (process.__VSYNC_INTERVAL__) clearInterval(process.__VSYNC_INTERVAL__);
        if (process.__AUTO_SAVE_INTERVAL__) clearInterval(process.__AUTO_SAVE_INTERVAL__);
        if (process.__REAPER_INTERVAL__) clearInterval(process.__REAPER_INTERVAL__);
    });
}
