import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bindGalleryWallAndWait } from './galleryBindAck';

test('gallery waits for the requested wall binding before opening a custom controller', async () => {
    let onChange:
        | ((change: {
              wallId: string;
              bound: boolean;
              projectId?: string;
              commitId?: string;
          }) => void)
        | null = null;
    let unsubscribed = false;
    const client = {
        sendJSON: (message: { type: 'bind_wall'; wallId: string }) => {
            assert.equal(message.wallId, 'wall-a');
            return true;
        },
        onWallBindingChanged: (callback: NonNullable<typeof onChange>) => {
            onChange = callback;
            return () => {
                unsubscribed = true;
            };
        }
    };
    let settled = false;
    const pending = bindGalleryWallAndWait(client, {
        wallId: 'wall-a',
        projectId: 'project-a',
        commitId: 'commit-a'
    }).then(() => {
        settled = true;
    });
    onChange!({ wallId: 'wall-a', bound: true, projectId: 'project-a', commitId: 'older' });
    await Promise.resolve();
    assert.equal(settled, false);
    onChange!({ wallId: 'wall-a', bound: true, projectId: 'project-a', commitId: 'commit-a' });
    await pending;
    assert.equal(unsubscribed, true);
});

test('gallery reports a bind that was not sent to its socket', async () => {
    let unsubscribed = false;
    await assert.rejects(
        bindGalleryWallAndWait(
            {
                sendJSON: () => false,
                onWallBindingChanged: () => () => {
                    unsubscribed = true;
                }
            },
            { wallId: 'wall-a', projectId: 'project-a', commitId: 'commit-a' }
        ),
        /Gallery connection is not ready/
    );
    assert.equal(unsubscribed, true);
});

test('gallery stops waiting when the server never confirms the binding', async () => {
    let unsubscribed = false;
    await assert.rejects(
        bindGalleryWallAndWait(
            {
                sendJSON: () => true,
                onWallBindingChanged: () => () => {
                    unsubscribed = true;
                }
            },
            { wallId: 'wall-a', projectId: 'project-a', commitId: 'commit-a' },
            1
        ),
        /Timed out waiting for the wall to load this project/
    );
    assert.equal(unsubscribed, true);
});
