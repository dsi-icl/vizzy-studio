import { mock } from 'bun:test';
/**
 * In-memory smoke test for the demo gateway. No VM, database, or network is used.
 * Run from the repository root: bun tooling/testing/demo-gateway-smoke.ts
 */
import assert from 'node:assert/strict';

const demoOrigin = 'https://vizzy-studio-demos.dsi.ic.ac.uk';
const upstreamOrigin = 'http://127.0.0.1:5780';
const directOrigin = 'http://127.0.0.1:3002';
const projectId = '69fb297952b72213cf9f59b8';
const wallId = 'bitcoin-wall';
const scopeId = 41;

process.env.SERVER_DEMO_GATEWAY_SOURCE_ORIGIN = demoOrigin;
process.env.SERVER_DEMO_GATEWAY_UPSTREAM_ORIGIN = upstreamOrigin;
process.env.SERVER_DEMO_GATEWAY_DIRECT_UPSTREAMS = JSON.stringify({
    sustainability: { origin: directOrigin, assetsFromRoot: true }
});

// Only the two pieces of wall state read by the gateway are needed here.
const wallBindings = new Map<string, number>([[wallId, scopeId]]);
const scopedState = new Map<number, { projectId: string }>([[scopeId, { projectId }]]);
mock.module('~/lib/busState', () => ({ wallBindings, scopedState }));

const { handleDemoGatewayRequest } = await import('../../apps/web/src/server/demoGateway');
const { issueDemoLaunch } = await import('../../apps/web/src/lib/demoGatewaySessions');

const forwarded: Array<{ url: string; host: string | null; referer: string | null }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    forwarded.push({
        url: String(input),
        host: headers.get('Host'),
        referer: headers.get('Referer')
    });
    if (String(input) === `${directOrigin}/sustainability/control`) {
        return new Response(null, {
            status: 307,
            headers: { Location: `${directOrigin}/sustainability/control?operator=A` }
        });
    }
    return new Response('from fake demos Nginx', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' }
    });
}) as typeof fetch;

function request(path: string, cookie?: string): Request {
    return new Request(`${demoOrigin}${path}`, {
        headers: cookie ? { Cookie: cookie } : undefined
    });
}

function grant() {
    return {
        access: 'wall' as const,
        wallId,
        scopeId,
        projectId,
        kind: 'screen' as const,
        slug: 'bitcoin',
        entryPath: '/bitcoin/'
    };
}

