import '@tanstack/react-start/server-only';
import type { Db, Document } from 'mongodb';

import type { SignageSlideshowDocument } from '../documents';
import { BaseCollection, type MigrationMap, type PublicDoc, toEpoch } from './_base';

export class SignageSlideshowsCollection extends BaseCollection<SignageSlideshowDocument> {
    readonly collectionName = 'signageSlideshows';
    readonly currentVersion = 1;

    protected readonly migrations: MigrationMap = {
        0: (doc) => ({
            ...doc,
            createdAt: toEpoch(doc.createdAt ?? Date.now()),
            updatedAt: toEpoch(doc.updatedAt ?? Date.now())
        })
    };

    constructor(db: Db) {
        super(db.collection('signageSlideshows'));
    }

    async ensureIndexes(): Promise<void> {
        await this.raw.createIndex(
            { targetWallIds: 1 },
            {
                unique: true,
                name: 'enabled_target_wall_unique',
                partialFilterExpression: {
                    enabled: true,
                    deletedAt: null
                }
            }
        );
    }

    protected fromDB(doc: Document): SignageSlideshowDocument {
        const base = super.fromDB(doc) as SignageSlideshowDocument;
        return {
            ...base,
            collaborators: Array.isArray(base.collaborators) ? base.collaborators : [],
            entries: Array.isArray(base.entries) ? base.entries : [],
            targetWallIds: Array.isArray(base.targetWallIds) ? base.targetWallIds : []
        };
    }

    async findActive(): Promise<PublicDoc<SignageSlideshowDocument>[]> {
        return this.find({ enabled: true, deletedAt: null });
    }

    async findAccessible(
        email: string,
        hasGlobalAccess: boolean
    ): Promise<PublicDoc<SignageSlideshowDocument>[]> {
        return this.find(
            hasGlobalAccess
                ? { deletedAt: null }
                : {
                      deletedAt: null,
                      $or: [{ createdBy: email }, { 'collaborators.email': email }]
                  },
            { sort: { updatedAt: -1 } }
        );
    }

    async findEnabledByTargetWall(
        wallId: string
    ): Promise<PublicDoc<SignageSlideshowDocument> | null> {
        return this.findOne({
            enabled: true,
            deletedAt: null,
            targetWallIds: wallId
        });
    }
}
