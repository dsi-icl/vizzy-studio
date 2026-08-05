import type { Peer } from 'crossws';

import {
    broadcastToControllersByScopeRaw,
    broadcastToControllersByWallRaw,
    broadcastToEditors,
    broadcastToEditorsByCommit,
    broadcastToScope,
    broadcastToScopeRaw,
    broadcastToWallNodesRaw,
    broadcastToWallsRaw,
    cancelWallUnbindGrace,
    clearActiveVideosForScope,
    clearControllerTransientForScope,
    deleteControllerTransientLayer,
    deleteControllerTransientLayerForScope,
    deleteYDocForLayer,
    editorsByScope,
    EMPTY_HYDRATE,
    estimatePlaybackLeadMs,
    getEditorHydratePayload,
    getWallHydratePayload,
    hydrateWallNodes,
    internScope,
    invalidateHydrateCache,
    logPeerCounts,
    notifyControllers,
    notifyControllersByCommit,
    peers,
    persistScopeNow,
    persistSlideMetadata,
    registerPeer,
    registerActiveVideo,
    resolveScopeId,
    saveScope,
    scopedState,
    sendJSON,
    sendVideoSyncToRelevantWalls,
    setEditorScope,
    unbindWall,
    unregisterActiveVideo,
    unregisterPeer,
    upsertControllerTransientLayer,
    galleriesByWallId,
    wallBindings,
    wallBindingSources,
    type PeerEntry
} from '~/lib/busState';
import { validatePortalToken } from '~/lib/portalTokens';
import { markScopeDirty } from '~/lib/scopePersistence';
import { GSMessageSchema, HelloSchema, makeScopeLabel, type GSMessage } from '~/lib/types';
import { logAuditDenied } from '~/server/audit';
import { dbCol } from '~/server/collections';
import { ensureDeviceByPublicKey } from '~/server/devices';
import { resolveAuthContextFromRequest } from '~/server/requestAuthContext';

import { editorProjectPermissions, enforceWsRateLimit } from './bus.authz';
import {
    broadcastWallBindingToEditors,
    broadcastWallBindingToGalleries,
    broadcastWallNodeCountToEditors,
    clearPendingBindOverride,
    BIND_OVERRIDE_TIMEOUT_MS,
    pendingBindOverrides,
    pendingBindOverrideByWall,
    performLiveBind,
    resolveBoundSlideId,
    sendBindOverrideResult,
    sendSlidesSnapshotToControllerPeer
} from './bus.binding';
import {
    clearPendingHelloAuth,
    issueHelloChallenge,
    pendingHelloAuthByPeer,
    verifyDeviceSignature
} from './bus.crypto';
import {
    completeHelloRegistration,
    handleEditorScopeVacated,
    registerEditorPeer
} from './bus.peers';

export interface HandlerCtx {
    entry: PeerEntry;
    data: Record<string, any>;
    scopeId: number | null;
    rawText: string;
}

export type Handler = (ctx: HandlerCtx) => void;

export const handlers = new Map<string, Handler>();

const lastPlaybackCommandAt = new Map<string, number>();

function playbackCommandKey(scopeId: number, numericId: number): string {
    return `${scopeId}:${numericId}`;
}

function shouldApplyPlaybackCommand(
    scopeId: number,
    numericId: number,
    issuedAt: unknown
): boolean {
    const now = Date.now();
    const fromClient = typeof issuedAt === 'number' && Number.isFinite(issuedAt) ? issuedAt : null;
    // Protect against cross-device clock skew: trust client timestamp only if it is near server now.
    const stamp = fromClient !== null && Math.abs(fromClient - now) <= 15_000 ? fromClient : now;
    const key = playbackCommandKey(scopeId, numericId);
    const prev = lastPlaybackCommandAt.get(key);
    if (prev !== undefined && stamp < prev) return false;
    lastPlaybackCommandAt.set(key, stamp);
    return true;
}

function clearPlaybackCommand(scopeId: number, numericId: number) {
    lastPlaybackCommandAt.delete(playbackCommandKey(scopeId, numericId));
}

// ── Handler registrations ───────────────────────────────────────────────────

