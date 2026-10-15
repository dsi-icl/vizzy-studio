import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isCustomProject, withoutLegacyCustomUrls } from './customProject';

describe('isCustomProject', () => {
    test('prefers the explicit flag over the legacy URL', () => {
        assert.equal(isCustomProject({ isCustom: true }), true);
        assert.equal(
            isCustomProject({ isCustom: false, customRenderUrl: 'https://demos/x' }),
            false
        );
    });

    test('falls back to the legacy URL for unmigrated documents', () => {
        assert.equal(isCustomProject({ customRenderUrl: 'https://demos/x' }), true);
        assert.equal(isCustomProject({ customRenderUrl: '  ' }), false);
        assert.equal(isCustomProject({ customRenderUrl: null }), false);
        assert.equal(isCustomProject({}), false);
    });
});

describe('withoutLegacyCustomUrls', () => {
    test('strips every pre-/serve demo URL from a client payload', () => {
        // Bound to a variable first: a fresh literal would trip excess property checking.
        const stored = {
            id: 'p1',
            name: 'Custom demo',
            isCustom: true,
            customPort: 3008,
            customRenderUrl: 'https://demos/x/screen',
            customControlUrl: 'https://demos/x/control?token=secret',
            customRenderProxy: true
        };
        const projected = withoutLegacyCustomUrls(stored);

        assert.deepEqual(projected, {
            id: 'p1',
            name: 'Custom demo',
            isCustom: true,
            customPort: 3008
        });
        assert.equal(JSON.stringify(projected).includes('demos'), false);
    });

    test('resolves isCustom for a project that predates the flag', () => {
        assert.equal(
            withoutLegacyCustomUrls({ customRenderUrl: 'https://demos/x/screen' }).isCustom,
            true
        );
        assert.equal(withoutLegacyCustomUrls({ customRenderUrl: '' }).isCustom, false);
        assert.equal(withoutLegacyCustomUrls({}).isCustom, false);
    });

    test('leaves a non-custom project otherwise untouched', () => {
        const stored = { id: 'p2', name: 'Normal', tags: ['a'] };
        assert.deepEqual(withoutLegacyCustomUrls(stored), {
            id: 'p2',
            name: 'Normal',
            tags: ['a'],
            isCustom: false
        });
    });
});
