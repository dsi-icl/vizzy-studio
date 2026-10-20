/// <reference types="bun" />

import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.VITE_BASE_URL = 'https://studio.example';
process.env.SERVER_AUTH_SECRET = 'test-only-secret';
process.env.DEMOS_HOSTS = '127.0.0.1';

const projectId = '507f1f77bcf86cd799439011';
const wallBindings = new Map([
    ['wall-a', 7],
    ['wall-b', 8]
]);
const wallBindingIds = new Map([
    ['wall-a', 'AAAAAAAAAAAAAAAAAAAAAA'],
    ['wall-b', 'BBBBBBBBBBBBBBBBBBBBBB']
]);
const scopedState = new Map([
    [7, { projectId }],
    [8, { projectId }]
]);
const storedTickets = new Map<string, Date>();
const projectSettings = { customPort: 3008, customHost: '127.0.0.1', customStripPrefix: false };

mock.module('~/lib/busState', () => ({ wallBindings, wallBindingIds, scopedState }));
mock.module('~/server/projects', () => ({ getProject: async () => projectSettings }));
mock.module('~/server/audit', () => ({
    logAuditDenied: async () => {},
    logAuditFailure: async () => {}
}));
mock.module('~/server/collections', () => ({
    collections: {
        serveLaunches: {
            createIndex: async () => 'expiresAt_1',
            insertOne: async (doc: { _id: string; expiresAt: Date }) => {
                storedTickets.set(doc._id, doc.expiresAt);
            },
            findOneAndDelete: async (query: { _id: string }) => {
                const expiresAt = storedTickets.get(query._id);
                storedTickets.delete(query._id);
                return expiresAt && expiresAt > new Date() ? { _id: query._id, expiresAt } : null;
            }
        }
    }
}));

const { issueServeLaunch } = await import('../../apps/web/src/server/serveLaunch');
const { handleServeRequest } = await import('../../apps/web/src/routes/serve.$projectId.$');
const { resolveServeWebSocketUpstream } = await import('../../apps/web/src/server/serveWebSocket');
const { servePublicUrl } = await import('../../apps/web/src/server/serveOrigin');

const forwarded: Array<{ url: string; headers: Headers }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    forwarded.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response('<html>demo</html>', {
        headers: { 'content-type': 'text/html', location: '/assets/app.js', 'set-cookie': 'bad=1' }
    });
}) as typeof fetch;

function request(path: string, cookie?: string, origin = 'https://studio.example'): Request {
    return new Request(`${origin}${path}`, {
        headers: { host: new URL(origin).host, ...(cookie ? { cookie } : {}) }
    });
}

