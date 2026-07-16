import { auth } from '@repo/auth/auth';
import type { AuthContext } from '@repo/db/documents';

import { validatePortalToken } from '~/lib/portalTokens';
import {
    DEVICE_BODY_HASH_PATTERN,
    DEVICE_HEADER_BODY_HASH,
    DEVICE_HEADER_KIND,
    DEVICE_HEADER_NONCE,
    DEVICE_HEADER_PUBLIC_KEY,
    DEVICE_HEADER_SIGNATURE,
    DEVICE_HEADER_TIMESTAMP,
    DEVICE_HEADER_WALL_ID,
    buildCanonicalDeviceSignaturePayload
} from '~/lib/requestSignatureContract';
import { dbCol } from '~/server/collections';

export type { AuthContext } from '@repo/db/documents';

const DEVICE_CLOCK_SKEW_MS = 60_000;
const NONCE_TTL_MS = 5 * 60_000;
const NONCE_MIN_LENGTH = 12;
const NONCE_MAX_LENGTH = 128;
const NONCE_PATTERN = /^[A-Za-z0-9_-]+$/;

const _hmr = ((globalThis as any).__HTTP_DEVICE_NONCES__ as
    | { byPublicKey: Map<string, Map<string, number>> }
    | undefined) ?? {
    byPublicKey: new Map<string, Map<string, number>>()
};
(globalThis as any).__HTTP_DEVICE_NONCES__ = _hmr;

function readBearerToken(request: Request): string | null {
    const auth = request.headers.get('authorization');
    if (auth && auth.toLowerCase().startsWith('bearer ')) {
        const token = auth.slice(7).trim();
        return token.length > 0 ? token : null;
    }
    const url = new URL(request.url);
    const queryToken =
        url.searchParams.get('_viz_t')?.trim() ?? url.searchParams.get('_viz_t')?.trim();
    return queryToken && queryToken.length > 0 ? queryToken : null;
}

function toBase64(input: string): string {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    return normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
}

