import type { Peer } from 'crossws';

import { scopedState, wallBindings, type PeerEntry } from '~/lib/busState';
import { logAuditDenied } from '~/server/audit';
import {
    buildRateLimitSubjectKey,
    checkRateLimit,
    getClientIpFromHeaders
} from '~/server/rateLimit';

export const editorProjectPermissions = new Map<
    string,
    { projectId: string; canView: boolean; canEdit: boolean }
>();

export const wsRateLimitStrikes = new Map<string, number>();

export const WS_RATE_LIMIT_STRIKE_LIMIT = Math.max(
    1,
    Number(process.env.WS_RATE_LIMIT_STRIKE_LIMIT ?? '5')
);

export const WS_MUTATION_MESSAGE_TYPES = new Set([
    'clear_stage',
    'upsert_layer',
    'delete_layer',
    'seed_scope',
    'update_slides',
    'reboot',
    'stage_dirty',
    'stage_save',
    'switch_scope',
    'bind_wall',
    'request_bind_wall',
    'bind_override_decision',
    'unbind_wall',
    'video_play',
    'video_pause',
    'video_seek'
]);

export const VIEW_PROJECT_MESSAGE_TYPES = new Set([
    'rehydrate_please',
    'video_play',
    'video_pause',
    'video_seek'
]);

export const EDIT_PROJECT_MESSAGE_TYPES = new Set([
    'clear_stage',
    'upsert_layer',
    'delete_layer',
    'seed_scope',
    'update_slides',
    'stage_dirty',
    'stage_save',
    'request_bind_wall'
]);

export const WS_HANDSHAKE_MESSAGE_TYPES = new Set(['hello', 'hello_auth']);

// TODO Review if authed logic is warranted here
export function getWsRateLimitIdentity(peer: Peer): string {
    const ip = getClientIpFromHeaders(peer.request?.headers as Headers | undefined);
    return buildRateLimitSubjectKey({ ip, peerId: peer.id });
}

export function getWsHandshakeRateLimitIdentity(peer: Peer): string {
    const ip = getClientIpFromHeaders(peer.request?.headers as Headers | undefined);
    return buildRateLimitSubjectKey({ ip });
}

export function getEntryProjectId(entry: PeerEntry): string | null {
    const meta = entry.meta;
    if (meta.specimen === 'editor') return meta.scope?.projectId ?? null;
    if (meta.specimen === 'wall' || meta.specimen === 'controller') {
        const scopeId = wallBindings.get(meta.wallId);
        const scope = scopeId !== undefined ? scopedState.get(scopeId) : null;
        return scope?.projectId ?? null;
    }
    if (meta.specimen === 'gallery' && meta.wallId) {
        const scopeId = wallBindings.get(meta.wallId);
        const scope = scopeId !== undefined ? scopedState.get(scopeId) : null;
        return scope?.projectId ?? null;
    }
    return null;
}

export function isAdminUser(entry: PeerEntry): boolean {
    return entry.meta.authContext?.user?.role === 'admin';
}

export function isWallDevice(entry: PeerEntry): boolean {
    return entry.meta.authContext?.device?.kind === 'wall';
}

export function isControllerDevice(entry: PeerEntry): boolean {
    return entry.meta.authContext?.device?.kind === 'controller';
}

export function isControllerPortal(entry: PeerEntry): boolean {
    return Boolean(entry.meta.authContext?.portal?.wallId);
}

export function isGalleryDevice(entry: PeerEntry): boolean {
    return entry.meta.authContext?.device?.kind === 'gallery';
}

export function hasAnyAuthenticatedActor(entry: PeerEntry): boolean {
    return Boolean(
        entry.meta.authContext?.user ||
        entry.meta.authContext?.device ||
        entry.meta.authContext?.portal
    );
}

export function getScopeProjectId(scopeId: number | null): string | null {
    if (scopeId === null) return null;
    return scopedState.get(scopeId)?.projectId ?? null;
}

export function getCachedEditorPermission(
    entry: PeerEntry,
    projectId: string
): { canView: boolean; canEdit: boolean } | null {
    if (entry.meta.specimen !== 'editor') return null;
    const cached = editorProjectPermissions.get(entry.peer.id);
    if (!cached || cached.projectId !== projectId) return null;
    return { canView: cached.canView, canEdit: cached.canEdit };
}

