import '@tanstack/react-start/server-only';
import type { Db, Document } from 'mongodb';

import type { WallDocument } from '../documents';
import { type MigrationMap, type PublicDoc, toEpoch, BaseCollection } from './_base';

export class WallsCollection extends BaseCollection<WallDocument> {
    readonly collectionName = 'walls';
    readonly currentVersion = 2;

    protected readonly migrations: MigrationMap = {
        0: (doc) => ({
            ...doc,
            createdAt: toEpoch(doc.createdAt ?? Date.now()),
            lastSeen: toEpoch(doc.lastSeen ?? Date.now()),
            ...(doc.updatedAt != null ? { updatedAt: toEpoch(doc.updatedAt) } : {})
        }),
        1: (doc) => doc
    };

    constructor(db: Db) {
        super(db.collection('walls'));
    }

    protected fromDB(doc: Document): WallDocument {
        const base = super.fromDB(doc) as unknown as WallDocument & {
            wallId: unknown;
            name: unknown;
            boundProjectId?: unknown;
            boundCommitId?: unknown;
            boundSlideId?: unknown;
        };
        return {
            ...base,
            wallId: typeof base.wallId === 'string' ? base.wallId : String(base.wallId ?? ''),
            name: typeof base.name === 'string' ? base.name : String(base.name ?? ''),
            boundProjectId: base.boundProjectId ? String(base.boundProjectId) : null,
            boundCommitId: base.boundCommitId ? String(base.boundCommitId) : null,
            boundSlideId: base.boundSlideId ? String(base.boundSlideId) : null
        };
    }

    async findByWallId(wallId: string): Promise<PublicDoc<WallDocument> | null> {
        return this.findOne({ wallId });
    }

    /** Returns all wallId strings — used for lightweight stats lookups. */
    async listWallIds(): Promise<string[]> {
        const walls = await this.raw.find({}).project({ wallId: 1 }).toArray();
        return walls
            .map((wall) => wall.wallId)
            .filter((id): id is string => typeof id === 'string');
    }

    async touchLastSeen(wallId: string): Promise<void> {
        const now = Date.now();
        await this.raw.updateOne(
            { wallId },
            { $set: { lastSeen: now, updatedAt: now, _version: this.currentVersion } }
        );
    }

    /**
     * Update fields on a wall identified by its `wallId` string (not `_id`).
     * Stamps `updatedAt` and `_version` automatically.
     * Use for hot-path updates (bind/unbind) where only `wallId` is available.
     */
    async updateByWallId(
        wallId: string,
        fields: Partial<Omit<WallDocument, '_id' | 'id' | 'createdAt' | '_version'>>
    ): Promise<void> {
        await this.raw.updateOne(
            { wallId },
            {
                $set: { ...fields, updatedAt: Date.now(), _version: this.currentVersion }
            }
        );
    }
}