handlers.set('rehydrate_please', ({ entry }) => {
    const { meta } = entry;

    if (meta.specimen === 'editor') {
        if (!meta.scope) {
            entry.peer.send(EMPTY_HYDRATE);
            return;
        }
        entry.peer.send(getEditorHydratePayload(meta.scope.scopeId));
    } else if (meta.specimen === 'wall') {
        const boundScope = wallBindings.get(meta.wallId);
        entry.peer.send(
            boundScope !== undefined
                ? getWallHydratePayload(boundScope, meta.wallId)
                : EMPTY_HYDRATE
        );
    } else if (meta.specimen === 'controller') {
        const boundScope = wallBindings.get(meta.wallId);
        entry.peer.send(
            boundScope !== undefined
                ? getWallHydratePayload(boundScope, meta.wallId)
                : EMPTY_HYDRATE
        );
        if (boundScope !== undefined) {
            const scope = scopedState.get(boundScope);
            if (scope?.commitId) {
                void sendSlidesSnapshotToControllerPeer(entry.peer, scope.commitId);
            }
        }
    }
});

handlers.set('clear_stage', ({ entry, scopeId }) => {
    if (scopeId === null) return;
    const scope = scopedState.get(scopeId);
    if (scope) {
        for (const numericId of scope.layers.keys()) {
            clearPlaybackCommand(scopeId, numericId);
        }
        scope.layers.clear();
        markScopeDirty(scope);
    }
    clearActiveVideosForScope(scopeId);
    clearControllerTransientForScope(scopeId);
    // clearLayerNodesForScope(scopeId);
    invalidateHydrateCache(scopeId);
    const clearPayload = { type: 'hydrate', layers: [] } satisfies GSMessage;
    broadcastToScope(scopeId, clearPayload, entry);
    broadcastToControllersByScopeRaw(scopeId, JSON.stringify(clearPayload));
});

handlers.set('upsert_layer', ({ entry, data, scopeId, rawText }) => {
    let layer = data.layer;
    if (typeof layer?.numericId !== 'number') return;

    const isControllerTransientUpsert = data.origin === 'controller:add_line_layer';
    let relayPayload = rawText;

    if (scopeId !== null) {
        const scope = scopedState.get(scopeId);
        if (scope) {
            if (isControllerTransientUpsert) {
                // Controller drawings are transient wall overlays: no DB persistence and no editor fanout.
                if (entry.meta.specimen !== 'controller') return;
                upsertControllerTransientLayer(entry.meta.wallId, layer);
            } else {
                // Playback timeline is authoritative via video_play/pause/seek handlers.
                // Generic upsert_layer must never override live playback state.
                if (layer.type === 'video') {
                    const existing = scope.layers.get(layer.numericId);
                    if (existing?.type === 'video' && existing.playback) {
                        layer = { ...layer, playback: existing.playback };
                        relayPayload = JSON.stringify({ ...data, layer });
                    } else if (!layer.playback) {
                        layer = {
                            ...layer,
                            playback: {
                                status: 'paused',
                                anchorMediaTime: 0,
                                anchorServerTime: 0
                            }
                        };
                        relayPayload = JSON.stringify({ ...data, layer });
                    }
                }
                const isNewLayer = !scope.layers.has(layer.numericId);
                scope.layers.set(layer.numericId, layer);
                markScopeDirty(scope);
                invalidateHydrateCache(scopeId);
                // A new layer exists only in memory until the 30s autosave tick.
                // Anything reading it from the commit — the Yjs text session
                // does — would fail for that whole window, so make it durable
                // now. Updates to an existing layer can wait for the tick.
                if (isNewLayer) {
                    const createRequestId = data.createRequestId;
                    const numericId = layer.numericId;
                    persistScopeNow(scopeId, 'Layer added', (result) => {
                        if (!createRequestId) return;
                        sendJSON(entry.peer, {
                            type: 'layer_create_response',
                            createRequestId,
                            numericId,
                            success: result.success,
                            error: result.error
                        });
                    });
                }
            }
        }
        // recomputeLayerNodes(layer.numericId, layer, scopeId);
        if (isControllerTransientUpsert) {
            if (entry.meta.specimen !== 'controller') return;
            broadcastToWallNodesRaw(entry.meta.wallId, relayPayload);
            broadcastToControllersByWallRaw(entry.meta.wallId, relayPayload, entry);
        } else {
            broadcastToScopeRaw(scopeId, relayPayload, entry);
        }
    }
});

