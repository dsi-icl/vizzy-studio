import type { StageLayout } from '@repo/db/schema';
import type { Peer } from 'crossws';

import type { GSMessage } from '~/lib/types';

import { getEditorHydratePayload, getWallHydratePayload } from './busState.scopes';
import {
    canSendNonCritical,
    commitToScopeIds,
    controllersByWallId,
    editorsByScope,
    EMPTY_HYDRATE,
    markOutgoing,
    scopedState,
    scopeWatchers,
    wallBindings,
    wallBindingSources,
    wallPeersByScope,
    wallsByWallId,
    type PeerEntry,
    type ScopeId
} from './busState.state';

export function estimatePlaybackLeadMs(scopeId: ScopeId): number {
    const targets = wallPeersByScope.get(scopeId);
    if (!targets || targets.size === 0) return 180;

    let congested = 0;
    for (const entry of targets) {
        if (!canSendNonCritical(entry.peer)) congested += 1;
    }

    // Adaptive lead:
    // - scale with fanout size,
    // - add extra margin when some peers are congested.
    const dynamic = 160 + Math.min(420, targets.size * 15 + congested * 120);
    return Math.max(120, Math.min(600, dynamic));
}

export function sendJSON(peer: Peer, data: GSMessage) {
    markOutgoing(1, 0);
    peer.send(JSON.stringify(data));
}

export function broadcastToEditorsRaw(scopeId: ScopeId, payload: string, exclude?: PeerEntry) {
    const set = editorsByScope.get(scopeId);
    if (!set) return;
    let sent = 0;
    for (const entry of set) {
        if (entry !== exclude) {
            entry.peer.send(payload);
            sent += 1;
        }
    }
    markOutgoing(sent, 0);
}

export function broadcastToEditors(scopeId: ScopeId, data: GSMessage, exclude?: PeerEntry) {
    broadcastToEditorsRaw(scopeId, JSON.stringify(data), exclude);
}

export function broadcastToWallsRaw(scopeId: ScopeId, payload: string) {
    const set = wallPeersByScope.get(scopeId);
    if (!set) return;
    for (const entry of set) entry.peer.send(payload);
    markOutgoing(set.size, 0);
}

export function broadcastToWallNodesRaw(wallId: string, payload: string) {
    const wallPeers = wallsByWallId.get(wallId);
    if (!wallPeers) return;
    for (const entry of wallPeers) entry.peer.send(payload);
    markOutgoing(wallPeers.size, 0);
}

export function broadcastToControllersByWallRaw(
    wallId: string,
    payload: string,
    exclude?: PeerEntry
) {
    const controllers = controllersByWallId.get(wallId);
    if (!controllers) return;
    let sent = 0;
    for (const entry of controllers) {
        if (entry !== exclude) {
            entry.peer.send(payload);
            sent += 1;
        }
    }
    markOutgoing(sent, 0);
}

export function broadcastToControllersByScopeRaw(scopeId: ScopeId, payload: string) {
    const watchers = scopeWatchers.get(scopeId);
    if (!watchers || watchers.size === 0) return;
    let sent = 0;
    for (const wallId of watchers) {
        const controllers = controllersByWallId.get(wallId);
        if (!controllers) continue;
        for (const entry of controllers) {
            entry.peer.send(payload);
            sent += 1;
        }
    }
    markOutgoing(sent, 0);
}

export function broadcastToWalls(scopeId: ScopeId, data: GSMessage) {
    broadcastToWallsRaw(scopeId, JSON.stringify(data));
}

export function broadcastToWallsBinary(scopeId: ScopeId, data: ArrayBuffer) {
    const set = wallPeersByScope.get(scopeId);
    if (!set) return;
    let sent = 0;
    for (const entry of set) {
        if (canSendNonCritical(entry.peer)) {
            entry.peer.send(data);
            sent += 1;
        }
    }
    markOutgoing(0, sent);
}

export function broadcastToScopeRaw(scopeId: ScopeId, payload: string, exclude?: PeerEntry) {
    broadcastToEditorsRaw(scopeId, payload, exclude);
    broadcastToWallsRaw(scopeId, payload);
}

export function broadcastToScope(scopeId: ScopeId, data: GSMessage, exclude?: PeerEntry) {
    const payload = JSON.stringify(data);
    broadcastToEditorsRaw(scopeId, payload, exclude);
    broadcastToWallsRaw(scopeId, payload);
}

/** Broadcast a payload to all editors whose scope matches a given commitId (across all slides). */
export function broadcastToEditorsByCommit(commitId: string, payload: string, exclude?: PeerEntry) {
    const scopeIds = commitToScopeIds.get(commitId);
    if (!scopeIds) return;
    let sent = 0;
    for (const scopeId of scopeIds) {
        const set = editorsByScope.get(scopeId);
        if (!set) continue;
        for (const entry of set) {
            if (entry !== exclude) {
                entry.peer.send(payload);
                sent += 1;
            }
        }
    }
    markOutgoing(sent, 0);
}

