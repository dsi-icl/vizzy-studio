import type { Document } from 'mongodb';

export function migrateProjectV1ToV2(doc: Document): Document {
    const {
        headCommitId,
        publishedCommitId,
        defaultStageId: legacyDefaultStageId,
        stages: legacyStages,
        ...rest
    } = doc;
    if (Array.isArray(legacyStages) && legacyStages.length > 0) {
        return {
            ...rest,
            defaultStageId:
                typeof legacyDefaultStageId === 'string'
                    ? legacyDefaultStageId
                    : String(legacyStages[0]?.id ?? 'main'),
            stages: legacyStages
        };
    }
    return {
        ...rest,
        defaultStageId: 'main',
        stages: [
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
                headCommitId: headCommitId ?? null,
                publishedCommitId: publishedCommitId ?? null
            }
        ]
    };
}

export function migrateCommitV2ToV3(doc: Document): Document {
    return { ...doc, stageId: 'main' };
}
