import '@tanstack/react-start/server-only';

interface UploadToken {
    projectId: string;
    userEmail: string;
    createdAt: number;
    expiresAt: number;
}

const TOKEN_TTL = 15 * 60 * 1000; // 15 minutes

// HMR-safe token store
const _hmr = (process as any).__UPLOAD_TOKENS_HMR__ ?? { tokens: new Map<string, UploadToken>() };
(process as any).__UPLOAD_TOKENS_HMR__ = _hmr;

const tokens: Map<string, UploadToken> = _hmr.tokens;

/** Prune expired tokens that were never validated or redeemed. */
export function pruneExpiredUploadTokens() {
    const now = Date.now();
    for (const [key, entry] of tokens.entries()) {
        if (now > entry.expiresAt) {
            tokens.delete(key);
        }
    }
}

/** Create a short-lived upload token for a project. Returns the secure token string. */
export function createUploadToken(
    projectId: string,
    userEmail: string
): {
    token: string;
    expiresAt: number;
} {
    pruneExpiredUploadTokens();
    const token = crypto.randomUUID().replace(/-/g, '');
    const expiresAt = Date.now() + TOKEN_TTL;
    tokens.set(token, { projectId, userEmail, createdAt: Date.now(), expiresAt });
    return { token, expiresAt };
}

/** Validate a token. Returns the token data if valid, null if expired or unknown. */
export function validateUploadToken(
    token: string
): { projectId: string; userEmail: string } | null {
    const entry = tokens.get(token);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        tokens.delete(token);
        return null;
    }
    return { projectId: entry.projectId, userEmail: entry.userEmail };
}

/** Revoke a specific token (e.g. when dialog closes or editor disconnects). */
export function revokeUploadToken(token: string) {
    tokens.delete(token);
}