handlers.set('delete_layer', ({ entry, data, scopeId, rawText }) => {
    if (scopeId === null) return;
    const isControllerTransientDelete = data.origin === 'controller:add_line_layer';
    const scope = scopedState.get(scopeId);
    let deletedPersistentLayer = false;
    let deletedControllerTransient = false;

    if (scope) {
        if (isControllerTransientDelete) {
            if (entry.meta.specimen !== 'controller') return;
            deletedControllerTransient = deleteControllerTransientLayer(
                entry.meta.wallId,
                data.numericId
            );
        } else {
            deletedPersistentLayer = scope.layers.delete(data.numericId);
            if (deletedPersistentLayer) {
                clearPlaybackCommand(scopeId, data.numericId);
                markScopeDirty(scope);
                deleteYDocForLayer(scopeId, data.numericId);
            }
            deletedControllerTransient = deleteControllerTransientLayerForScope(
                scopeId,
                data.numericId
            );
            invalidateHydrateCache(scopeId);
        }
    }

    if (deletedPersistentLayer) {
        unregisterActiveVideo(data.numericId);
    }
    // deleteLayerNodes(data.numericId);
    if (isControllerTransientDelete || (deletedControllerTransient && !deletedPersistentLayer)) {
        if (entry.meta.specimen !== 'controller') return;
        broadcastToWallNodesRaw(entry.meta.wallId, rawText);
        broadcastToControllersByWallRaw(entry.meta.wallId, rawText, entry);
    } else {
        broadcastToScopeRaw(scopeId, rawText, entry);
    }
});

handlers.set('seed_scope', ({ entry, data, scopeId }) => {
    if (scopeId === null) return;
    const scope = scopedState.get(scopeId);
    if (!scope) return;

    // Replace all layers wholesale
    scope.layers.clear();
    for (const layer of data.layers) {
        if (typeof layer?.numericId === 'number') {
            scope.layers.set(layer.numericId, layer);
        }
    }
    markScopeDirty(scope);

    clearActiveVideosForScope(scopeId);
    clearControllerTransientForScope(scopeId);
    invalidateHydrateCache(scopeId);

    // Cascade hydrate to all bound walls
    for (const [wallId, boundScope] of wallBindings) {
        if (boundScope === scopeId) {
            hydrateWallNodes(wallId);
        }
    }

    // Broadcast hydrate to other editors in scope
    broadcastToEditors(
        scopeId,
        { type: 'hydrate', layers: Array.from(scope.layers.values()) },
        entry
    );
});

handlers.set('update_slides', ({ entry, data }) => {
    const { commitId, slides } = data;
    if (!commitId || !Array.isArray(slides)) return;

    // Persist metadata to DB (no layer changes)
    persistSlideMetadata(commitId, slides).then((ok) => {
        if (!ok) {
            console.error(`[Bus] Failed to persist slide metadata for commit ${commitId}`);
            return;
        }

        // Broadcast slides_updated to all editors + controllers on this commit
        const payload = JSON.stringify({ type: 'slides_updated', commitId, slides });
        broadcastToEditorsByCommit(commitId, payload, entry);
        notifyControllersByCommit(commitId, payload);
    });
});

handlers.set('reboot', ({ scopeId, rawText }) => {
    if (scopeId !== null) {
        broadcastToWallsRaw(scopeId, rawText);
    }
});

handlers.set('stage_dirty', ({ scopeId }) => {
    if (scopeId === null) return;
    const scope = scopedState.get(scopeId);
    if (scope) markScopeDirty(scope);
});

handlers.set('leave_scope', ({ entry }) => {
    const meta = entry.meta;
    if (meta.specimen !== 'editor' || !meta.scope) return;
    const scopeId = meta.scope.scopeId;
    setEditorScope(entry, null);
    handleEditorScopeVacated(scopeId);
    logPeerCounts();
});

