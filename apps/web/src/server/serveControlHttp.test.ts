import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { fetchServeControlDocument } from './serveControlHttp';

test('forwards a control document and preserves its redirect', async () => {
    const server = createServer((request, response) => {
        assert.equal(request.headers['x-vizzy-surface'], 'control');
        if (request.url === '/control') {
            response.writeHead(307, { location: '/control?operator=A' }).end();
            return;
        }
        assert.equal(request.url, '/control?operator=A');
        response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Control</h1>');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing test port');
        const base = `http://127.0.0.1:${address.port}`;
        const headers = new Headers({ 'x-vizzy-surface': 'control' });
        const redirect = await fetchServeControlDocument(
            `${base}/control`,
            headers,
            new AbortController().signal
        );
        assert.equal(redirect.status, 307);
        assert.equal(redirect.headers.get('location'), '/control?operator=A');
        const document = await fetchServeControlDocument(
            `${base}/control?operator=A`,
            headers,
            new AbortController().signal
        );
        assert.equal(document.status, 200);
        assert.equal(document.headers.get('content-type'), 'text/html');
        assert.equal(await document.text(), '<h1>Control</h1>');
    } finally {
        server.close();
    }
});

test('cancels a control request when its client disconnects', async () => {
    let requestReceived!: () => void;
    const received = new Promise<void>((resolve) => {
        requestReceived = resolve;
    });
    const server = createServer(() => requestReceived());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing test port');
        const abort = new AbortController();
        const response = fetchServeControlDocument(
            `http://127.0.0.1:${address.port}/control`,
            new Headers(),
            abort.signal
        );
        await received;
        abort.abort();
        await assert.rejects(response, { name: 'AbortError' });
    } finally {
        server.closeAllConnections();
        server.close();
    }
});
