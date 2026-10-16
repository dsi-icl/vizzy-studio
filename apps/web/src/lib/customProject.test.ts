import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isCustomProject, withoutLegacyCustomUrls } from './customProject';

describe('isCustomProject', () => {
    test('a configured port makes a project custom', () => {
        assert.equal(isCustomProject({ customPort: 3008 }), true);
    });

    test('anything else is a normal project', () => {
        assert.equal(isCustomProject({ customPort: null }), false);
        assert.equal(isCustomProject({}), false);
    });
});

describe('withoutLegacyCustomUrls', () => {
    test('strips every pre-/serve demo URL from a client payload', () => {
        const stored = {
            id: 'p1',
            name: 'Custom demo',
            customPort: 3008,
            customRenderUrl: 'https://demos/x/screen',
            customControlUrl: 'https://demos/x/control?token=secret',
            customRenderProxy: true
        };
        const projected = withoutLegacyCustomUrls(stored);

        assert.deepEqual(projected, { id: 'p1', name: 'Custom demo', customPort: 3008 });
        assert.equal(JSON.stringify(projected).includes('demos/x'), false);
    });

    test('keeps customPort so the client resolves customness the same way the server does', () => {
        const stored = { customPort: 3008, customRenderUrl: 'https://demos/x/screen' };
        assert.equal(isCustomProject(withoutLegacyCustomUrls(stored)), true);
    });

    test('leaves a non-custom project otherwise untouched', () => {
        const stored = { id: 'p2', name: 'Normal', tags: ['a'] };
        assert.deepEqual(withoutLegacyCustomUrls(stored), {
            id: 'p2',
            name: 'Normal',
            tags: ['a']
        });
    });
});
