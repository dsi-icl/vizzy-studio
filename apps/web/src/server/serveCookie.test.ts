import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';

import { env } from '@repo/env';

import {
    createServeCookie,
    resolveServeCookieGrant,
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
    bindingId: ROUTE_A
};
const value = (setCookie: string) => setCookie.split(';')[0]!;
const request = (path = `/serve/${PROJECT}/screen`, cookie?: string, referer?: string) =>
    new Request(`https://studio.example${path}`, {
        headers: { ...(cookie ? { cookie } : {}), ...(referer ? { referer } : {}) }
    });

describe('serve cookie', () => {
    test('signs a grant and scopes its cookie to the static project base', () => {
        const setCookie = createServeCookie({
            request: request(),
            projectId: PROJECT,
            routeId: ROUTE_A,
            actor
        });
        const resolved = resolveServeCookieGrant(
            request(`/serve/${PROJECT}/screen?__vizzySession=${ROUTE_A}`, value(setCookie)),
            PROJECT
        );
        assert.equal(resolved?.routeId, ROUTE_A);
        assert.equal(resolved?.actor.surface, 'wall');
        assert.equal(resolved?.actor.surface === 'wall' && resolved.actor.wallId, 'wall-a');
        assert.match(setCookie, new RegExp(`Path=/serve/${PROJECT};`));
        assert.ok(setCookie.includes('HttpOnly'));
        assert.ok(setCookie.includes('Secure'));
        assert.ok(setCookie.includes('SameSite=None'));
    });

    test('keeps screen and control grants when launches are sequential', () => {
        const first = value(
            createServeCookie({ request: request(), projectId: PROJECT, routeId: ROUTE_A, actor })
        );
        const second = value(
            createServeCookie({
                request: request(`/serve/${PROJECT}/_launch`, first),
                projectId: PROJECT,
                routeId: ROUTE_B,
                actor: { surface: 'control', wallId: 'wall-b', scopeId: 8, bindingId: ROUTE_B }
            })
        );
        const cookies = `${first}; ${second}`;
        const screen = resolveServeCookieGrant(
            request(`/serve/${PROJECT}/screen?__vizzySession=${ROUTE_A}`, cookies),
            PROJECT
        );
        const control = resolveServeCookieGrant(
            request(`/serve/${PROJECT}/control?__vizzySession=${ROUTE_B}`, cookies),
            PROJECT
        );
        assert.equal(screen?.actor.surface === 'wall' && screen.actor.wallId, 'wall-a');
        assert.equal(control?.actor.surface === 'control' && control.actor.wallId, 'wall-b');
        assert.equal(
            resolveServeCookieGrant(
                request(
                    `/serve/${PROJECT}/assets/app.js`,
                    cookies,
                    `https://studio.example/serve/${PROJECT}/screen?__vizzySession=${ROUTE_A}`
                ),
                PROJECT
            )?.routeId,
            ROUTE_A
        );
        assert.equal(
            resolveServeCookieGrant(request(`/serve/${PROJECT}/assets/app.js`, cookies), PROJECT)
                ?.actor.surface !== undefined,
            true
        );
        assert.equal(
            resolveServeCookieGrant(request(`/serve/${PROJECT}/bus`, cookies), PROJECT),
            null
        );
        assert.equal(
            resolveServeCookieGrant(request(`/serve/${PROJECT}/screen`, cookies), OTHER_PROJECT),
            null
        );
    });

    test('concurrent launches for one project keep both grants in the browser cookie jar', () => {
        const launchRequest = request(`/serve/${PROJECT}/_launch`);
        const screenCookie = value(
            createServeCookie({
                request: launchRequest,
                projectId: PROJECT,
                routeId: ROUTE_A,
                actor
            })
        );
        const controlCookie = value(
            createServeCookie({
                request: launchRequest,
                projectId: PROJECT,
                routeId: ROUTE_B,
                actor: { surface: 'control', wallId: 'wall-a', scopeId: 7, bindingId: ROUTE_A }
            })
        );
        const jar = new Map<string, string>();
        for (const cookie of [screenCookie, controlCookie]) {
            const name = cookie.slice(0, cookie.indexOf('='));
            jar.set(name, cookie);
        }
        const cookieHeader = [...jar.values()].join('; ');
        assert.equal(
            resolveServeCookieGrant(
                request(`/serve/${PROJECT}/screen?__vizzySession=${ROUTE_A}`, cookieHeader),
                PROJECT
            )?.routeId,
            ROUTE_A
        );
        assert.equal(
            resolveServeCookieGrant(
                request(`/serve/${PROJECT}/control?__vizzySession=${ROUTE_B}`, cookieHeader),
                PROJECT
            )?.routeId,
            ROUTE_B
        );
    });

    test('accepts existing signed project cookies during rollout', () => {
        const now = Date.now();
        const encoded = Buffer.from(
            JSON.stringify({
                v: 2,
                projectId: PROJECT,
                iat: now,
                grants: {
                    [ROUTE_A]: {
                        surface: 'wall',
                        wallId: 'wall-a',
                        scopeId: 7,
                        bindingId: ROUTE_A,
                        iat: now,
                        exp: now + 60_000
                    }
                }
            })
        ).toString('base64url');
        const signature = createHmac('sha256', env.SERVER_AUTH_SECRET || 'degraded-mode-secret')
            .update('serve-cookie-v2:')
            .update(encoded)
            .digest('base64url');
        const legacyCookie = `vizzy_serve_${PROJECT}=${encoded}.${signature}`;
        assert.equal(
            resolveServeCookieGrant(
                request(`/serve/${PROJECT}/screen?__vizzySession=${ROUTE_A}`, legacyCookie),
                PROJECT
            )?.routeId,
            ROUTE_A
        );
    });

    test('rejects tampering and stale binding grants', () => {
        const cookie = value(
            createServeCookie({ request: request(), projectId: PROJECT, routeId: ROUTE_A, actor })
        );
        const [name, token] = cookie.split('=');
        const [payload, signature] = token!.split('.');
        const changed = Buffer.from(
            JSON.stringify({
                ...JSON.parse(Buffer.from(payload!, 'base64url').toString()),
                projectId: OTHER_PROJECT
            })
        ).toString('base64url');
        assert.equal(
            resolveServeCookieGrant(
                request(`/serve/${PROJECT}/screen`, `${name}=${changed}.${signature}`),
                PROJECT
            ),
            null
        );
        assert.equal(
            resolveServeCookieGrant(
                request(`/serve/${PROJECT}/screen?__vizzySession=${ROUTE_A}`, cookie),
                PROJECT,
                () => false
            ),
            null
        );
        assert.equal(name, serveCookieName(PROJECT, ROUTE_A));
    });

    test('preview expires after 15 minutes and does not refresh', () => {
        const setCookie = createServeCookie({
            request: request(),
            projectId: PROJECT,
            routeId: ROUTE_A,
            actor: { surface: 'preview' }
        });
        assert.ok(setCookie.includes('Max-Age=900'));
        const preview = resolveServeCookieGrant(
            request(`/serve/${PROJECT}/screen`, value(setCookie)),
            PROJECT
        )?.actor;
        assert.equal(preview?.surface, 'preview');
        assert.equal(shouldRefreshServeCookie(preview!, Date.now() + 14 * 60_000), false);
    });

    test('refreshes a live wall cookie after half its two-hour life', () => {
        const now = Date.now();
        const half = SERVE_COOKIE_MAX_AGE_SECONDS * 500;
        assert.equal(shouldRefreshServeCookie({ ...actor, expiresAt: now + half + 1 }, now), false);
        assert.equal(shouldRefreshServeCookie({ ...actor, expiresAt: now + half - 1 }, now), true);
    });
});
