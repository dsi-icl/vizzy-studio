import '@tanstack/react-start/server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '@repo/env';

import { serveBasePath } from '~/lib/serveUrls';

/**
 * Authorises the hundreds of subresource requests a demo makes after its document loads.
 * Scoped per project by both name and `Path`.
 */
export const SERVE_COOKIE_MAX_AGE_SECONDS = 2 * 60 * 60;

export type ServeSurface = 'wall' | 'control';

interface ServeCookiePayload {
    v: 1;
    projectId: string;
    surface: ServeSurface;
    wallId: string;
    iat: number;
    exp: number;
}

export interface ServeActor {
    surface: ServeSurface;
    wallId: string;
    expiresAt?: number;
}

export function shouldRefreshServeCookie(actor: ServeActor, now = Date.now()): boolean {
    if (actor.expiresAt === undefined) return false;
    const halfLifeMs = (SERVE_COOKIE_MAX_AGE_SECONDS * 1000) / 2;
    return actor.expiresAt - now < halfLifeMs;
}

export function serveCookieName(projectId: string): string {
    return `vizzy_serve_${projectId}`;
}

function getSigningSecret(): string {
    if (env.NODE_ENV === 'production' && !env.SERVER_AUTH_SECRET) {
        throw new Error('SERVER_AUTH_SECRET must be set in production');
    }
    return env.SERVER_AUTH_SECRET || 'degraded-mode-secret';
}

function sign(payload: string): string {
    return createHmac('sha256', getSigningSecret()).update(payload).digest('base64url');
}

function hasValidSignature(payload: string, signature: string): boolean {
    const expectedBytes = Buffer.from(sign(payload));
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

function isServeCookiePayload(value: unknown): value is ServeCookiePayload {
    if (!value || typeof value !== 'object') return false;
    const payload = value as Partial<ServeCookiePayload>;
    return (
        payload.v === 1 &&
        (payload.surface === 'wall' || payload.surface === 'control') &&
        typeof payload.projectId === 'string' &&
        payload.projectId.length > 0 &&
        typeof payload.wallId === 'string' &&
        typeof payload.iat === 'number' &&
        Number.isFinite(payload.iat) &&
        typeof payload.exp === 'number' &&
        Number.isFinite(payload.exp)
    );
}

function shouldSetSecureCookie(request: Request): boolean {
    const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    if (forwardedProto === 'https') return true;
    if (forwardedProto === 'http') return false;
    return new URL(request.url).protocol === 'https:' || env.NODE_ENV === 'production';
}

export function createServeCookie(input: {
    request: Request;
    projectId: string;
    actor: ServeActor;
}): string {
    const now = Date.now();
    const payload: ServeCookiePayload = {
        v: 1,
        projectId: input.projectId,
        surface: input.actor.surface,
        wallId: input.actor.wallId,
        iat: now,
        exp: now + SERVE_COOKIE_MAX_AGE_SECONDS * 1000
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

    return [
        `${serveCookieName(input.projectId)}=${encoded}.${sign(encoded)}`,
        `Max-Age=${SERVE_COOKIE_MAX_AGE_SECONDS}`,
        `Path=${serveBasePath(input.projectId)}`,
        'HttpOnly',
        'SameSite=Lax',
        ...(shouldSetSecureCookie(input.request) ? ['Secure'] : [])
    ].join('; ');
}

export function resolveServeCookieActor(request: Request, projectId: string): ServeActor | null {
    const token = parseCookieHeader(request.headers.get('cookie'))[serveCookieName(projectId)];
    if (!token) return null;

    const [encoded, signature] = token.split('.');
    if (!encoded || !signature || !hasValidSignature(encoded, signature)) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
        return null;
    }

    if (!isServeCookiePayload(parsed)) return null;
    if (parsed.projectId !== projectId) return null;
    if (parsed.exp <= Date.now()) return null;

    return { surface: parsed.surface, wallId: parsed.wallId, expiresAt: parsed.exp };
}
