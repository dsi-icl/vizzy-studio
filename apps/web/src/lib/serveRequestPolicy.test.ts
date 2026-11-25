import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    addServeCorsHeaders,
    isAllowedServeRequest,
    servePreflightResponse
} from './serveRequestPolicy';

const PROJECT = '507f1f77bcf86cd799439011';
const SESSION = 'AAAAAAAAAAAAAAAAAAAAAA';

function preflight(path: string, requestedHeaders: string, method = 'POST'): Response | null {
    return servePreflightResponse(
        new Request(`https://studio.example/serve/${PROJECT}${path}?__vizzySession=${SESSION}`, {
            method: 'OPTIONS',
            headers: {
                Origin: 'null',
                'Access-Control-Request-Method': method,
                'Access-Control-Request-Headers': requestedHeaders
            }
        })
    );
}

describe('opaque-origin demo preflight', () => {
    test('leaves an ordinary Tus OPTIONS request for the upstream', () => {
        const request = new Request(
            `https://studio.example/serve/${PROJECT}/api/uploads/?__vizzySession=${SESSION}`,
            { method: 'OPTIONS', headers: { Origin: 'null', 'Tus-Resumable': '1.0.0' } }
        );
        assert.equal(servePreflightResponse(request), null);
        assert.equal(preflight('/api/uploads/', 'tus-resumable', 'OPTIONS')?.status, 204);
    });

    test('permits Tus headers only on the upload route', () => {
        const upload = preflight(
            '/api/uploads/',
            'content-type,tus-resumable,upload-length,upload-metadata'
        );
        assert.equal(upload?.status, 204);
        assert.match(upload?.headers.get('access-control-allow-headers') ?? '', /tus-resumable/);

        assert.equal(preflight('/control', 'tus-resumable')?.status, 403);
        assert.equal(preflight('/api/uploads/', 'authorization')?.status, 403);
    });

    test('permits the wall control header only on media operations', () => {
        assert.equal(preflight('/api/media/asset-1', 'x-wall-control')?.status, 204);
        assert.equal(preflight('/control', 'x-wall-control')?.status, 403);
    });

    test('exposes the upload location and offset to the Tus client', () => {
        const request = new Request(
            `https://studio.example/serve/${PROJECT}/api/uploads/?__vizzySession=${SESSION}`,
            { headers: { Origin: 'null' } }
        );
        const headers = new Headers();
        addServeCorsHeaders(request, headers);
        assert.equal(headers.get('access-control-allow-origin'), 'null');
        assert.match(headers.get('access-control-expose-headers') ?? '', /Location/);
        assert.match(headers.get('access-control-expose-headers') ?? '', /Upload-Offset/);
    });
});

describe('opaque-origin static subresources', () => {
    const origin = 'https://studio.example';
    function request(path: string, destination: string, method = 'GET') {
        return new Request(`${origin}/serve/${PROJECT}${path}`, {
            method,
            headers: { Origin: 'null', 'Sec-Fetch-Dest': destination }
        });
    }

    test('allows nested public files used by embedded demos', () => {
        for (const [path, destination] of [
            ['/observatory/src/main.js', 'script'],
            ['/observatory/src/styles.css', 'style'],
            ['/rio-tinto/assets/riologo.svg', 'image'],
            ['/rio-tinto/assets/audio.m4a', 'audio'],
            ['/pages/sustainability.png', 'image']
        ]) {
            const candidate = request(path, destination);
            assert.equal(isAllowedServeRequest(candidate, origin), true, path);
            const headers = new Headers();
            addServeCorsHeaders(candidate, headers);
            assert.equal(headers.get('access-control-allow-origin'), 'null', path);
        }
    });

    test('requires a selector for JSON, documents, writes and mismatched destinations', () => {
        for (const [path, destination, method] of [
            ['/network/powering-data.json', 'empty', 'GET'],
            ['/rio-tinto/index.html', 'iframe', 'GET'],
            ['/api/media/file.png', 'image', 'DELETE'],
            ['/api/status', 'image', 'GET'],
            ['/other/file.js', 'script', 'GET'],
            ['/rio-tinto/assets/audio.m4a', 'script', 'GET']
        ]) {
            assert.equal(isAllowedServeRequest(request(path, destination, method), origin), false);
        }
    });
});
