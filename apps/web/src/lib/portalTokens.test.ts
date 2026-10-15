import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    createPortalToken,
    revokePortalToken,
    revokePortalTokensForWall,
    validatePortalToken
} from './portalTokens';

describe('portal token surfaces', () => {
    test('validates against the surface it was minted for', () => {
        const { token } = createPortalToken('wall-a', 1, 'control');

        assert.equal(validatePortalToken(token, 'control')?.wallId, 'wall-a');
        revokePortalToken(token);
    });

    test('rejects a wall token on the control surface', () => {
        const { token } = createPortalToken('wall-b', 2, 'wall');

        assert.equal(validatePortalToken(token, 'control'), null);
        assert.equal(validatePortalToken(token, 'wall')?.wallId, 'wall-b');
        revokePortalToken(token);
    });

    test('rejects a control token on the wall surface', () => {
        const { token } = createPortalToken('wall-c', 3, 'control');

        assert.equal(validatePortalToken(token, 'wall'), null);
        revokePortalToken(token);
    });

    test('revoking a wall clears both of its surfaces', () => {
        const control = createPortalToken('wall-d', 4, 'control');
        const wall = createPortalToken('wall-d', 4, 'wall');

        revokePortalTokensForWall('wall-d');

        assert.equal(validatePortalToken(control.token, 'control'), null);
        assert.equal(validatePortalToken(wall.token, 'wall'), null);
    });

    test('an unknown token is rejected on every surface', () => {
        assert.equal(validatePortalToken('viz_ctrl_nope', 'control'), null);
        assert.equal(validatePortalToken('viz_ctrl_nope', 'wall'), null);
    });
});