handlers.set('stage_save', ({ entry, data, scopeId }) => {
    if (scopeId === null) {
        sendJSON(entry.peer, {
            type: 'stage_save_response',
            success: false,
            error: 'Not in a scope'
        });
        return;
    }

    const capturedScopeId = scopeId;
    const capturedEntry = entry;

    saveScope(
        capturedScopeId,
        data.message,
        data.isAutoSave ?? false,
        capturedEntry.meta.authContext?.user?.email ?? null
    ).then((result) => {
        const response: GSMessage = {
            type: 'stage_save_response',
            success: result.success,
            commitId: result.commitId,
            error: result.error
        };
        sendJSON(capturedEntry.peer, response);

        if (result.success) {
            broadcastToEditors(capturedScopeId, response, capturedEntry);
        }
    });
});

handlers.set('bind_wall', ({ entry, data }) => {
    // Editors should route through request_bind_wall (approval gate).
    // Keep bind_wall for controllers and system/internal callers.
    void (async () => {
        const source =
            entry.meta.specimen === 'gallery'
                ? 'gallery'
                : entry.meta.specimen === 'controller' &&
                    wallBindingSources.get(data.wallId) === 'gallery'
                  ? 'gallery'
                  : 'live';
        await performLiveBind(data.wallId, data.projectId, data.commitId, data.slideId, source);
    })();
});

handlers.set('request_bind_wall', ({ entry, data }) => {
    if (entry.meta.specimen !== 'editor') {
        sendJSON(entry.peer, {
            type: 'bind_override_result',
            requestId: data.requestId,
            wallId: data.wallId,
            allow: false,
            reason: 'invalid'
        });
        return;
    }
    const userEmail =
        entry.meta.specimen === 'editor' ? entry.meta.authContext?.user?.email : undefined;

    void (async () => {
        const resolvedSlideId = await resolveBoundSlideId(
            data.projectId,
            data.commitId,
            data.slideId
        );
        if (!resolvedSlideId) {
            sendBindOverrideResult(entry.peer.id, {
                type: 'bind_override_result',
                requestId: data.requestId,
                wallId: data.wallId,
                allow: false,
                reason: 'invalid'
            });
            return;
        }

        const targetScopeId = internScope(data.projectId, data.commitId, resolvedSlideId);
        const currentScopeId = wallBindings.get(data.wallId);
        const hasConflict = currentScopeId !== undefined && currentScopeId !== targetScopeId;

        // If the wall is live-bound and the requester is already in the currently-bound
        // scope (i.e. same user navigating slides — switch_scope is async so their scope
        // entry still reflects the old slide when this message is processed), let them
        // re-bind without going through the gallery override flow.
        const isSameUser =
            hasConflict &&
            userEmail !== undefined &&
            wallBindingSources.get(data.wallId) === 'live' &&
            [...(editorsByScope.get(currentScopeId!) ?? [])].some(
                (e) => e.meta.specimen === 'editor' && e.meta.authContext?.user?.email === userEmail
            );

        if (!hasConflict || isSameUser) {
            const result = await performLiveBind(
                data.wallId,
                data.projectId,
                data.commitId,
                resolvedSlideId
            );
            sendBindOverrideResult(entry.peer.id, {
                type: 'bind_override_result',
                requestId: data.requestId,
                wallId: data.wallId,
                allow: result.ok,
                reason: result.ok
                    ? 'not_required'
                    : result.error === 'unknown_wall'
                      ? 'unknown_wall'
                      : 'invalid'
            });
            return;
        }

        const galleries = galleriesByWallId.get(data.wallId);
        const hasGalleryApprover = Boolean(galleries && galleries.size > 0);
        if (!hasGalleryApprover) {
            const result = await performLiveBind(
                data.wallId,
                data.projectId,
                data.commitId,
                resolvedSlideId
            );
            sendBindOverrideResult(entry.peer.id, {
                type: 'bind_override_result',
                requestId: data.requestId,
                wallId: data.wallId,
                allow: result.ok,
                reason: result.ok
                    ? 'not_required'
                    : result.error === 'unknown_wall'
                      ? 'unknown_wall'
                      : 'invalid'
            });
            return;
        }

        const existingRequestId = pendingBindOverrideByWall.get(data.wallId);
        if (existingRequestId) {
            clearPendingBindOverride(existingRequestId);
        }

        const expiresAt = Date.now() + BIND_OVERRIDE_TIMEOUT_MS;
        const timer = setTimeout(() => {
            const pending = clearPendingBindOverride(data.requestId);
            if (!pending) return;
            sendBindOverrideResult(pending.requesterPeerId, {
                type: 'bind_override_result',
                requestId: pending.requestId,
                wallId: pending.wallId,
                allow: false,
                reason: 'timeout'
            });
        }, BIND_OVERRIDE_TIMEOUT_MS);

        pendingBindOverrides.set(data.requestId, {
            requestId: data.requestId,
            requesterPeerId: entry.peer.id,
            wallId: data.wallId,
            projectId: data.projectId,
            commitId: data.commitId,
            slideId: resolvedSlideId,
            timer
        });
        pendingBindOverrideByWall.set(data.wallId, data.requestId);

        const requestPayload = JSON.stringify({
            type: 'bind_override_requested',
            requestId: data.requestId,
            wallId: data.wallId,
            projectId: data.projectId,
            commitId: data.commitId,
            slideId: resolvedSlideId,
            expiresAt,
            ...(userEmail ? { requesterEmail: userEmail } : {})
        } satisfies GSMessage);

        for (const galleryEntry of galleries!) {
            galleryEntry.peer.send(requestPayload);
        }
    })();
});

