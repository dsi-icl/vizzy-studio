import '@tanstack/react-start/server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '@repo/env';

import { serveSessionBasePath } from '~/lib/serveUrls';

export const SERVE_COOKIE_MAX_AGE_SECONDS = 2 * 60 * 60;

export type ServeSurface = 'wall' | 'control' | 'preview-screen' | 'preview-control';

interface ServeCookiePayload {
    v: 1;
    projectId: string;
    routeId: string;
    surface: ServeSurface;
    wallId?: string;
    scopeId?: number;
    bindingId?: string;
    iat: number;
    exp: number;
}

export type ServeActor =
    | {
          surface: 'wall' | 'control';
          wallId: string;
          scopeId: number;
          bindingId: string;
          expiresAt?: number;
      }
    | { surface: 'preview-screen' | 'preview-control'; expiresAt?: number };

export function shouldRefreshServeCookie(actor: ServeActor, now = Date.now()): boolean {
    if (actor.surface.startsWith('preview-')) return false;
    if (actor.expiresAt === undefined) return false;
    const halfLifeMs = (SERVE_COOKIE_MAX_AGE_SECONDS * 1000) / 2;
    return actor.expiresAt - now < halfLifeMs;
}

export function serveCookieName(routeId: string): string {
    return `vizzy_serve_${routeId}`;
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
        (payload.surface === 'wall' ||
            payload.surface === 'control' ||
            payload.surface === 'preview-screen' ||
            payload.surface === 'preview-control') &&
        typeof payload.projectId === 'string' &&
        payload.projectId.length > 0 &&
        typeof payload.routeId === 'string' &&
        /^[A-Za-z\d_-]{22}$/.test(payload.routeId) &&
        (payload.surface.startsWith('preview-') ||
            (typeof payload.wallId === 'string' &&
                typeof payload.scopeId === 'number' &&
                Number.isFinite(payload.scopeId) &&
                typeof payload.bindingId === 'string' &&
                /^[A-Za-z\d_-]{22}$/.test(payload.bindingId))) &&
        typeof payload.iat === 'number' &&
        Number.isFinite(payload.iat) &&
        typeof payload.exp === 'number' &&
        Number.isFinite(payload.exp)
    );
}

function shouldSetSecureCookie(request: Request): boolean {
    return (
        env.NODE_ENV === 'production' ||
        env.SERVER_SERVE_ORIGIN.startsWith('https://') ||
        new URL(request.url).protocol === 'https:'
    );
}

export function createServeCookie(input: {
    request: Request;
    projectId: string;
    routeId: string;
    actor: ServeActor;
}): string {
    const now = Date.now();
    const maxAge = input.actor.surface.startsWith('preview-')
        ? 15 * 60
        : SERVE_COOKIE_MAX_AGE_SECONDS;
    const payload: ServeCookiePayload = {
        v: 1,
        projectId: input.projectId,
        routeId: input.routeId,
        surface: input.actor.surface,
        ...('wallId' in input.actor
            ? {
                  wallId: input.actor.wallId,
                  scopeId: input.actor.scopeId,
                  bindingId: input.actor.bindingId
              }
            : {}),
        iat: now,
        exp: now + maxAge * 1000
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

    return [
        `${serveCookieName(input.routeId)}=${encoded}.${sign(encoded)}`,
        `Max-Age=${maxAge}`,
        `Path=${serveSessionBasePath(input.projectId, input.routeId)}/`,
        'HttpOnly',
        'SameSite=Lax',
        ...(shouldSetSecureCookie(input.request) ? ['Secure'] : [])
    ].join('; ');
}

export function resolveServeCookieActor(
    request: Request,
    projectId: string,
    routeId: string
): ServeActor | null {
    const token = parseCookieHeader(request.headers.get('cookie'))[serveCookieName(routeId)];
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
    if (parsed.routeId !== routeId) return null;
    if (parsed.exp <= Date.now()) return null;

    if (parsed.surface === 'wall' || parsed.surface === 'control') {
        return {
            surface: parsed.surface,
            wallId: parsed.wallId!,
            scopeId: parsed.scopeId!,
            bindingId: parsed.bindingId!,
            expiresAt: parsed.exp
        };
    }
    return { surface: parsed.surface, expiresAt: parsed.exp };
}