try {
    assert.equal((await handleDemoGatewayRequest(request('/_vizzy/gateway-health')))?.status, 200);
    assert.equal(forwarded.length, 0);
    console.log('PASS: load balancer health path responds without exposing a demo');

    // A copied public URL is known, but it does not give a new browser access.
    assert.equal((await handleDemoGatewayRequest(request('/bitcoin/')))?.status, 401);
    assert.equal(forwarded.length, 0);
    console.log('PASS: direct /bitcoin/ without a session is denied');

    const browserCookies = new Set<string>();
    for (let index = 0; index < 64; index += 1) {
        const col = index % 8;
        const row = Math.floor(index / 8);
        const { ticket } = issueDemoLaunch(grant());
        const launchPath = `/_vizzy/demo-launch/${projectId}/screen?ticket=${ticket}&c=${col}&r=${row}`;
        const launch = await handleDemoGatewayRequest(request(launchPath));
        assert.equal(launch?.status, 303);
        assert.equal(launch.headers.get('Location'), `/bitcoin/?c=${col}&r=${row}`);
        const cookie = launch.headers.get('Set-Cookie')?.split(';', 1)[0];
        assert.ok(cookie);
        assert.ok(cookie.startsWith('__Host-vizzy_demo_session='));
        browserCookies.add(cookie);

        // The redirect has finished: HTML and assets load at their original paths.
        assert.equal(
            (await handleDemoGatewayRequest(request(`/bitcoin/?c=${col}&r=${row}`, cookie)))
                ?.status,
            200
        );
        assert.equal(
            (await handleDemoGatewayRequest(request('/bitcoin/assets/main.js', cookie)))?.status,
            200
        );
        assert.equal((await handleDemoGatewayRequest(request(launchPath)))?.status, 401);
    }
    assert.equal(browserCookies.size, 64);
    assert.equal(forwarded.length, 128);
    assert.equal(forwarded[0]?.url, `${upstreamOrigin}/bitcoin/?c=0&r=0`);
    assert.equal(forwarded[0]?.host, 'vizzy-studio-demos.dsi.ic.ac.uk');
    assert.equal(forwarded[0]?.referer, `${demoOrigin}/bitcoin/`);
    assert.equal(forwarded[1]?.url, `${upstreamOrigin}/bitcoin/assets/main.js`);
    console.log('PASS: 64 separate browsers receive unique sessions and keep c/r and asset paths');

    const firstCookie = browserCookies.values().next().value;
    assert.ok(firstCookie);
    wallBindings.delete(wallId);
    assert.equal((await handleDemoGatewayRequest(request('/bitcoin/', firstCookie)))?.status, 401);
    assert.equal(forwarded.length, 128);
    console.log('PASS: removing the wall binding denies existing sessions before proxying');

    const previewGrant = {
        access: 'admin-preview' as const,
        projectId,
        kind: 'controller' as const,
        slug: 'bitcoin',
        entryPath: '/bitcoin/control'
    };
    const { ticket } = issueDemoLaunch(previewGrant);
    const adminLaunch = await handleDemoGatewayRequest(
        request(`/_vizzy/demo-launch/${projectId}/controller?ticket=${ticket}`)
    );
    assert.equal(adminLaunch?.status, 303);
    assert.equal(adminLaunch.headers.get('Location'), '/bitcoin/control');
    const adminCookie = adminLaunch.headers.get('Set-Cookie')?.split(';', 1)[0];
    assert.ok(adminCookie);
    assert.equal(
        (await handleDemoGatewayRequest(request('/bitcoin/control', adminCookie)))?.status,
        200
    );
    assert.equal(
        (await handleDemoGatewayRequest(request('/bitcoin/assets/main.js', adminCookie)))?.status,
        200
    );
    assert.equal(forwarded.length, 130);
    console.log('PASS: admin preview opens demo and assets without a wall binding');

    const sustainabilityProjectId = '111111111111111111111111';
    const sustainabilityTicket = issueDemoLaunch({
        access: 'admin-preview',
        projectId: sustainabilityProjectId,
        kind: 'controller',
        slug: 'sustainability',
        entryPath: '/sustainability/control'
    }).ticket;
    const directLaunch = await handleDemoGatewayRequest(
        request(
            `/_vizzy/demo-launch/${sustainabilityProjectId}/controller?ticket=${sustainabilityTicket}`
        )
    );
    assert.equal(directLaunch?.status, 303);
    const directCookie = directLaunch.headers.get('Set-Cookie')?.split(';', 1)[0];
    assert.ok(directCookie);
    const directControl = await handleDemoGatewayRequest(
        request('/sustainability/control', directCookie)
    );
    assert.equal(directControl?.status, 307);
    assert.equal(directControl.headers.get('Location'), '/sustainability/control?operator=A');
    assert.equal(
        (await handleDemoGatewayRequest(request('/sustainability/screen', directCookie)))?.status,
        200
    );
    assert.equal(
        (await handleDemoGatewayRequest(request('/sustainability/assets/main.js', directCookie)))
            ?.status,
        200
    );
    assert.equal((await handleDemoGatewayRequest(request('/api/data', directCookie)))?.status, 200);
    assert.equal(
        (await handleDemoGatewayRequest(request('/pages/powering.png', directCookie)))?.status,
        200
    );
    assert.equal(
        (await handleDemoGatewayRequest(request('/network/powering-data.json', directCookie)))
            ?.status,
        200
    );
    assert.equal(forwarded[130]?.url, `${directOrigin}/sustainability/control`);
    assert.equal(forwarded[131]?.url, `${directOrigin}/sustainability/screen`);
    assert.equal(forwarded[132]?.url, `${directOrigin}/assets/main.js`);
    assert.equal(forwarded[133]?.url, `${directOrigin}/api/data`);
    assert.equal(forwarded[134]?.url, `${directOrigin}/pages/powering.png`);
    assert.equal(forwarded[135]?.url, `${directOrigin}/network/powering-data.json`);
    assert.equal(forwarded[132]?.referer, `${demoOrigin}/sustainability/`);
    assert.equal(
        (await handleDemoGatewayRequest(request('/bitcoin/assets/main.js', directCookie)))?.status,
        404
    );
    console.log('PASS: sustainability uses direct port and bitcoin remains on Nginx');
} finally {
    globalThis.fetch = originalFetch;
}