handlers.set('bind_override_decision', ({ entry, data }) => {
    if (entry.meta.specimen !== 'gallery') return;
    if (entry.meta.wallId !== data.wallId) return;

    let pending = clearPendingBindOverride(data.requestId);
    // The gallery UI can act on a slightly stale requestId while a newer request
    // for the same wall is already pending. In that case, apply the decision to
    // the current wall-scoped pending request instead of silently dropping it.
    // TO-DO review if the assumption of gallery stalness is trulye correct
    if (!pending) {
        const latestRequestId = pendingBindOverrideByWall.get(data.wallId);
        if (latestRequestId) {
            pending = clearPendingBindOverride(latestRequestId);
        }
    }
    if (!pending) return;
    if (pending.wallId !== data.wallId) return;

    if (!data.allow) {
        sendBindOverrideResult(pending.requesterPeerId, {
            type: 'bind_override_result',
            requestId: pending.requestId,
            wallId: pending.wallId,
            allow: false,
            reason: 'denied'
        });
        return;
    }

    void (async () => {
        const result = await performLiveBind(
            pending.wallId,
            pending.projectId,
            pending.commitId,
            pending.slideId
        );
        sendBindOverrideResult(pending.requesterPeerId, {
            type: 'bind_override_result',
            requestId: pending.requestId,
            wallId: pending.wallId,
            allow: result.ok,
            reason: result.ok
                ? 'approved'
                : result.error === 'unknown_wall'
                  ? 'unknown_wall'
                  : 'invalid'
        });
    })();
});

handlers.set('unbind_wall', ({ data }) => {
    cancelWallUnbindGrace(data.wallId);
    unbindWall(data.wallId);
    hydrateWallNodes(data.wallId);
    broadcastToControllersByWallRaw(
        data.wallId,
        JSON.stringify({ type: 'hydrate', layers: [] } satisfies GSMessage)
    );
    notifyControllers(data.wallId, false);
    void dbCol.walls.updateByWallId(data.wallId, {
        boundProjectId: null,
        boundCommitId: null,
        boundSlideId: null,
        boundSource: null
    });
    broadcastWallBindingToEditors(data.wallId);
    broadcastWallBindingToGalleries(data.wallId);
    broadcastWallNodeCountToEditors(data.wallId);
    console.log(`[WS] Wall ${data.wallId} unbound`);
});

handlers.set('video_play', ({ data, scopeId }) => {
    if (scopeId === null) return;
    if (!shouldApplyPlaybackCommand(scopeId, data.numericId, data.issuedAt)) return;
    const layer = scopedState.get(scopeId)?.layers.get(data.numericId);
    if (layer?.type === 'video') {
        const leadMs = estimatePlaybackLeadMs(scopeId);
        layer.playback.status = 'playing';
        layer.playback.anchorServerTime = Date.now() + leadMs;
        registerActiveVideo(data.numericId, scopeId, layer);
        sendVideoSyncToRelevantWalls(data.numericId, scopeId, layer.playback, {
            criticalToWalls: true
        });
    }
});

