import { afterEach, mock, test } from 'bun:test';
import assert from 'node:assert/strict';

mock.module('~/server/collections', () => ({ dbCol: {} }));

const { bindWall, unbindWall } = await import('./busState.binding');
const { cancelScopeCleanup } = await import('./busState.persistence');
const { getOrCreateScope, getWallHydratePayload } = await import('./busState.scopes');
const { internScope, wallBindingIds } = await import('./busState.state');
const { GSMessageSchema } = await import('./types');

const wallId = 'serve-rebind-test-wall';
const projectId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const commitId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const scopeId = internScope(projectId, commitId, 'default');

afterEach(() => {
    unbindWall(wallId);
    cancelScopeCleanup(scopeId);
});

test('a same-project rebind tells wall clients their Serve grant changed', () => {
    getOrCreateScope(scopeId, projectId, commitId, 'default', `/serve/${projectId}/screen`);

    bindWall(wallId, scopeId);
    const first = GSMessageSchema.parse(JSON.parse(getWallHydratePayload(scopeId, wallId)));
    assert.equal(first.type, 'hydrate');
    if (first.type !== 'hydrate') return;
    assert.equal(first.projectId, projectId);
    assert.ok(first.bindingId);

    bindWall(wallId, scopeId);
    const second = GSMessageSchema.parse(JSON.parse(getWallHydratePayload(scopeId, wallId)));
    assert.equal(second.type, 'hydrate');
    if (second.type !== 'hydrate') return;
    assert.equal(second.projectId, first.projectId);
    assert.ok(second.bindingId);
    assert.notEqual(second.bindingId, first.bindingId);
    assert.equal(wallBindingIds.get(wallId), second.bindingId);
});
