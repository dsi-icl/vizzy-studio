import '@tanstack/react-start/server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '@repo/env';

import { dbCol } from '~/server/collections';
import type { AuthContext } from '~/server/requestAuthContext';

export const WALL_MEDIA_COOKIE_NAME = 'vizzy_wall_media';
export const WALL_MEDIA_COOKIE_MAX_AGE_SECONDS = 2 * 60 * 60;

type WallMediaCookiePayload = {
    v: 1;
    deviceId: string;
    kind: 'wall';
    wallId: string;
    iat: number;
    exp: number;
};

function getSigningSecret(): string {
    return env.SERVER_AUTH_SECRET || 'degraded-mode-secret';
}

function base64UrlEncode(input: string): string {
    return Buffer.from(input, 'utf8').toString('base64url');
}

function base64UrlDecode(input: string): string | null {
    try {
        return Buffer.from(input, 'base64url').toString('utf8');
    } catch {
        return null;
    }
}

function sign(payload: string): string {
    return createHmac('sha256', getSigningSecret()).update(payload).digest('base64url');
}

function hasValidSignature(payload: string, signature: string): boolean {
    const expected = sign(payload);
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(signature);
    if (expectedBytes.byteLength !== actualBytes.byteLength) return false;
    return timingSafeEqual(expectedBytes, actualBytes);
}

function parseCookieHeader(header: string | null): Record<string, string> {
    if (!header) return {};
    const out: Record<string, string> = {};
    for (const part of header.split(';')) {
        const [rawName, ...rawValue] = part.split('=');
        const name = rawName?.trim();
        if (!name) continue;
        out[name] = rawValue.join('=').trim();
    }
    return out;
}

function isWallMediaCookiePayload(value: unknown): value is WallMediaCookiePayload {
    if (!value || typeof value !== 'object') return false;
    const payload = value as Partial<WallMediaCookiePayload>;
    return (
        payload.v === 1 &&
        payload.kind === 'wall' &&
        typeof payload.deviceId === 'string' &&
        payload.deviceId.length > 0 &&
        typeof payload.wallId === 'string' &&
        payload.wallId.length > 0 &&
        typeof payload.iat === 'number' &&
        Number.isFinite(payload.iat) &&
        typeof payload.exp === 'number' &&
        Number.isFinite(payload.exp)
    );
}

function serializeCookie(input: {
    name: string;
    value: string;
    maxAgeSeconds: number;
    secure: boolean;
}): string {
    return [
        `${input.name}=${input.value}`,
        `Max-Age=${input.maxAgeSeconds}`,
        'Path=/api',
        'HttpOnly',
        'SameSite=Lax',
        ...(input.secure ? ['Secure'] : [])
    ].join('; ');
}

function shouldSetSecureCookie(request: Request): boolean {
    const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    if (forwardedProto === 'https') return true;
    if (forwardedProto === 'http') return false;
    return new URL(request.url).protocol === 'https:' || env.NODE_ENV === 'production';
}

export function createWallMediaCookie(input: {
    request: Request;
    device: NonNullable<AuthContext['device']>;
}): string | null {
    if (input.device.kind !== 'wall') return null;
    const wallId = input.device.wallId;
    if (!wallId) return null;

    const now = Date.now();
    const payload: WallMediaCookiePayload = {
        v: 1,
        deviceId: input.device.id,
        kind: 'wall',
        wallId,
        iat: now,
        exp: now + WALL_MEDIA_COOKIE_MAX_AGE_SECONDS * 1000
    };
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const token = `${encodedPayload}.${sign(encodedPayload)}`;

    return serializeCookie({
        name: WALL_MEDIA_COOKIE_NAME,
        value: token,
        maxAgeSeconds: WALL_MEDIA_COOKIE_MAX_AGE_SECONDS,
        secure: shouldSetSecureCookie(input.request)
    });
}

export async function resolveWallMediaCookieAuthContext(
    request: Request
): Promise<AuthContext['device'] | null> {
    const token = parseCookieHeader(request.headers.get('cookie'))[WALL_MEDIA_COOKIE_NAME];
    if (!token) return null;

    const [encodedPayload, signature] = token.split('.');
    if (!encodedPayload || !signature || !hasValidSignature(encodedPayload, signature)) {
        return null;
    }

    const decoded = base64UrlDecode(encodedPayload);
    if (!decoded) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(decoded);
    } catch {
        return null;
    }
    if (!isWallMediaCookiePayload(parsed)) return null;
    if (parsed.exp <= Date.now()) return null;

    const deviceRecord = await dbCol.devices.findById(parsed.deviceId).catch(() => null);
    if (
        !deviceRecord ||
        deviceRecord.kind !== 'wall' ||
        deviceRecord.status !== 'active' ||
        deviceRecord.assignedWallId !== parsed.wallId
    ) {
        return null;
    }

    return {
        id: deviceRecord.id,
        kind: 'wall',
        wallId: parsed.wallId
    };
}
