import { resolve } from 'node:path';

const fixturePath = resolve(import.meta.dir, 'index.html');
const fixtureHtml = await Bun.file(fixturePath).text();

Bun.serve({
    hostname: '0.0.0.0',
    port: 8080,
    fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === '/health') return new Response('ok');
        if (pathname !== '/capture') return new Response('Not Found', { status: 404 });

        return new Response(fixtureHtml, {
            headers: {
                'Cache-Control': 'no-store',
                'Content-Security-Policy':
                    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
                'Content-Type': 'text/html; charset=utf-8',
                'X-Frame-Options': 'DENY',
                'X-Harness-Fixture': 'external-web-capture'
            }
        });
    }
});

console.log('[external-site] deterministic capture fixture listening on :8080');