function notifyControllersByWallIds(wallIds: Set<string>, payload: string) {
    let sent = 0;
    for (const wallId of wallIds) {
        const entries = controllersByWallId.get(wallId);
        if (!entries) continue;
        for (const entry of entries) {
            entry.peer.send(payload);
            sent += 1;
        }
    }
    markOutgoing(sent, 0);
}

/** Notify all controllers whose wall is bound to any scope with the given commitId. */
export function notifyControllersByCommit(commitId: string, payload: string) {
    const scopeIds = commitToScopeIds.get(commitId);
    if (!scopeIds) return;

    const wallIds = new Set<string>();
    for (const scopeId of scopeIds) {
        const watchers = scopeWatchers.get(scopeId);
        if (!watchers) continue;
        for (const wallId of watchers) wallIds.add(wallId);
    }
    notifyControllersByWallIds(wallIds, payload);
}

// Hydrate all wall peers for a given wallId with their bound scope's layers
export function hydrateWallNodes(wallId: string) {
    const scopeId = wallBindings.get(wallId);
    const payload = scopeId !== undefined ? getWallHydratePayload(scopeId, wallId) : EMPTY_HYDRATE;

    const wallPeers = wallsByWallId.get(wallId);
    if (!wallPeers) return;
    for (const entry of wallPeers) entry.peer.send(payload);
    markOutgoing(wallPeers.size, 0);
}

/**
 * Update customRenderUrl for all active scopes belonging to a project,
 * invalidate their hydrate caches, and re-hydrate any bound walls.
 */
export function updateProjectCustomRenderSettings(
    projectId: string,
    customRenderUrl: string | undefined,
    customRenderCompat?: boolean,
    customRenderProxy?: boolean
) {
    const affectedWallIds = new Set<string>();
    for (const [scopeId, scope] of scopedState) {
        if (scope.projectId !== projectId) continue;
        scope.customRenderUrl = customRenderUrl;
        if (customRenderCompat !== undefined) {
            scope.customRenderCompat = customRenderCompat;
        }
        if (customRenderProxy !== undefined) {
            scope.customRenderProxy = customRenderProxy;
        }
        scope.hydrateCache = null;
        // Find walls bound to this scope
        for (const [wallId, boundScopeId] of wallBindings) {
            if (boundScopeId === scopeId) affectedWallIds.add(wallId);
        }
    }
    for (const wallId of affectedWallIds) {
        hydrateWallNodes(wallId);
        const boundScope = wallBindings.get(wallId);
        if (boundScope !== undefined) {
            broadcastToControllersByWallRaw(wallId, getWallHydratePayload(boundScope, wallId));
        }
    }
}

export function updateRuntimeStageLayout(projectId: string, stageId: string, layout: StageLayout) {
    const affectedWallIds = new Set<string>();
    for (const [scopeId, scope] of scopedState) {
        if (scope.projectId !== projectId || scope.stageId !== stageId) continue;
        scope.layout = layout;
        scope.hydrateCache = null;
        broadcastToEditorsRaw(scopeId, getEditorHydratePayload(scopeId));
        for (const [wallId, boundScopeId] of wallBindings) {
            if (boundScopeId === scopeId) affectedWallIds.add(wallId);
        }
    }
    for (const wallId of affectedWallIds) {
        hydrateWallNodes(wallId);
        const scopeId = wallBindings.get(wallId);
        if (scopeId !== undefined) {
            broadcastToControllersByWallRaw(wallId, getWallHydratePayload(scopeId, wallId));
        }
    }
}

/** Broadcast asset_added to all editors working on the same project (across all scopes). */
export function broadcastAssetToEditorsByProject(
    projectId: string,
    asset: Record<string, unknown>
) {
    const payload = JSON.stringify({ type: 'asset_added', projectId, asset });
    let sent = 0;
    for (const [scopeId, scope] of scopedState) {
        if (scope.projectId === projectId) {
            const set = editorsByScope.get(scopeId);
            if (!set) continue;
            for (const entry of set) {
                entry.peer.send(payload);
                sent++;
            }
        }
    }
    markOutgoing(sent, 0);
    console.log(
        `[Bus] asset_added broadcast: projectId=${projectId}, sent to ${sent} editor(s), scopes=${scopedState.size}`
    );
}

// Notify all controllers for a wallId about binding status
export function notifyControllers(
    wallId: string,
    bound: boolean,
    projectId?: string,
    commitId?: string,
    slideId?: string,
    customRenderUrl?: string,
    boundSource?: 'live' | 'gallery' | 'signage'
) {
    const entries = controllersByWallId.get(wallId);
    if (!entries) return;
    const resolvedSource = boundSource ?? wallBindingSources.get(wallId);

    const payload = JSON.stringify({
        type: 'wall_binding_status',
        wallId,
        bound,
        ...(projectId ? { projectId } : {}),
        ...(commitId ? { commitId } : {}),
        ...(slideId ? { slideId } : {}),
        ...(customRenderUrl ? { customRenderUrl } : {}),
        ...(resolvedSource ? { boundSource: resolvedSource } : {})
    });

    for (const entry of entries) entry.peer.send(payload);
    markOutgoing(entries.size, 0);
}
