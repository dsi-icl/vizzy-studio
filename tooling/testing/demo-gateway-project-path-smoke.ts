import { mock } from 'bun:test';
import assert from 'node:assert/strict';

const publicOrigin = 'https://vizzy.dsi.ic.ac.uk';
const sourceOrigin = 'https://vizzy-studio-demos.dsi.ic.ac.uk';
const upstreamOrigin = 'http://127.0.0.1:5780';
const projectId = '69fb297952b72213cf9f59b8';
const wallId = 'wall-1';
const scopeId = 13;

process.env.VITE_BASE_URL = publicOrigin;
process.env.SERVER_DEMO_GATEWAY_PUBLIC_ORIGIN = publicOrigin;
process.env.SERVER_DEMO_GATEWAY_PATHS = JSON.stringify({ bitcoin: ['api', 'bus'] });
process.env.SERVER_DEMO_GATEWAY_SOURCE_ORIGIN = sourceOrigin;
process.env.SERVER_DEMO_GATEWAY_UPSTREAM_ORIGIN = upstreamOrigin;

const wallBindings = new Map([[wallId, scopeId]]);
const scopedState = new Map([[scopeId, { projectId }]]);
mock.module('~/lib/busState', () => ({ wallBindings, scopedState }));

const { handleDemoGatewayRequest } = await import('../../apps/web/src/server/demoGateway');
const { issueDemoLaunch } = await import('../../apps/web/src/lib/demoGatewaySessions');

const forwarded: Array<{ url: string; headers: Headers }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    forwarded.push({ url: target, headers: new Headers(init?.headers) });
    if (target.includes('/bitcoin/control')) {
        return new Response(null, {
            status: 307,
            headers: { Location: '/bitcoin/control?operator=A' }
        });
    }
    return new Response('demo response', {
        headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'demo_auth=secret; Path=/' }
    });
}) as typeof fetch;

function request(path: string, cookie?: string): Request {
    return new Request(`${publicOrigin}${path}`, {
        headers: cookie ? { Cookie: `${cookie}; vizzy_main_auth=must-not-leak` } : undefined
    });
}

