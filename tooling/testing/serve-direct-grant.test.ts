/// <reference types="bun" />

import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.SERVER_AUTH_SECRET = 'test-only-secret';

const projectId = '507f1f77bcf86cd799439011';
const wallId = 'wall-a';
const firstBindingId = 'AAAAAAAAAAAAAAAAAAAAAA';
const secondBindingId = 'BBBBBBBBBBBBBBBBBBBBBB';
const wallBindings = new Map([[wallId, 7]]);
const wallBindingIds = new Map([[wallId, firstBindingId]]);
let request = new Request('https://studio.example/api/serve-launch', { method: 'POST' });
let responseHeaders = new Headers();

mock.module('@tanstack/react-start', () => ({
    createServerFn: () => ({
        validator() {
            return this;
        },
        middleware() {
            return this;
        },
        handler<T>(handler: T) {
            return handler;
        }
    })
}));
mock.module('@tanstack/react-start/server', () => ({
    getRequest: () => request,
    getResponseHeaders: () => responseHeaders
}));
mock.module('~/lib/busState', () => ({ wallBindings, wallBindingIds }));
mock.module('~/lib/customProject', () => ({ isCustomProject: () => true }));
mock.module('~/server/auth-context.middleware', () => ({ actorAuthContextMiddleware: {} }));
mock.module('~/server/serveProject', () => ({
    getServeProject: async () => ({ customPort: 3008 })
}));
mock.module('~/server/serveAuthz', () => ({
    isWallBoundToProject: (
        _wallId: string,
        _projectId: string,
        _scopeId: number,
        bindingId: string
    ) => wallBindingIds.get(wallId) === bindingId
}));
mock.module('~/server/serveOrigin', () => ({
    servePublicUrl: (path: string) => `https://studio.example${path}`
}));
mock.module('~/server/serveTiming', () => ({
    recordServeTiming: () => {},
    serveTraceId: () => 'trace'
}));

const { $issueBoundServeLaunch, $issueAdminServePreview } =
    await import('../../apps/web/src/server/serve.fns');

const boundLaunch = $issueBoundServeLaunch as unknown as (input: {
    data: { projectId: string; wallId: string; entry: 'screen' | 'control' };
    context: { authContext: { device: { kind: 'wall' | 'gallery'; wallId: string } } };
}) => Promise<{ url: string; keepaliveUrl: string }>;
const adminPreview = $issueAdminServePreview as unknown as (input: {
    data: { projectId: string; entry: 'screen' | 'control' };
    context: { authContext: { user: { role: 'admin' } } };
}) => Promise<{ url: string }>;

function resetResponse(cookie?: string) {
    request = new Request('https://studio.example/api/serve-launch', {
        method: 'POST',
        headers: cookie ? { cookie } : undefined
    });
    responseHeaders = new Headers();
}

test('bound launch sets a two-hour cookie and returns its final screen URL', async () => {
    resetResponse();
    const launch = await boundLaunch({
        data: { projectId, wallId, entry: 'screen' },
        context: { authContext: { device: { kind: 'wall', wallId } } }
    });
    const url = new URL(launch.url);
    const routeId = url.searchParams.get('__vizzySession');
    assert.equal(url.pathname, `/serve/${projectId}/screen`);
    assert.match(routeId ?? '', /^[A-Za-z0-9_-]{22}$/);
    assert.equal(url.searchParams.has('ticket'), false);
    assert.equal(
        launch.keepaliveUrl,
        `https://studio.example/serve/${projectId}/_keepalive?__vizzySession=${routeId}`
    );
    assert.match(responseHeaders.get('set-cookie') ?? '', /Max-Age=7200/);
    assert.match(responseHeaders.get('set-cookie') ?? '', /HttpOnly; SameSite=None; Secure/);

    const previousCookie = responseHeaders.get('set-cookie')!.split(';')[0]!;
    wallBindingIds.set(wallId, secondBindingId);
    resetResponse(previousCookie);
    const rebound = await boundLaunch({
        data: { projectId, wallId, entry: 'screen' },
        context: { authContext: { device: { kind: 'wall', wallId } } }
    });
    assert.notEqual(new URL(rebound.url).searchParams.get('__vizzySession'), routeId);
    assert.match(responseHeaders.get('set-cookie') ?? '', /Max-Age=0/);
    assert.match(responseHeaders.get('set-cookie') ?? '', /Max-Age=7200/);
});

test('admin preview sets a fifteen-minute cookie on the control URL', async () => {
    resetResponse();
    const preview = await adminPreview({
        data: { projectId, entry: 'control' },
        context: { authContext: { user: { role: 'admin' } } }
    });
    const url = new URL(preview.url);
    assert.equal(url.pathname, `/serve/${projectId}/control`);
    assert.equal(url.searchParams.get('preview'), '1');
    assert.match(responseHeaders.get('set-cookie') ?? '', /Max-Age=900/);
});
