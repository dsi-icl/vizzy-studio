import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    createServeCookie,
    resolveServeCookieActor,
    serveCookieName,
    shouldRefreshServeCookie,
    SERVE_COOKIE_MAX_AGE_SECONDS
} from './serveCookie';

const PROJECT = '507f1f77bcf86cd799439011';
const OTHER_PROJECT = '507f1f77bcf86cd799439012';
const ROUTE_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const ROUTE_B = 'BBBBBBBBBBBBBBBBBBBBBB';
const actor = {
    surface: 'wall' as const,
    wallId: 'wall-a',
    scopeId: 7,
    bindingId: 'AAAAAAAAAAAAAAAAAAAAAA'
};
const request = (cookie?: string) =>
    new Request('https://demos.example/serve/x/screen', {
        headers: cookie ? { cookie } : undefined
    });
const value = (setCookie: string) => setCookie.split(';')[0]!;

describe('serve cookie', () => {
    test('round-trips a signed wall actor through its own route', () => {
        const setCookie = createServeCookie({
            request: request(),
            projectId: PROJECT,
            routeId: ROUTE_A,
            actor
        });
        assert.equal(
            resolveServeCookieActor(request(value(setCookie)), PROJECT, ROUTE_A)?.surface,
            'wall'
        );
        const resolved = resolveServeCookieActor(request(value(setCookie)), PROJECT, ROUTE_A);
        assert.equal(resolved && 'wallId' in resolved ? resolved.wallId : null, 'wall-a');
        assert.match(setCookie, new RegExp('Path=/serve/' + PROJECT + '/s/' + ROUTE_A + '/;'));
        assert.ok(setCookie.includes('HttpOnly'));
        assert.ok(setCookie.includes('Secure'));
    });

    test('independent sessions in one browser do not collide', () => {
        const a = value(
            createServeCookie({ request: request(), projectId: PROJECT, routeId: ROUTE_A, actor })
        );
        const b = value(
            createServeCookie({
                request: request(),
                projectId: PROJECT,
                routeId: ROUTE_B,
                actor: {
                    surface: 'control',
                    wallId: 'wall-b',
                    scopeId: 8,
                    bindingId: 'BBBBBBBBBBBBBBBBBBBBBB'
                }
            })
        );
        const both = request(a + '; ' + b);
        assert.notEqual(serveCookieName(ROUTE_A), serveCookieName(ROUTE_B));
        const resolvedA = resolveServeCookieActor(both, PROJECT, ROUTE_A);
        const resolvedB = resolveServeCookieActor(both, PROJECT, ROUTE_B);
        assert.equal(resolvedA && 'wallId' in resolvedA ? resolvedA.wallId : null, 'wall-a');
        assert.equal(resolvedB && 'wallId' in resolvedB ? resolvedB.wallId : null, 'wall-b');
        assert.equal(resolveServeCookieActor(both, OTHER_PROJECT, ROUTE_A), null);
    });

    test('rejects a cookie replayed under another route and a tampered payload', () => {
        const cookie = value(
            createServeCookie({ request: request(), projectId: PROJECT, routeId: ROUTE_A, actor })
        );
        const [, token] = cookie.split('=');
        assert.equal(
            resolveServeCookieActor(
                request(serveCookieName(ROUTE_B) + '=' + token),
                PROJECT,
                ROUTE_B
            ),
            null
        );
        const [payload, signature] = token!.split('.');
        const changed = Buffer.from(
            JSON.stringify({
                ...JSON.parse(Buffer.from(payload!, 'base64url').toString()),
                wallId: 'wall-b'
            })
        ).toString('base64url');
        assert.equal(
            resolveServeCookieActor(
                request(serveCookieName(ROUTE_A) + '=' + changed + '.' + signature),
                PROJECT,
                ROUTE_A
            ),
            null
        );
    });

    test('preview expires after 15 minutes and does not refresh', () => {
        const setCookie = createServeCookie({
            request: request(),
            projectId: PROJECT,
            routeId: ROUTE_A,
            actor: { surface: 'preview-screen' }
        });
        assert.ok(setCookie.includes('Max-Age=900'));
        const preview = resolveServeCookieActor(request(value(setCookie)), PROJECT, ROUTE_A);
        assert.equal(preview?.surface, 'preview-screen');
        assert.equal(shouldRefreshServeCookie(preview!, Date.now() + 14 * 60_000), false);
    });

    test('refreshes a live wall cookie after half its two-hour life', () => {
        const now = Date.now();
        const half = SERVE_COOKIE_MAX_AGE_SECONDS * 500;
        assert.equal(shouldRefreshServeCookie({ ...actor, expiresAt: now + half + 1 }, now), false);
        assert.equal(shouldRefreshServeCookie({ ...actor, expiresAt: now + half - 1 }, now), true);
    });
});