handlers.set('video_pause', ({ data, scopeId }) => {
    if (scopeId === null) return;
    if (!shouldApplyPlaybackCommand(scopeId, data.numericId, data.issuedAt)) return;
    const layer = scopedState.get(scopeId)?.layers.get(data.numericId);
    if (layer?.type === 'video' && layer.playback.status === 'playing') {
        let elapsed = (Date.now() - layer.playback.anchorServerTime) / 1000;
        if (elapsed < 0) elapsed = 0;

        layer.playback.status = 'paused';
        layer.playback.anchorMediaTime += elapsed;
        layer.playback.anchorServerTime = 0;

        unregisterActiveVideo(data.numericId);
        sendVideoSyncToRelevantWalls(data.numericId, scopeId, layer.playback, {
            criticalToWalls: true
        });
    }
});

handlers.set('video_seek', ({ data, scopeId }) => {
    if (scopeId === null) return;
    if (!shouldApplyPlaybackCommand(scopeId, data.numericId, data.issuedAt)) return;
    const layer = scopedState.get(scopeId)?.layers.get(data.numericId);
    if (layer?.type === 'video') {
        layer.playback.status = 'paused';
        layer.playback.anchorMediaTime = data.mediaTime;
        layer.playback.anchorServerTime = 0;

        unregisterActiveVideo(data.numericId);
        sendVideoSyncToRelevantWalls(data.numericId, scopeId, layer.playback, {
            criticalToWalls: true
        });
    }
});

// ── Special message handlers (not registered in handlers Map) ───────────────

export async function handleHello(peer: Peer, data: Record<string, any>) {
    // Full Zod validation on handshake
    const parsed = HelloSchema.parse(data);

    // Re-registration: clean up old state first
    const existing = peers.get(peer.id);
    if (existing) unregisterPeer(peer.id);
    editorProjectPermissions.delete(peer.id);
    clearPendingHelloAuth(peer.id);

    if (parsed.specimen === 'editor') {
        const {
            authContext: { user }
        } = await resolveAuthContextFromRequest(peer.request);
        if (!user) {
            await logAuditDenied({
                action: 'WS_HANDSHAKE_DENIED',
                reasonCode: 'MISSING_SESSION',
                resourceType: 'ws_message',
                resourceId: 'hello',
                executionContext: {
                    surface: 'ws',
                    operation: 'hello',
                    peerId: peer.id,
                    details: { specimen: 'editor' }
                }
            });
            sendJSON(peer, { type: 'auth_denied', reason: 'missing_session' });
            try {
                peer.close();
            } catch {
                // no-op
            }
            return;
        }
        registerPeer(peer, {
            specimen: 'editor',
            authContext: {
                user
            }
        });
        sendJSON(peer, { type: 'hello_authenticated' });
        console.log('[WS] Editor registered (no scope)');
        logPeerCounts();
        return;
    }

    issueHelloChallenge(peer, parsed);
}

