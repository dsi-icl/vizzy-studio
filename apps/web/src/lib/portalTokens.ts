import '@tanstack/react-start/server-only';
import { randomBytes } from 'node:crypto';

interface PortalTokenEntry {
    wallId: string;
    scopeId: number;
    createdAt: number;
    expiresAt: number;
}

const PORTAL_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

const _hmr = (process as any).__PORTAL_TOKENS_HMR__ ?? {
    tokens: new Map<string, PortalTokenEntry>(),
    tokensByWallId: new Map<string, Set<string>>(),
    tokensByScopeId: new Map<number, Set<string>>()
};
(process as any).__PORTAL_TOKENS_HMR__ = _hmr;

const tokens: Map<string, PortalTokenEntry> = _hmr.tokens;
const tokensByWallId: Map<string, Set<string>> = _hmr.tokensByWallId;
const tokensByScopeId: Map<number, Set<string>> = _hmr.tokensByScopeId;

function addTokenToIndex<K extends string | number>(
    index: Map<K, Set<string>>,
    key: K,
    token: string
) {
    let set = index.get(key);
    if (!set) {
        set = new Set<string>();
        index.set(key, set);
    }
    set.add(token);
}

function removeTokenFromIndex<K extends string | number>(
    index: Map<K, Set<string>>,
    key: K,
    token: string
) {
    const set = index.get(key);
    if (!set) return;
    set.delete(token);
    if (set.size === 0) index.delete(key);
}

function revokeTokenInternal(token: string) {
    const entry = tokens.get(token);
    if (!entry) return false;

    tokens.delete(token);
    removeTokenFromIndex(tokensByWallId, entry.wallId, token);
    removeTokenFromIndex(tokensByScopeId, entry.scopeId, token);
    return true;
}

function createRawPortalToken() {
    return `viz_ctrl_${randomBytes(24).toString('hex')}`;
}

export function createPortalToken(
    wallId: string,
    scopeId: number
): {
    token: string;
    expiresAt: number;
} {
    const now = Date.now();
    const token = createRawPortalToken();
    const expiresAt = now + PORTAL_TOKEN_TTL_MS;
    tokens.set(token, {
        wallId,
        scopeId,
        createdAt: now,
        expiresAt
    });
    addTokenToIndex(tokensByWallId, wallId, token);
    addTokenToIndex(tokensByScopeId, scopeId, token);
    return { token, expiresAt };
}

export function validatePortalToken(token: string): (PortalTokenEntry & { token: string }) | null {
    const entry = tokens.get(token);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        revokeTokenInternal(token);
        return null;
    }
    return { token, ...entry };
}

export function revokePortalToken(token: string) {
    revokeTokenInternal(token);
}

export function revokePortalTokensForWall(wallId: string) {
    const scoped = tokensByWallId.get(wallId);
    if (!scoped || scoped.size === 0) return;
    for (const token of Array.from(scoped)) {
        revokeTokenInternal(token);
    }
}

export function revokePortalTokensForScope(scopeId: number) {
    const scoped = tokensByScopeId.get(scopeId);
    if (!scoped || scoped.size === 0) return;
    for (const token of Array.from(scoped)) {
        revokeTokenInternal(token);
    }
}

export function pruneExpiredPortalTokens() {
    const now = Date.now();
    for (const [token, entry] of tokens) {
        if (entry.expiresAt <= now) {
            revokeTokenInternal(token);
        }
    }
}