export function isWsMessageAuthorized(
    entry: PeerEntry,
    data: Record<string, any>,
    scopeId: number | null
): boolean {
    const type = data.type;

    if (type === 'leave_scope') {
        return entry.meta.specimen === 'editor';
    }
    if (type === 'bind_override_decision') {
        return entry.meta.specimen === 'gallery' && (isAdminUser(entry) || isGalleryDevice(entry));
    }
    if (type === 'bind_wall') {
        if (entry.meta.specimen === 'controller')
            return isControllerDevice(entry) || isControllerPortal(entry) || isAdminUser(entry);
        if (entry.meta.specimen === 'gallery') return isAdminUser(entry) || isGalleryDevice(entry);
        return isAdminUser(entry);
    }
    if (type === 'unbind_wall' || type === 'reboot') {
        if (type === 'reboot' && entry.meta.specimen === 'controller')
            return isControllerDevice(entry) || isControllerPortal(entry) || isAdminUser(entry);
        if (entry.meta.specimen === 'gallery') return isAdminUser(entry) || isGalleryDevice(entry);
        return isAdminUser(entry);
    }

    const payloadProjectId = typeof data.projectId === 'string' ? data.projectId : null;
    const scopeProjectId = getScopeProjectId(scopeId);
    const projectId = payloadProjectId ?? scopeProjectId;

    if (type === 'pointer') {
        // Presence is editor-only and carries a peer email, so viewers qualify
        // but unscoped or unauthorised peers must not reach the relay.
        if (entry.meta.specimen !== 'editor' || !projectId) return false;
        return Boolean(getCachedEditorPermission(entry, projectId)?.canView);
    }

    if (EDIT_PROJECT_MESSAGE_TYPES.has(type)) {
        if (
            (type === 'upsert_layer' || type === 'delete_layer') &&
            data.origin === 'controller:add_line_layer'
        ) {
            return (
                entry.meta.specimen === 'controller' &&
                (isControllerDevice(entry) || isControllerPortal(entry))
            );
        }

        if (entry.meta.specimen !== 'editor' || !projectId) return false;
        const perms = getCachedEditorPermission(entry, projectId);
        return Boolean(perms?.canEdit);
    }

    if (VIEW_PROJECT_MESSAGE_TYPES.has(type)) {
        if (entry.meta.specimen === 'controller') {
            return isControllerDevice(entry) || isControllerPortal(entry);
        }
        if (entry.meta.specimen === 'wall') {
            return isWallDevice(entry);
        }
        if (entry.meta.specimen !== 'editor' || !projectId) return false;
        const perms = getCachedEditorPermission(entry, projectId);
        return Boolean(perms?.canView);
    }

    return true;
}

export async function enforceWsRateLimit(
    peer: Peer,
    messageType: string,
    opts?: { entry?: PeerEntry; projectId?: string | null }
): Promise<boolean> {
    if (!WS_MUTATION_MESSAGE_TYPES.has(messageType)) return true;

    const subjectKey = getWsRateLimitIdentity(peer);
    const result = checkRateLimit({ subjectKey });

    if (result.allowed) {
        wsRateLimitStrikes.set(peer.id, 0);
        return true;
    }

    const nextStrikes = (wsRateLimitStrikes.get(peer.id) ?? 0) + 1;
    wsRateLimitStrikes.set(peer.id, nextStrikes);

    // TODO See if we target more explicit user/identified devices
    const actorId = peer.id;
    void logAuditDenied({
        action: 'WS_MESSAGE_RATE_LIMITED',
        actorId,
        projectId: opts?.projectId ?? (opts?.entry ? getEntryProjectId(opts.entry) : null),
        resourceType: 'ws_message',
        resourceId: messageType,
        reasonCode: 'RATE_LIMITED',
        changes: { retryAfterMs: result.retryAfterMs, strikes: nextStrikes }
    });

    peer.send(
        JSON.stringify({
            type: 'rate_limited',
            messageType,
            retryAfterMs: result.retryAfterMs
        })
    );

    if (nextStrikes >= WS_RATE_LIMIT_STRIKE_LIMIT) {
        try {
            peer.close();
        } catch {
            // no-op
        }
    }
    return false;
}

export function enforceWsHandshakeRateLimit(peer: Peer, messageType: string): boolean {
    if (!WS_HANDSHAKE_MESSAGE_TYPES.has(messageType)) return true;
    const result = checkRateLimit({ subjectKey: getWsHandshakeRateLimitIdentity(peer) });
    if (result.allowed) return true;
    peer.send(
        JSON.stringify({
            type: 'rate_limited',
            messageType,
            retryAfterMs: result.retryAfterMs
        })
    );
    try {
        peer.close();
    } catch {
        // no-op
    }
    return false;
}
