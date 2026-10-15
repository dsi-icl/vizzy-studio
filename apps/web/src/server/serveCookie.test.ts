import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    createServeCookie,
    resolveServeCookieActor,
    serveCookieName,
    shouldRefreshServeCookie,
    SERVE_COOKIE_MAX_AGE_SECONDS
} from './serveCookie';

const PID = '507f1f77bcf86cd799439011';
const OTHER_PID = '507f1f77bcf86cd799439012';

function request(cookie?: string): Request {
    return new Request('http://localhost:3000/serve/x/screen', {
        headers: cookie ? { cookie } : undefined
    });
}

/** Strips the attributes so the value can be replayed as a request cookie. */
function asRequestCookie(setCookie: string): string {
    return setCookie.split(';')[0] ?? '';
}

describe('serve cookie', () => {
    test('round-trips the actor it was minted for', () => {
        const setCookie = createServeCookie({
            request: request(),
            projectId: PID,
            actor: { surface: 'wall', wallId: 'wall-a' }
        });

        const resolved = resolveServeCookieActor(request(asRequestCookie(setCookie)), PID);
        assert.equal(resolved?.surface, 'wall');
        assert.equal(resolved?.wallId, 'wall-a');
    });

    test('is scoped to its own project by name and path', () => {
        const setCookie = createServeCookie({
            request: request(),
            projectId: PID,
            actor: { surface: 'control', wallId: 'wall-a' }
        });

        assert.ok(setCookie.startsWith(`${serveCookieName(PID)}=`));
        assert.ok(setCookie.includes(`Path=/serve/${PID}`));
        assert.ok(setCookie.includes('HttpOnly'));
        assert.ok(setCookie.includes('SameSite=Lax'));
    });

    test('will not vouch for a different project', () => {
        const setCookie = createServeCookie({
            request: request(),
            projectId: PID,
            actor: { surface: 'wall', wallId: 'wall-a' }
        });
        // Replay project A's payload under project B's cookie name.
        const forged = `${serveCookieName(OTHER_PID)}=${asRequestCookie(setCookie).split('=').slice(1).join('=')}`;

        assert.equal(resolveServeCookieActor(request(forged), OTHER_PID), null);
    });

    test('rejects a tampered payload', () => {
        const setCookie = createServeCookie({
            request: request(),
            projectId: PID,
            actor: { surface: 'wall', wallId: 'wall-a' }
        });
        const [name, value] = asRequestCookie(setCookie).split('=');
        const [payload, signature] = (value ?? '').split('.');
        const swapped = Buffer.from(
            JSON.stringify({
                v: 1,
                projectId: PID,
                surface: 'control',
                wallId: 'wall-a',
                iat: Date.now(),
                exp: Date.now() + 60_000
            }),
            'utf8'
        ).toString('base64url');

        assert.notEqual(payload, swapped);
        assert.equal(
            resolveServeCookieActor(request(`${name}=${swapped}.${signature}`), PID),
            null
        );
    });

    test('re-issues once a cookie is past its half-life', () => {
        const ttlMs = SERVE_COOKIE_MAX_AGE_SECONDS * 1000;
        const now = Date.now();
        const actor = { surface: 'wall' as const, wallId: 'wall-a' };

        // A cookie just minted has most of its life left.
        assert.equal(shouldRefreshServeCookie({ ...actor, expiresAt: now + ttlMs }, now), false);
        // Exactly at the half-life, still fine.
        assert.equal(
            shouldRefreshServeCookie({ ...actor, expiresAt: now + ttlMs / 2 }, now),
            false
        );
        // Past it, re-issue.
        assert.equal(
            shouldRefreshServeCookie({ ...actor, expiresAt: now + ttlMs / 2 - 1 }, now),
            true
        );
        // A fresh authorisation has no cookie to refresh.
        assert.equal(shouldRefreshServeCookie(actor, now), false);
    });

    test('reports the expiry so the proxy can re-issue', () => {
        const before = Date.now();
        const setCookie = createServeCookie({
            request: request(),
            projectId: PID,
            actor: { surface: 'wall', wallId: 'wall-a' }
        });
        const resolved = resolveServeCookieActor(request(asRequestCookie(setCookie)), PID);

        assert.ok(resolved?.expiresAt);
        assert.ok(resolved.expiresAt >= before + SERVE_COOKIE_MAX_AGE_SECONDS * 1000);
    });

    test('rejects an absent or malformed cookie', () => {
        assert.equal(resolveServeCookieActor(request(), PID), null);
        assert.equal(
            resolveServeCookieActor(request(`${serveCookieName(PID)}=nonsense`), PID),
            null
        );
        assert.equal(resolveServeCookieActor(request(`${serveCookieName(PID)}=a.b`), PID), null);
    });
});