export async function handleHelloAuth(peer: Peer, data: Record<string, any>) {
    const parsed = GSMessageSchema.parse(data);
    if (parsed.type !== 'hello_auth') return;

    const pending = pendingHelloAuthByPeer.get(peer.id);
    if (!pending) {
        console.warn(`[WS] hello_auth without pending challenge from peer ${peer.id}`);
        await logAuditDenied({
            action: 'WS_HANDSHAKE_DENIED',
            reasonCode: 'MISSING_HELLO_CHALLENGE',
            resourceType: 'ws_message',
            resourceId: 'hello_auth',
            executionContext: {
                surface: 'ws',
                operation: 'hello_auth',
                peerId: peer.id
            }
        });
        return;
    }

    let authenticated = false;
    const resolvedAuth: import('~/server/requestAuthContext').AuthContext = {};

    if (parsed.proof.signature && pending.hello.devicePublicKey) {
        const valid = await verifyDeviceSignature(
            pending.hello.devicePublicKey,
            pending.nonce,
            parsed.proof.signature
        );
        if (valid) {
            const kind: 'wall' | 'controller' | 'gallery' =
                pending.hello.specimen === 'wall'
                    ? 'wall'
                    : pending.hello.specimen === 'controller'
                      ? 'controller'
                      : 'gallery';
            const ensuredDevice = await ensureDeviceByPublicKey({
                publicKey: pending.hello.devicePublicKey,
                kind
            });
            authenticated = true;
            if (pending.hello.specimen === 'wall') {
                resolvedAuth.device = {
                    id: ensuredDevice.id,
                    kind: 'wall',
                    wallId: pending.hello.wallId
                };
            } else if (pending.hello.specimen === 'controller') {
                resolvedAuth.device = {
                    id: ensuredDevice.id,
                    kind: 'controller',
                    wallId: pending.hello.wallId
                };
            } else {
                resolvedAuth.device = {
                    id: ensuredDevice.id,
                    kind: 'gallery',
                    ...(pending.hello.wallId ? { wallId: pending.hello.wallId } : {})
                };
            }
        } else {
            console.warn(`[WS] Invalid hello signature from peer ${peer.id}`);
        }
    }

    if (parsed.proof.portalToken) {
        if (pending.hello.specimen === 'controller') {
            const validated = validatePortalToken(parsed.proof.portalToken);
            if (validated && validated.wallId === pending.hello.wallId) {
                resolvedAuth.portal = { wallId: validated.wallId };
                if (!authenticated) {
                    authenticated = true;
                }
            } else if (!authenticated) {
                console.warn(`[WS] Invalid controller portal token on peer ${peer.id}`);
            }
        } else if (!authenticated) {
            console.warn(
                `[WS] portalToken proof is only supported for controller peers (${peer.id})`
            );
        }
    }

    if (!authenticated) {
        clearPendingHelloAuth(peer.id);
        console.warn(`[WS] hello_auth failed for peer ${peer.id}`);
        await logAuditDenied({
            action: 'WS_HANDSHAKE_DENIED',
            reasonCode: 'HELLO_AUTH_FAILED',
            resourceType: 'ws_message',
            resourceId: 'hello_auth',
            executionContext: {
                surface: 'ws',
                operation: 'hello_auth',
                peerId: peer.id,
                details: { specimen: pending.hello.specimen }
            }
        });
        try {
            peer.close();
        } catch {
            // no-op
        }
        return;
    }

    const {
        authContext: { user }
    } = await resolveAuthContextFromRequest(peer.request);
    if (user) {
        resolvedAuth.user = user;
    }

    sendJSON(peer, { type: 'hello_authenticated' });
    const registration = await completeHelloRegistration(peer, pending.hello, resolvedAuth);
    if (!registration.pendingEnrollment) {
        clearPendingHelloAuth(peer.id);
    }
}

export async function handleSwitchScope(peer: Peer, data: Record<string, any>) {
    const parsed = GSMessageSchema.parse(data);
    if (parsed.type !== 'switch_scope') return;

    if (!(await enforceWsRateLimit(peer, parsed.type, { projectId: parsed.projectId }))) {
        return;
    }

    const existing = peers.get(peer.id);
    if (existing && existing.meta.specimen !== 'editor') {
        console.warn(`[WS] switch_scope rejected for non-editor peer ${peer.id}`);
        await logAuditDenied({
            action: 'WS_MESSAGE_DENIED',
            reasonCode: 'SWITCH_SCOPE_NON_EDITOR',
            resourceType: 'ws_message',
            resourceId: 'switch_scope',
            authContext: existing.meta.authContext,
            executionContext: {
                surface: 'ws',
                operation: 'switch_scope',
                peerId: peer.id,
                details: { specimen: existing.meta.specimen }
            }
        });
        return;
    }

    if (!existing || existing.meta.specimen !== 'editor') {
        console.warn(`[WS] switch_scope from unauthenticated peer ${peer.id}`);
        await logAuditDenied({
            action: 'WS_MESSAGE_DENIED',
            reasonCode: 'SWITCH_SCOPE_UNAUTHENTICATED',
            resourceType: 'ws_message',
            resourceId: 'switch_scope',
            executionContext: {
                surface: 'ws',
                operation: 'switch_scope',
                peerId: peer.id
            }
        });
        return;
    }

    const registered = await registerEditorPeer(peer, {
        projectId: parsed.projectId,
        commitId: parsed.commitId,
        slideId: parsed.slideId
    });
    if (!registered) return;

    console.log(
        `[WS] Editor switched scope=${makeScopeLabel(parsed.projectId, parsed.commitId, parsed.slideId)}`
    );
    logPeerCounts();
}
