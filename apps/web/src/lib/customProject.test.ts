import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isCustomProject } from './customProject';

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
