import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    buildServeUpstreamUrl,
    parseServePath,
    rewriteServeLocation,
    serveBasePath,
    serveBusPath,
    serveControlPath,
    serveWallPath
} from './serveUrls';

const PID = '507f1f77bcf86cd799439011';

describe('serve paths', () => {
    test('derives each surface from the project id', () => {
        assert.equal(serveBasePath(PID), `/serve/${PID}`);
        assert.equal(serveWallPath(PID), `/serve/${PID}/screen`);
        assert.equal(serveControlPath(PID), `/serve/${PID}/control`);
        assert.equal(serveBusPath(PID), `/serve/${PID}/bus`);
    });

    test('splits a serve path into project id and remainder', () => {
        assert.deepEqual(parseServePath(`/serve/${PID}/screen`), {
            projectId: PID,
            rest: '/screen'
        });
        assert.deepEqual(parseServePath(`/serve/${PID}/assets/app.js`), {
            projectId: PID,
            rest: '/assets/app.js'
        });
        assert.deepEqual(parseServePath(`/serve/${PID}`), { projectId: PID, rest: '/' });
        assert.deepEqual(parseServePath(`/serve/${PID}/`), { projectId: PID, rest: '/' });
    });

    test('rejects anything that is not a well-formed serve path', () => {
        assert.equal(parseServePath('/serve'), null);
        assert.equal(parseServePath('/serve/'), null);
        assert.equal(parseServePath('/assets/app.js'), null);
        assert.equal(parseServePath('/serve/not-an-object-id/screen'), null);
        assert.equal(parseServePath(`/serve/${PID}x/screen`), null);
        assert.equal(parseServePath(`/serve/${PID}/../../etc/passwd`), null);
    });

    test('builds the upstream URL without touching the path', () => {
        assert.equal(
            buildServeUpstreamUrl({
                host: 'demos.com',
                port: 3008,
                pathname: `/serve/${PID}/assets/app.js`,
                search: '?v=2'
            }),
            `http://demos.com:3008/serve/${PID}/assets/app.js?v=2`
        );
    });
});

describe('rewriteServeLocation', () => {
    const UPSTREAM = `http://demos.example:3008/serve/${PID}/screen`;
    const BASE = `/serve/${PID}`;

    test('keeps a redirect that already carries the base path', () => {
        assert.equal(
            rewriteServeLocation(`/serve/${PID}/control`, UPSTREAM, BASE),
            `/serve/${PID}/control`
        );
    });

    test('prefixes a root-absolute redirect that escaped the subtree', () => {
        assert.equal(rewriteServeLocation('/control', UPSTREAM, BASE), `/serve/${PID}/control`);
        assert.equal(rewriteServeLocation('/', UPSTREAM, BASE), `/serve/${PID}/`);
    });

    test('resolves a relative redirect against the request URL, not just the origin', () => {
        assert.equal(rewriteServeLocation('control', UPSTREAM, BASE), `/serve/${PID}/control`);
    });

    test('never discloses the demos host', () => {
        assert.equal(
            rewriteServeLocation(`http://demos.example:3008/serve/${PID}/x?a=1#f`, UPSTREAM, BASE),
            `/serve/${PID}/x?a=1#f`
        );
    });

    test('refuses anything but the demo redirecting within itself', () => {
        assert.equal(rewriteServeLocation('https://cdn.example/asset.js', UPSTREAM, BASE), null);
        assert.equal(rewriteServeLocation('//evil.example/x', UPSTREAM, BASE), null);
        assert.equal(rewriteServeLocation('http://', UPSTREAM, BASE), null);
    });

    test('cannot redirect the iframe at one of our own routes', () => {
        assert.equal(
            rewriteServeLocation('/api/portal/v1/bind', UPSTREAM, BASE),
            `/serve/${PID}/api/portal/v1/bind`
        );
    });
});
