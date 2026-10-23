import '@tanstack/react-start/server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '@repo/env';

import {
    parseServePath,
    serveBasePath,
    SERVE_SESSION_ID_PATTERN,
    SERVE_SESSION_QUERY_PARAM
} from '~/lib/serveUrls';

export const SERVE_COOKIE_MAX_AGE_SECONDS = 2 * 60 * 60;
const PREVIEW_MAX_AGE_SECONDS = 15 * 60;
const MAX_GRANTS = 12;

export type ServeSurface = 'wall' | 'control' | 'preview';
export type ServeActor =
    | {
          surface: 'wall' | 'control';
          wallId: string;
          scopeId: number;
          bindingId: string;
          expiresAt?: number;
      }
    | { surface: 'preview'; expiresAt?: number };

interface StoredGrant {
    surface: ServeSurface;
    wallId?: string;
    scopeId?: number;
    bindingId?: string;
    iat: number;
    exp: number;
}

interface ServeCookiePayload {
    v: 2;
    projectId: string;
    iat: number;
    grants: Record<string, StoredGrant>;
}

interface ServeRouteCookiePayload {
    v: 3;
    projectId: string;
    routeId: string;
    grant: StoredGrant;
}

export interface ResolvedServeGrant {
    routeId: string;
    actor: ServeActor;
}

export function shouldRefreshServeCookie(actor: ServeActor, now = Date.now()): boolean {
    if (actor.surface === 'preview' || actor.expiresAt === undefined) return false;
    const halfLifeMs = (SERVE_COOKIE_MAX_AGE_SECONDS * 1000) / 2;
    return actor.expiresAt - now < halfLifeMs;
}

export function serveCookieName(projectId: string, routeId: string): string {
    if (!/^[a-f\d]{24}$/i.test(projectId)) throw new Error('Invalid project ID');
    if (!SERVE_SESSION_ID_PATTERN.test(routeId)) throw new Error('Invalid session ID');
    return `vizzy_serve_${projectId}_${routeId}`;
}

function legacyServeCookieName(projectId: string): string {
    if (!/^[a-f\d]{24}$/i.test(projectId)) throw new Error('Invalid project ID');
    return `vizzy_serve_${projectId}`;
}

function getSigningSecret(): string {
    if (env.NODE_ENV === 'production' && !env.SERVER_AUTH_SECRET) {
        throw new Error('SERVER_AUTH_SECRET must be set in production');
    }
    return env.SERVER_AUTH_SECRET || 'degraded-mode-secret';
}

function sign(encoded: string, version: 2 | 3): string {
    return createHmac('sha256', getSigningSecret())
        .update(`serve-cookie-v${version}:`)
        .update(encoded)
        .digest('base64url');
}