try {
    const path = `/demos/${projectId}`;
    assert.equal(await handleDemoGatewayRequest(request('/quarry/projects')), null);
    assert.equal((await handleDemoGatewayRequest(request(`${path}/screen`)))?.status, 401);
    assert.equal(forwarded.length, 0);

    const { ticket } = issueDemoLaunch({
        access: 'wall',
        wallId,
        scopeId,
        projectId,
        kind: 'screen',
        slug: 'bitcoin',
        entryPath: '/bitcoin/screen'
    });
    const launch = await handleDemoGatewayRequest(
        request(`${path}/_launch/screen?ticket=${ticket}&c=3&r=5`)
    );
    assert.equal(launch?.status, 303);
    const screenLocation = launch.headers.get('Location')!;
    assert.match(screenLocation, new RegExp(`^${path}/s/[A-Za-z0-9_-]{22}/screen\\?c=3&r=5$`));
    const sessionBase = screenLocation.slice(0, -'/screen?c=3&r=5'.length);
    const cookie = launch.headers.get('Set-Cookie')?.split(';', 1)[0] ?? '';
    assert.ok(cookie?.startsWith('__Secure-vizzy_demo_session='));
    assert.ok(launch.headers.get('Set-Cookie')?.includes(`Path=${sessionBase}/;`));
    assert.equal(
        (await handleDemoGatewayRequest(request(`${path}/_launch/screen?ticket=${ticket}`)))
            ?.status,
        401
    );

    const screen = await handleDemoGatewayRequest(request(`${sessionBase}/screen`, cookie));
    assert.equal(screen?.status, 200);
    assert.equal(screen.headers.get('Set-Cookie'), null);
    assert.equal(
        (await handleDemoGatewayRequest(request(`${sessionBase}/assets/main.js`, cookie)))?.status,
        200
    );
    assert.equal(
        (await handleDemoGatewayRequest(request(`${sessionBase}/api/data`, cookie)))?.status,
        200
    );
    assert.equal(
        (await handleDemoGatewayRequest(request(`${sessionBase}/bus`, cookie)))?.status,
        200
    );
    const websocket = await handleDemoGatewayRequest(
        new Request(`${publicOrigin}${sessionBase}/bus`, {
            headers: {
                Cookie: cookie,
                Origin: publicOrigin,
                Upgrade: 'websocket',
                Connection: 'Upgrade'
            }
        })
    );
    assert.equal(websocket?.status, 426);
    assert.ok(websocket && 'crossws' in websocket);
    assert.deepEqual(
        forwarded.map(({ url }) => url),
        [
            `${upstreamOrigin}/bitcoin/screen`,
            `${upstreamOrigin}/bitcoin/assets/main.js`,
            `${upstreamOrigin}/api/data`,
            `${upstreamOrigin}/bus`
        ]
    );
    assert.equal(forwarded[0]?.headers.get('Cookie'), null);
    assert.equal(forwarded[0]?.headers.get('Host'), 'vizzy-studio-demos.dsi.ic.ac.uk');
    assert.equal(forwarded[0]?.headers.get('Referer'), `${sourceOrigin}/bitcoin/`);
    assert.equal(forwarded[0]?.headers.get('X-Vizzy-Demo-Project-Id'), projectId);
    assert.equal(forwarded[0]?.headers.get('X-Vizzy-Demo-Wall-Id'), wallId);
    assert.equal(forwarded[0]?.headers.get('X-Vizzy-Demo-Surface'), 'screen');
    assert.equal(forwarded[0]?.headers.get('X-Vizzy-Demo-Public-Base'), sessionBase);

    const spoofed = await handleDemoGatewayRequest(
        new Request(`${publicOrigin}${sessionBase}/assets/main.js`, {
            headers: {
                Cookie: cookie,
                'X-Vizzy-Demo-Public-Base': '/demos/attacker/s/attacker'
            }
        })
    );
    assert.equal(spoofed?.status, 200);
    assert.equal(forwarded.at(-1)?.headers.get('X-Vizzy-Demo-Public-Base'), sessionBase);

    const secondId = '111111111111111111111111';
    assert.equal(
        (
            await handleDemoGatewayRequest(
                request(sessionBase.replace(projectId, secondId) + '/screen', cookie)
            )
        )?.status,
        401
    );
    assert.equal(forwarded.length, 5);

    const previewTicket = issueDemoLaunch({
        access: 'admin-preview',
        projectId,
        kind: 'controller',
        slug: 'bitcoin',
        entryPath: '/bitcoin/control'
    }).ticket;
    const preview = await handleDemoGatewayRequest(
        request(`${path}/_launch/controller?ticket=${previewTicket}`)
    );
    assert.equal(preview?.status, 303);
    const previewCookie = preview.headers.get('Set-Cookie')?.split(';', 1)[0];
    const previewLocation = preview.headers.get('Location')!;
    const previewBase = previewLocation.slice(0, -'/control'.length);
    assert.notEqual(previewBase, sessionBase);
    assert.notEqual(previewCookie, cookie);
    const redirect = await handleDemoGatewayRequest(request(previewLocation, previewCookie));
    assert.equal(redirect?.status, 307);
    assert.equal(redirect.headers.get('Location'), `${previewBase}/control?operator=A`);
    assert.equal(forwarded[5]?.headers.get('X-Vizzy-Demo-Wall-Id'), null);
    assert.equal(forwarded[5]?.headers.get('X-Vizzy-Demo-Surface'), 'controller');
    assert.equal(forwarded[5]?.headers.get('X-Vizzy-Demo-Public-Base'), previewBase);

    const secondWallId = 'wall-2';
    const secondScopeId = 14;
    wallBindings.set(secondWallId, secondScopeId);
    scopedState.set(secondScopeId, { projectId });
    const secondWallTicket = issueDemoLaunch({
        access: 'wall',
        wallId: secondWallId,
        scopeId: secondScopeId,
        projectId,
        kind: 'screen',
        slug: 'bitcoin',
        entryPath: '/bitcoin/screen'
    }).ticket;
    const secondWallLaunch = await handleDemoGatewayRequest(
        request(`${path}/_launch/screen?ticket=${secondWallTicket}`)
    );
    const secondWallLocation = secondWallLaunch?.headers.get('Location')!;
    const secondWallCookie = secondWallLaunch?.headers.get('Set-Cookie')?.split(';', 1)[0];
    assert.ok(secondWallCookie);
    assert.notEqual(secondWallLocation, `${sessionBase}/screen`);
    assert.equal(
        (await handleDemoGatewayRequest(request(`${sessionBase}/screen`, cookie)))?.status,
        200
    );
    assert.equal(
        (await handleDemoGatewayRequest(request(secondWallLocation, secondWallCookie)))?.status,
        200
    );
    assert.equal(forwarded.at(-1)?.headers.get('X-Vizzy-Demo-Wall-Id'), secondWallId);
    assert.equal(
        (await handleDemoGatewayRequest(request(secondWallLocation, cookie)))?.status,
        401
    );

    wallBindings.delete(wallId);
    assert.equal(
        (await handleDemoGatewayRequest(request(`${sessionBase}/screen`, cookie)))?.status,
        401
    );
    assert.equal(
        (await handleDemoGatewayRequest(request(secondWallLocation, secondWallCookie)))?.status,
        200
    );
    console.log('PASS: project path auth, proxy, redirects, cookie isolation, and unbind');
} finally {
    globalThis.fetch = originalFetch;
}