describe('sandboxed same-host serve gateway', () => {
    test('publishes demo URLs on the Vizzy FQDN', () => {
        assert.equal(
            servePublicUrl(`/serve/${projectId}/screen`),
            `https://studio.example/serve/${projectId}/screen`
        );
    });

    test('rejects another host and direct unauthenticated demo navigation', async () => {
        assert.equal(
            (
                await handleServeRequest(
                    request(`/serve/${projectId}/screen`, undefined, 'https://other.example')
                )
            ).status,
            404
        );
        assert.equal((await handleServeRequest(request(`/serve/${projectId}/screen`))).status, 403);
        const websocket = new Request(`https://studio.example/serve/${projectId}/bus`, {
            headers: {
                host: 'studio.example',
                origin: 'null',
                connection: 'Upgrade',
                upgrade: 'websocket'
            }
        });
        assert.equal((await handleServeRequest(websocket)).status, 403);
    });

    test('consumes a launch once and proxies the static project path', async () => {
        const { ticket, routeId } = await issueServeLaunch({
            projectId,
            entry: 'screen',
            actor: {
                surface: 'wall',
                wallId: 'wall-a',
                scopeId: 7,
                bindingId: 'AAAAAAAAAAAAAAAAAAAAAA'
            }
        });
        const launchPath = `/serve/${projectId}/_launch?ticket=${encodeURIComponent(ticket)}&c=2&r=3`;
        const launch = await handleServeRequest(request(launchPath));
        assert.equal(launch.status, 303);
        assert.equal(
            launch.headers.get('location'),
            `/serve/${projectId}/screen?__vizzySession=${routeId}&c=2&r=3`
        );
        assert.equal((await handleServeRequest(request(launchPath))).status, 401);
        const cookie = launch.headers.get('set-cookie')!.split(';')[0]!;
        assert.match(launch.headers.get('set-cookie')!, /SameSite=None; Secure/);
        const page = await handleServeRequest(
            request(
                `/serve/${projectId}/screen?__vizzySession=${routeId}`,
                `${cookie}; vizzy_main_auth=must-not-leak`
            )
        );
        assert.equal(page.status, 200);
        assert.equal(
            page.headers.get('location'),
            `/serve/${projectId}/assets/app.js?__vizzySession=${routeId}`
        );
        assert.match(
            page.headers.get('content-security-policy') ?? '',
            /sandbox allow-scripts allow-forms allow-same-site-none-cookies; frame-ancestors 'self'/
        );
        assert.doesNotMatch(page.headers.get('content-security-policy') ?? '', /allow-same-origin/);
        assert.doesNotMatch(
            page.headers.get('content-security-policy') ?? '',
            /default-src|script-src|style-src/
        );
        assert.equal(page.headers.get('set-cookie'), null);
        assert.equal(forwarded.at(-1)?.url, `http://127.0.0.1:3008/serve/${projectId}/screen`);
        assert.equal(forwarded.at(-1)?.headers.get('cookie'), null);
        assert.equal(forwarded.at(-1)?.headers.get('x-vizzy-wall-id'), 'wall-a');
        assert.equal(forwarded.at(-1)?.headers.get('x-vizzy-public-base'), `/serve/${projectId}`);
        const beforeKeepalive = forwarded.length;
        const keepalive = await handleServeRequest(
            request(`/serve/${projectId}/_keepalive?__vizzySession=${routeId}`, cookie)
        );
        assert.equal(keepalive.status, 200);
        assert.equal(keepalive.headers.get('content-type'), 'image/gif');
        assert.ok(keepalive.headers.get('set-cookie'));
        assert.equal(forwarded.length, beforeKeepalive);
        wallBindingIds.set('wall-a', 'CCCCCCCCCCCCCCCCCCCCCC');
        assert.equal(
            (
                await handleServeRequest(
                    request(`/serve/${projectId}/screen?__vizzySession=${routeId}`, cookie)
                )
            ).status,
            403
        );
        wallBindings.delete('wall-a');
        assert.equal(
            (
                await handleServeRequest(
                    request(`/serve/${projectId}/screen?__vizzySession=${routeId}`, cookie)
                )
            ).status,
            403
        );
    });

    test('admin preview works without a wall and has a fixed short cookie lifetime', async () => {
        const { ticket, routeId } = await issueServeLaunch({
            projectId,
            entry: 'control',
            actor: { surface: 'preview' }
        });
        const launch = await handleServeRequest(
            request(`/serve/${projectId}/_launch?ticket=${ticket}`)
        );
        assert.equal(launch.status, 303);
        assert.ok(launch.headers.get('set-cookie')?.includes('Max-Age=900'));
        const cookie = launch.headers.get('set-cookie')!.split(';')[0]!;
        const page = await handleServeRequest(
            request(`/serve/${projectId}/control?__vizzySession=${routeId}`, cookie)
        );
        assert.equal(page.status, 200);
        const keepalive = await handleServeRequest(
            request(`/serve/${projectId}/_keepalive?__vizzySession=${routeId}`, cookie)
        );
        assert.equal(keepalive.headers.get('set-cookie'), null);
    });

    test('keeps two preview tabs and their static assets on the same project path', async () => {
        const screenLaunch = await issueServeLaunch({
            projectId,
            entry: 'screen',
            actor: { surface: 'preview' }
        });
        const screen = await handleServeRequest(
            request(`/serve/${projectId}/_launch?ticket=${screenLaunch.ticket}`)
        );
        const firstCookie = screen.headers.get('set-cookie')!.split(';')[0]!;
        const controlLaunch = await issueServeLaunch({
            projectId,
            entry: 'control',
            actor: { surface: 'preview' }
        });
        const control = await handleServeRequest(
            request(`/serve/${projectId}/_launch?ticket=${controlLaunch.ticket}`, firstCookie)
        );
        const cookie = control.headers.get('set-cookie')!.split(';')[0]!;
        assert.equal(
            (
                await handleServeRequest(
                    request(
                        `/serve/${projectId}/screen?__vizzySession=${screenLaunch.routeId}`,
                        cookie
                    )
                )
            ).status,
            200
        );
        assert.equal(
            (
                await handleServeRequest(
                    request(
                        `/serve/${projectId}/control?__vizzySession=${controlLaunch.routeId}`,
                        cookie
                    )
                )
            ).status,
            200
        );
        assert.equal(
            (await handleServeRequest(request(`/serve/${projectId}/assets/app.js`, cookie))).status,
            200
        );
    });

    test('honors customStripPrefix for a root-mounted demo', async () => {
        const { ticket, routeId } = await issueServeLaunch({
            projectId,
            entry: 'control',
            actor: { surface: 'preview' }
        });
        const launch = await handleServeRequest(
            request(`/serve/${projectId}/_launch?ticket=${ticket}`)
        );
        const cookie = launch.headers.get('set-cookie')!.split(';')[0]!;
        projectSettings.customStripPrefix = true;
        try {
            const response = await handleServeRequest(
                request(`/serve/${projectId}/control?__vizzySession=${routeId}&x=1`, cookie)
            );
            assert.equal(response.status, 200);
            assert.equal(forwarded.at(-1)?.url, 'http://127.0.0.1:3008/control?x=1');
        } finally {
            projectSettings.customStripPrefix = false;
        }
    });

    test('authorizes WebSocket upgrades through the project base and strips the session selector', async () => {
        const { ticket, routeId } = await issueServeLaunch({
            projectId,
            entry: 'control',
            actor: { surface: 'preview' }
        });
        const launch = await handleServeRequest(
            request(`/serve/${projectId}/_launch?ticket=${ticket}`)
        );
        const cookie = launch.headers.get('set-cookie')!.split(';')[0]!;
        const websocket = new Request(
            `https://studio.example/serve/${projectId}/bus?__vizzySession=${routeId}&channel=1`,
            {
                headers: {
                    host: 'studio.example',
                    origin: 'null',
                    cookie,
                    connection: 'Upgrade',
                    upgrade: 'websocket'
                }
            }
        );
        assert.equal(
            await resolveServeWebSocketUpstream(websocket),
            `ws://127.0.0.1:3008/serve/${projectId}/bus?channel=1`
        );
    });

    test('requires a selector for opaque-origin API and WebSocket requests', async () => {
        const { ticket, routeId } = await issueServeLaunch({
            projectId,
            entry: 'control',
            actor: { surface: 'preview' }
        });
        const launch = await handleServeRequest(
            request(`/serve/${projectId}/_launch?ticket=${ticket}`)
        );
        const cookie = launch.headers.get('set-cookie')!.split(';')[0]!;
        const api = (path: string, origin: string) =>
            new Request(`https://studio.example${path}`, {
                method: 'POST',
                headers: {
                    host: 'studio.example',
                    origin,
                    cookie,
                    'content-type': 'application/json'
                },
                body: '{}'
            });
        assert.equal(
            (await handleServeRequest(api(`/serve/${projectId}/api`, 'null'))).status,
            403
        );
        assert.equal(
            (
                await handleServeRequest(
                    api(`/serve/${projectId}/api?__vizzySession=${routeId}`, 'https://evil.example')
                )
            ).status,
            403
        );
        const allowed = await handleServeRequest(
            api(`/serve/${projectId}/api?__vizzySession=${routeId}`, 'null')
        );
        assert.equal(allowed.status, 200);
        assert.equal(allowed.headers.get('access-control-allow-origin'), 'null');
        assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
        assert.equal(forwarded.at(-1)?.headers.get('cookie'), null);

        const preflight = await handleServeRequest(
            new Request(`https://studio.example/serve/${projectId}/api?__vizzySession=${routeId}`, {
                method: 'OPTIONS',
                headers: {
                    host: 'studio.example',
                    origin: 'null',
                    'access-control-request-method': 'POST',
                    'access-control-request-headers': 'content-type'
                }
            })
        );
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');
        assert.equal(
            (
                await handleServeRequest(
                    new Request(`https://studio.example/serve/${projectId}/api`, {
                        method: 'OPTIONS',
                        headers: {
                            host: 'studio.example',
                            origin: 'null',
                            'access-control-request-method': 'POST'
                        }
                    })
                )
            ).status,
            403
        );

        const ws = (path: string) =>
            new Request(`https://studio.example${path}`, {
                headers: {
                    host: 'studio.example',
                    origin: 'null',
                    cookie,
                    connection: 'Upgrade',
                    upgrade: 'websocket'
                }
            });
        assert.equal(await resolveServeWebSocketUpstream(ws(`/serve/${projectId}/bus`)), null);
        assert.ok(
            await resolveServeWebSocketUpstream(
                ws(`/serve/${projectId}/bus?__vizzySession=${routeId}`)
            )
        );

        const asset = (cookieValue?: string, destination = 'script') =>
            new Request(`https://studio.example/serve/${projectId}/assets/app.js`, {
                headers: {
                    host: 'studio.example',
                    origin: 'null',
                    'sec-fetch-site': 'cross-site',
                    'sec-fetch-dest': destination,
                    ...(cookieValue ? { cookie: cookieValue } : {})
                }
            });
        const staticResponse = await handleServeRequest(asset(cookie));
        assert.equal(staticResponse.status, 200);
        assert.equal(staticResponse.headers.get('access-control-allow-origin'), 'null');
        assert.equal((await handleServeRequest(asset())).status, 403);
        assert.equal((await handleServeRequest(asset(cookie, 'empty'))).status, 403);
    });
});

process.on('exit', () => {
    globalThis.fetch = realFetch;
});