function hasValidSignature(encoded: string, signature: string, version: 2 | 3): boolean {
    const expected = Buffer.from(sign(encoded, version));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isStoredGrant(value: unknown): value is StoredGrant {
    if (!value || typeof value !== 'object') return false;
    const grant = value as Partial<StoredGrant>;
    return (
        (grant.surface === 'wall' || grant.surface === 'control' || grant.surface === 'preview') &&
        (grant.surface === 'preview' ||
            (typeof grant.wallId === 'string' &&
                grant.wallId.length > 0 &&
                typeof grant.scopeId === 'number' &&
                Number.isFinite(grant.scopeId) &&
                typeof grant.bindingId === 'string' &&
                SERVE_SESSION_ID_PATTERN.test(grant.bindingId))) &&
        typeof grant.iat === 'number' &&
        Number.isFinite(grant.iat) &&
        typeof grant.exp === 'number' &&
        Number.isFinite(grant.exp)
    );
}

function decodeLegacyCookie(token: string, projectId: string): ServeCookiePayload | null {
    const [encoded, signature, extra] = token.split('.');
    if (!encoded || !signature || extra || !hasValidSignature(encoded, signature, 2)) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const payload = parsed as Partial<ServeCookiePayload>;
    if (
        payload.v !== 2 ||
        payload.projectId !== projectId ||
        typeof payload.iat !== 'number' ||
        !Number.isFinite(payload.iat) ||
        !payload.grants ||
        typeof payload.grants !== 'object' ||
        Array.isArray(payload.grants)
    ) {
        return null;
    }
    const entries = Object.entries(payload.grants);
    if (
        entries.length > MAX_GRANTS ||
        entries.some(([id, grant]) => !SERVE_SESSION_ID_PATTERN.test(id) || !isStoredGrant(grant))
    ) {
        return null;
    }
    return payload as ServeCookiePayload;
}

function decodeRouteCookie(
    token: string,
    projectId: string,
    routeId: string
): ServeRouteCookiePayload | null {
    const [encoded, signature, extra] = token.split('.');
    if (!encoded || !signature || extra || !hasValidSignature(encoded, signature, 3)) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const payload = parsed as Partial<ServeRouteCookiePayload>;
    if (
        payload.v !== 3 ||
        payload.projectId !== projectId ||
        payload.routeId !== routeId ||
        !isStoredGrant(payload.grant)
    ) {
        return null;
    }
    return payload as ServeRouteCookiePayload;
}

function liveGrants(
    request: Request,
    projectId: string,
    now = Date.now()
): Record<string, StoredGrant> {
    const header = request.headers.get('cookie');
    if (!header) return {};
    const legacyName = legacyServeCookieName(projectId);
    const routePrefix = `${legacyName}_`;
    let newestLegacy: ServeCookiePayload | null = null;
    const routeGrants = new Map<string, StoredGrant>();
    for (const part of header.split(';')) {
        const boundary = part.indexOf('=');
        if (boundary < 0) continue;
        const name = part.slice(0, boundary).trim();
        const token = part.slice(boundary + 1).trim();
        if (name === legacyName) {
            const decoded = decodeLegacyCookie(token, projectId);
            if (decoded && (!newestLegacy || decoded.iat >= newestLegacy.iat)) {
                newestLegacy = decoded;
            }
            continue;
        }
        if (!name.startsWith(routePrefix)) continue;
        const routeId = name.slice(routePrefix.length);
        if (!SERVE_SESSION_ID_PATTERN.test(routeId)) continue;
        const decoded = decodeRouteCookie(token, projectId, routeId);
        if (!decoded || decoded.grant.exp <= now) continue;
        const previous = routeGrants.get(routeId);
        if (!previous || decoded.grant.iat >= previous.iat) {
            routeGrants.set(routeId, decoded.grant);
        }
    }
    const grants = Object.fromEntries(
        Object.entries(newestLegacy?.grants ?? {}).filter(([, grant]) => grant.exp > now)
    );
    // New independent cookies take precedence over an older merged cookie for
    // the same route while existing sessions continue to work during rollout.
    for (const [routeId, grant] of routeGrants) grants[routeId] = grant;
    return grants;
}

function actorFromGrant(grant: StoredGrant): ServeActor {
    if (grant.surface === 'preview') return { surface: 'preview', expiresAt: grant.exp };
    return {
        surface: grant.surface,
        wallId: grant.wallId!,
        scopeId: grant.scopeId!,
        bindingId: grant.bindingId!,
        expiresAt: grant.exp
    };
}

/** Each route has its own cookie so concurrent iframe launches cannot overwrite one another. */
export function createServeCookie(input: {
    request: Request;
    projectId: string;
    routeId: string;
    actor: ServeActor;
}): string {
    if (!SERVE_SESSION_ID_PATTERN.test(input.routeId)) throw new Error('Invalid session ID');
    const now = Date.now();
    const maxAge =
        input.actor.surface === 'preview' ? PREVIEW_MAX_AGE_SECONDS : SERVE_COOKIE_MAX_AGE_SECONDS;
    const grant: StoredGrant = {
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
    const payload: ServeRouteCookiePayload = {
        v: 3,
        projectId: input.projectId,
        routeId: input.routeId,
        grant
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return [
        `${serveCookieName(input.projectId, input.routeId)}=${encoded}.${sign(encoded, 3)}`,
        `Max-Age=${maxAge}`,
        `Path=${serveBasePath(input.projectId)}`,
        'HttpOnly',
        // Sandboxed demo documents have an opaque origin. Their subrequests are
        // cross-site, so Lax would silently omit this path-scoped grant.
        'SameSite=None',
        'Secure'
    ].join('; ');
}

function routeHint(request: Request, projectId: string): string | null {
    const url = new URL(request.url);
    if (url.searchParams.has(SERVE_SESSION_QUERY_PARAM)) {
        return url.searchParams.get(SERVE_SESSION_QUERY_PARAM) ?? '';
    }
    const referrer = request.headers.get('referer');
    if (!referrer) return null;
    try {
        const source = new URL(referrer);
        const base = serveBasePath(projectId);
        if (
            source.origin === url.origin &&
            (source.pathname === base || source.pathname.startsWith(`${base}/`)) &&
            source.searchParams.has(SERVE_SESSION_QUERY_PARAM)
        ) {
            return source.searchParams.get(SERVE_SESSION_QUERY_PARAM) ?? '';
        }
    } catch {
        // An invalid Referer cannot identify a grant.
    }
    return null;
}

/** Use the document's session hint for dynamic requests; static assets are shared by every grant. */
export function resolveServeCookieGrant(
    request: Request,
    projectId: string,
    isAllowed: (actor: ServeActor) => boolean = () => true
): ResolvedServeGrant | null {
    const grants = liveGrants(request, projectId);
    const hint = routeHint(request, projectId);
    if (hint !== null) {
        const grant = grants[hint];
        if (!grant) return null;
        const actor = actorFromGrant(grant);
        return isAllowed(actor) ? { routeId: hint, actor } : null;
    }

    const parsed = parseServePath(new URL(request.url).pathname);
    const candidates = Object.entries(grants).filter(([, grant]) => {
        if (!isAllowed(actorFromGrant(grant))) return false;
        if (parsed?.rest === '/screen' || parsed?.rest.startsWith('/screen/')) {
            return grant.surface === 'wall' || grant.surface === 'preview';
        }
        if (parsed?.rest === '/control' || parsed?.rest.startsWith('/control/')) {
            return grant.surface === 'control' || grant.surface === 'preview';
        }
        return true;
    });
    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
        const staticAsset =
            parsed?.rest.startsWith('/assets/') ||
            parsed?.rest.startsWith('/_next/static/') ||
            /\.(?:css|js|mjs|map|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|m4a|mp3|ogg|wav|mp4|webm)$/i.test(
                parsed?.rest ?? ''
            );
        if (!staticAsset || !['GET', 'HEAD'].includes(request.method)) return null;
        candidates.reverse().sort(([, a], [, b]) => b.iat - a.iat);
    }
    const [routeId, grant] = candidates[0]!;
    return { routeId, actor: actorFromGrant(grant) };
}
