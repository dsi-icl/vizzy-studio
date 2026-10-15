import { mock } from 'bun:test';

/**
 * Browser-visible, loopback-only demo gateway simulation.
 * Run: bun tooling/testing/demo-gateway-local.ts
 * This uses the real gateway handler, but fake Vizzy wall state and a fake demo.
 */
const vizzyOrigin = 'http://127.0.0.1:44701';
const demoOrigin = 'http://127.0.0.1:44702';
const upstreamOrigin = 'http://127.0.0.1:44703';
const projectId = '69fb297952b72213cf9f59b8';
const wallId = 'local-wall';
const scopeId = 1;

process.env.SERVER_DEMO_GATEWAY_SOURCE_ORIGIN = demoOrigin;
process.env.SERVER_DEMO_GATEWAY_UPSTREAM_ORIGIN = upstreamOrigin;
delete process.env.SERVER_DEMO_GATEWAY_DIRECT_UPSTREAMS;

const wallBindings = new Map([[wallId, scopeId]]);
const scopedState = new Map([[scopeId, { projectId }]]);
mock.module('~/lib/busState', () => ({ wallBindings, scopedState }));

const { handleDemoGatewayRequest } = await import('../../apps/web/src/server/demoGateway');
const { issueDemoLaunch, revokeDemoSessionsForWall } =
    await import('../../apps/web/src/lib/demoGatewaySessions');

function html(body: string): Response {
    return new Response(
        `<!doctype html><html><head><meta charset="utf-8"><title>Local demo gateway</title></head><body style="font:18px system-ui;padding:2rem">${body}</body></html>`,
        { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
    );
}

const fakeDemo = Bun.serve({
    hostname: '127.0.0.1',
    port: 44703,
    fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/bitcoin/') {
            return html(
                `<h2>Fake bitcoin demo: screen loaded</h2><p>This HTML came from the fake demos VM.</p><p id="asset">Waiting for asset...</p><p id="api">Waiting for API...</p><script src="/bitcoin/assets/app.js"></script>`
            );
        }
        if (path === '/bitcoin/assets/app.js') {
            return new Response(
                `document.querySelector('#asset').textContent = 'Asset loaded through Vizzy gateway'; fetch('/api/data').then(r => r.json()).then(data => { document.querySelector('#api').textContent = 'API loaded through Vizzy gateway: ' + data.message; });`,
                { headers: { 'Content-Type': 'text/javascript' } }
            );
        }
        if (path === '/api/data') {
            return Response.json({ message: 'hello from fake demos VM' });
        }
        return new Response('Fake demo path not found', { status: 404 });
    }
});

const gateway = Bun.serve({
    hostname: '127.0.0.1',
    port: 44702,
    async fetch(request) {
        return (
            (await handleDemoGatewayRequest(request)) ?? new Response('Wrong host', { status: 404 })
        );
    }
});

const vizzy = Bun.serve({
    hostname: '127.0.0.1',
    port: 44701,
    fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/reset' && request.method === 'POST') {
            wallBindings.set(wallId, scopeId);
            return new Response(null, { status: 204 });
        }
        if (path === '/unbind' && request.method === 'POST') {
            wallBindings.delete(wallId);
            revokeDemoSessionsForWall(wallId);
            return new Response(null, { status: 204 });
        }
        if (path === '/wall') {
            if (!wallBindings.has(wallId)) {
                return html('<p>Wall is unbound. <a href="/">Go back</a>.</p>');
            }
            const { ticket } = issueDemoLaunch({
                access: 'wall',
                wallId,
                scopeId,
                projectId,
                kind: 'screen',
                slug: 'bitcoin',
                entryPath: '/bitcoin/'
            });
            const launch = `${demoOrigin}/_vizzy/demo-launch/${projectId}/screen?ticket=${ticket}&c=3&r=5`;
            return html(
                `<h1>Fake Vizzy wall</h1><p>Vizzy issued a one-use launch ticket. The iframe below opens it on the demo host.</p><iframe title="wall screen" src="${launch}" style="width:100%;height:360px;border:2px solid #555"></iframe><p><button id="unbind">Unbind wall and reload demo</button></p><p><a href="/">Back</a></p><script>document.querySelector('#unbind').onclick = async () => { await fetch('/unbind', { method: 'POST' }); document.querySelector('iframe').src = '${demoOrigin}/bitcoin/'; };</script>`
            );
        }
        return html(
            `<h1>Local Vizzy → demo simulation</h1><p><a href="/wall">Load bitcoin on wall</a></p><p><a href="${demoOrigin}/bitcoin/" target="_blank">Open demo URL directly</a> (try this first in a private window: 401)</p><button id="reset">Rebind wall</button><script>document.querySelector('#reset').onclick = async () => { await fetch('/reset', { method: 'POST' }); alert('Wall is bound again'); };</script><p>All three servers listen only on 127.0.0.1. No production VM or load balancer is involved.</p>`
        );
    }
});

console.log(`Fake Vizzy UI: ${vizzyOrigin}/`);
console.log(`Gateway/demo URL: ${demoOrigin}/bitcoin/`);
console.log(`Fake demos VM: ${upstreamOrigin}/bitcoin/`);
console.log('Press Ctrl+C to stop all three local servers.');

process.on('SIGINT', () => {
    vizzy.stop();
    gateway.stop();
    fakeDemo.stop();
    process.exit(0);
});