function base64ToBytes(input: string): Uint8Array {
    const raw = Buffer.from(toBase64(input), 'base64');
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

function toArrayBufferView(input: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(input.byteLength);
    out.set(input);
    return out;
}

function normalizeDeviceKind(
    raw: string | null
): NonNullable<AuthContext['device']>['kind'] | null {
    if (raw === 'wall' || raw === 'controller' || raw === 'gallery') return raw;
    return null;
}

function cleanupExpiredNonces(now: number) {
    for (const [key, nonces] of _hmr.byPublicKey) {
        for (const [nonce, seenAt] of nonces) {
            if (now - seenAt > NONCE_TTL_MS) {
                nonces.delete(nonce);
            }
        }
        if (nonces.size === 0) {
            _hmr.byPublicKey.delete(key);
        }
    }
}

function registerNonce(publicKey: string, nonce: string, now: number): boolean {
    cleanupExpiredNonces(now);

    let nonces = _hmr.byPublicKey.get(publicKey);
    if (!nonces) {
        nonces = new Map<string, number>();
        _hmr.byPublicKey.set(publicKey, nonces);
    }

    if (nonces.has(nonce)) return false;
    nonces.set(nonce, now);
    return true;
}

async function verifyDeviceSignature(input: {
    request: Request;
    kind: NonNullable<AuthContext['device']>['kind'];
    publicKey: string;
    signature: string;
    timestamp: number;
    nonce: string;
    bodySha256: string | null;
    wallId?: string;
}): Promise<AuthContext['device'] | null> {
    const now = Date.now();
    if (Math.abs(now - input.timestamp) > DEVICE_CLOCK_SKEW_MS) {
        return null;
    }

    if (
        input.nonce.length < NONCE_MIN_LENGTH ||
        input.nonce.length > NONCE_MAX_LENGTH ||
        !NONCE_PATTERN.test(input.nonce)
    ) {
        return null;
    }

    const registered = registerNonce(input.publicKey, input.nonce, now);
    if (!registered) return null;

    let jwk: JsonWebKey;
    try {
        jwk = JSON.parse(input.publicKey) as JsonWebKey;
    } catch {
        return null;
    }

    const algo: EcKeyImportParams & EcdsaParams = {
        name: 'ECDSA',
        namedCurve: 'P-256',
        hash: 'SHA-256'
    };

    const requestUrl = new URL(input.request.url);
    const payload = buildCanonicalDeviceSignaturePayload(
        requestUrl,
        input.request.method,
        input.timestamp,
        input.nonce,
        input.bodySha256
    );
    const payloadBytes = new TextEncoder().encode(payload);
    const signatureBytes = toArrayBufferView(base64ToBytes(input.signature));

    try {
        const key = await crypto.subtle.importKey('jwk', jwk, algo, false, ['verify']);
        const verified = await crypto.subtle.verify(algo, key, signatureBytes, payloadBytes);
        if (!verified) return null;
    } catch {
        return null;
    }

    const deviceRecord = await dbCol.devices.findOne({
        publicKey: input.publicKey,
        kind: input.kind,
        status: 'active'
    });
    if (!deviceRecord) return null;

    const assignedWallId =
        typeof deviceRecord.assignedWallId === 'string' ? deviceRecord.assignedWallId : undefined;
    if (input.wallId && assignedWallId && input.wallId !== assignedWallId) {
        return null;
    }

    return {
        id: deviceRecord.id,
        kind: input.kind,
        ...(assignedWallId
            ? { wallId: assignedWallId }
            : input.wallId
              ? { wallId: input.wallId }
              : {})
    };
}

async function resolveDeviceContextFromRequest(request: Request) {
    const kind = normalizeDeviceKind(request.headers.get(DEVICE_HEADER_KIND));
    const publicKey = request.headers.get(DEVICE_HEADER_PUBLIC_KEY)?.trim();
    const signature = request.headers.get(DEVICE_HEADER_SIGNATURE)?.trim();
    const timestampRaw = request.headers.get(DEVICE_HEADER_TIMESTAMP)?.trim();
    const nonce = request.headers.get(DEVICE_HEADER_NONCE)?.trim();
    const wallId = request.headers.get(DEVICE_HEADER_WALL_ID)?.trim();
    const bodySha256Raw = request.headers.get(DEVICE_HEADER_BODY_HASH)?.trim() ?? '';

    const authContext: AuthContext = {};
    if (!kind || !publicKey || !signature || !timestampRaw || !nonce) return { authContext };

    const timestamp = Number(timestampRaw);
    if (!Number.isFinite(timestamp) || !Number.isInteger(timestamp)) return { authContext };

    const bodySha256 =
        bodySha256Raw.length === 0
            ? null
            : DEVICE_BODY_HASH_PATTERN.test(bodySha256Raw)
              ? bodySha256Raw
              : null;
    if (bodySha256Raw.length > 0 && !bodySha256) return { authContext };

    authContext.device =
        (await verifyDeviceSignature({
            request,
            kind,
            publicKey,
            signature,
            timestamp,
            nonce,
            bodySha256,
            wallId: wallId && wallId.length > 0 ? wallId : undefined
        })) ?? undefined;

    return {
        authContext
    };
}

export async function resolveAuthContextFromRequest(request: Request) {
    const raw = await auth.api.getSession({
        headers: request.headers
    });
    const session =
        raw && typeof raw === 'object' && 'response' in (raw as Record<string, unknown>)
            ? ((raw as { response?: unknown }).response ?? null)
            : raw;
    const user =
        session && typeof session === 'object'
            ? ((session as { user?: unknown }).user ?? null)
            : null;
    const authSession =
        session && typeof session === 'object'
            ? ((session as { session?: unknown }).session ?? null)
            : null;
    const impersonatedBy =
        authSession && typeof authSession === 'object'
            ? ((authSession as { impersonatedBy?: unknown }).impersonatedBy ?? null)
            : null;
    return {
        authContext: {
            user: user
                ? {
                      email: (user as { email: string }).email,
                      role:
                          (user as { role?: unknown }).role === 'admin'
                              ? ('admin' as const)
                              : (user as { role?: unknown }).role === 'operator'
                                ? ('operator' as const)
                                : ('user' as const),
                      trustedPublisher: Boolean(
                          (user as { trustedPublisher?: unknown }).trustedPublisher
                      ),
                      ...(typeof impersonatedBy === 'string' && impersonatedBy.length > 0
                          ? { impersonatedBy }
                          : {})
                  }
                : undefined
        }
    };
}

export async function resolveRequestAuthContext(request: Request) {
    const [{ authContext: sessionAuthContext }, { authContext: deviceAuthContext }] =
        await Promise.all([
            resolveAuthContextFromRequest(request),
            resolveDeviceContextFromRequest(request)
        ]);

    const authContext: AuthContext = {
        user: sessionAuthContext.user,
        device: deviceAuthContext.device
    };

    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/api/portal/')) {
        const token = readBearerToken(request);
        if (token) {
            const validated = validatePortalToken(token);
            if (validated) {
                authContext.portal = { wallId: validated.wallId };
            }
        }
    }

    if (!authContext.user && !authContext.device && !authContext.portal) {
        authContext.guest = true;
    }

    return { authContext };
}

export function hasAuthenticatedActor(authContext: AuthContext): boolean {
    return Boolean(authContext.user || authContext.device || authContext.portal);
}
