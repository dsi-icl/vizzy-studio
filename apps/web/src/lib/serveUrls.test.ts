import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    buildServeUpstreamUrl,
    parseServePath,
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
