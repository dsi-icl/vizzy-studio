import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildMigrationWriteback } from './_migration';

describe('buildMigrationWriteback', () => {
    test('sets migrated fields and unsets fields removed by the migration', () => {
        const id = 'project-id';
        const original = {
            _id: id,
            _version: 1,
            name: 'Project',
            headCommitId: 'head-id',
            publishedCommitId: null
        };
        const migrated = {
            _id: id,
            _version: 1,
            name: 'Project',
            defaultStageId: 'main',
            stages: []
        };

        assert.deepEqual(buildMigrationWriteback(original, migrated, 2), {
            $set: {
                name: 'Project',
                defaultStageId: 'main',
                stages: [],
                _version: 2
            },
            $unset: {
                headCommitId: '',
                publishedCommitId: ''
            }
        });
    });

    test('does not emit an empty unset operator', () => {
        const id = 'project-id';
        const original = { _id: id, _version: 0, name: 'Project' };
        const migrated = { ...original, createdAt: 1 };

        assert.deepEqual(buildMigrationWriteback(original, migrated, 1), {
            $set: {
                name: 'Project',
                createdAt: 1,
                _version: 1
            }
        });
    });
});
