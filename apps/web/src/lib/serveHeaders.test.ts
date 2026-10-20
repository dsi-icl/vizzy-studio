import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    buildForwardedHeaders,
    buildRelayedHeaders,
    SERVE_SURFACE_HEADER,
    SERVE_PUBLIC_BASE_HEADER,
    SERVE_WALL_ID_HEADER
} from './serveHeaders';

const ACTOR = { wallId: 'wall-a', surface: 'wall' };

function request(headers: Record<string, string> = {}): Request {
    return new Request('https://studio.example/serve/abc/screen', { headers });
}

describe('buildForwardedHeaders', () => {
    test('vouches for the verified wall and surface', () => {
        const headers = buildForwardedHeaders(request(), ACTOR);

        assert.equal(headers.get(SERVE_WALL_ID_HEADER), 'wall-a');
        assert.equal(headers.get(SERVE_SURFACE_HEADER), 'wall');
    });

    test('a client cannot forge the identity headers', () => {
        const headers = buildForwardedHeaders(
            request({
                [SERVE_WALL_ID_HEADER]: 'someone-elses-wall',
                [SERVE_SURFACE_HEADER]: 'control'
            }),
            ACTOR
        );

        assert.equal(headers.get(SERVE_WALL_ID_HEADER), 'wall-a');
        assert.equal(headers.get(SERVE_SURFACE_HEADER), 'wall');
    });

    test('public base is issued by the gateway, not accepted from the browser', () => {
        const headers = buildForwardedHeaders(
            request({ [SERVE_PUBLIC_BASE_HEADER]: '/forged' }),
            ACTOR,
            '/serve/project/s/session'
        );
        assert.equal(headers.get(SERVE_PUBLIC_BASE_HEADER), '/serve/project/s/session');
    });

    test('never forwards our own credentials to third-party demo code', () => {
        const headers = buildForwardedHeaders(
            request({
                cookie: 'vizzy_serve_abc=secret',
                authorization: 'Bearer viz_ctrl_secret',
                'x-vizzy-device-signature': 'sig'
            }),
            ACTOR
        );

        assert.equal(headers.get('cookie'), null);
        assert.equal(headers.get('authorization'), null);
        assert.equal(headers.get('x-vizzy-device-signature'), null);
    });

    test('forwards the headers a demo legitimately needs', () => {
        const headers = buildForwardedHeaders(
            request({ accept: 'text/html', range: 'bytes=0-99', 'user-agent': 'wall/1' }),
            ACTOR
        );

        assert.equal(headers.get('accept'), 'text/html');
        assert.equal(headers.get('range'), 'bytes=0-99');
        assert.equal(headers.get('user-agent'), 'wall/1');
        assert.equal(headers.get('x-forwarded-proto'), 'https');
        assert.equal(headers.get('x-forwarded-host'), 'studio.example');
    });
});

describe('buildRelayedHeaders', () => {
    test('drops upstream cookies and framing policy, keeps caching metadata', () => {
        const upstream = new Response('ok', {
            headers: {
                'content-type': 'text/javascript',
                etag: 'W/"1"',
                'cache-control': 'max-age=60',
                'set-cookie': 'demo=1',
                'content-security-policy': "default-src 'none'",
                'x-frame-options': 'DENY',
                'content-encoding': 'gzip',
                'content-length': '2'
            }
        });

        const headers = buildRelayedHeaders(upstream);

        assert.equal(headers.get('content-type'), 'text/javascript');
        assert.equal(headers.get('etag'), 'W/"1"');
        assert.equal(headers.get('cache-control'), 'max-age=60');
        assert.equal(headers.get('set-cookie'), null);
        assert.equal(headers.get('content-security-policy'), null);
        assert.equal(headers.get('x-frame-options'), null);
        assert.equal(headers.get('content-encoding'), null);
        assert.equal(headers.get('content-length'), null);
    });
});
