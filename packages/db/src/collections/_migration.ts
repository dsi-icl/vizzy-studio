import type { Document, UpdateFilter } from 'mongodb';

export function buildMigrationWriteback(
    original: Document,
    migrated: Document,
    version: number
): UpdateFilter<Document> {
    const { _id: _originalId, _version: _originalVersion, ...originalFields } = original;
    const { _id: _migratedId, _version: _migratedVersion, ...migratedFields } = migrated;
    const removedFields = Object.keys(originalFields).filter((key) => !(key in migratedFields));
    const update: UpdateFilter<Document> = {
        $set: { ...migratedFields, _version: version }
    };

    if (removedFields.length > 0) {
        update.$unset = Object.fromEntries(removedFields.map((key) => [key, '']));
    }

    return update;
}
