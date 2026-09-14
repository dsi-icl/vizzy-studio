import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { migrateCommitV2ToV3, migrateProjectV1ToV2 } from './stageMigrations';

describe('stage migrations', () => {
    test('moves legacy project pointers into a Main stage and removes the roots', () => {
        const migrated = migrateProjectV1ToV2({
            _id: 'project-id',
            headCommitId: 'head-id',
            publishedCommitId: 'published-id',
            name: 'Project'
        });

        assert.equal(migrated.headCommitId, undefined);
        assert.equal(migrated.publishedCommitId, undefined);
        assert.equal(migrated.defaultStageId, 'main');
        assert.deepEqual(migrated.stages, [
            {
                id: 'main',
                name: 'Main',
                order: 0,
                layout: {
                    columns: 16,
                    rows: 4,
                    screenWidth: 1920,
                    screenHeight: 1080
                },
                headCommitId: 'head-id',
                publishedCommitId: 'published-id'
            }
        ]);
    });

    test('assigns legacy commits to Main', () => {
        assert.deepEqual(migrateCommitV2ToV3({ _id: 'commit-id', projectId: 'project-id' }), {
            _id: 'commit-id',
            projectId: 'project-id',
            stageId: 'main'
        });
    });
});
