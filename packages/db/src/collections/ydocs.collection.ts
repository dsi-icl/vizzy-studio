import '@tanstack/react-start/server-only';
import type { Binary, Db } from 'mongodb';
import { ObjectId as OID } from 'mongodb';

import type { YDocDocument } from '../documents';
import { type MigrationMap, type PublicDoc, toEpoch, BaseCollection } from './_base';

export class YDocsCollection extends BaseCollection<YDocDocument> {
    readonly collectionName = 'ydocs';
    readonly currentVersion = 2;

    protected readonly migrations: MigrationMap = {
        0: (doc) => ({
            ...doc,
            createdAt: toEpoch(doc.createdAt ?? Date.now()),
            updatedAt: toEpoch(doc.updatedAt ?? Date.now())
        }),
        1: (doc) => ({ ...doc, revision: doc.revision ?? 0 })
    };

    constructor(db: Db) {
        super(db.collection('ydocs'));
    }

    /** Ensure the unique index on `scope`. Call once at startup. */
    async ensureScopeIndex(): Promise<void> {
        await this.raw.createIndex({ scope: 1 }, { unique: true, name: 'scope_unique' });
    }

    async findByScope(scope: string): Promise<PublicDoc<YDocDocument> | null> {
        return this.findOne({ scope });
    }

    /**
     * Fetch only the `data` binary for a given scope.
     * Uses a projection to avoid transferring the rest of the document.
     */
    async findDataByScope(scope: string): Promise<Binary | null> {
        const doc = await this.raw.findOne({ scope }, { projection: { data: 1 } });
        return doc ? (doc.data as Binary) : null;
    }

    async findStateByScope(scope: string): Promise<{
        data: Binary;
        revision: number;
        stateHash?: string;
        htmlHash?: string;
        sourceTextHash?: string;
        bindingVersion?: string;
        updatedAt: number;
    } | null> {
        const doc = await this.raw.findOne(
            { scope },
            {
                projection: {
                    data: 1,
                    revision: 1,
                    stateHash: 1,
                    htmlHash: 1,
                    sourceTextHash: 1,
                    bindingVersion: 1,
                    updatedAt: 1
                }
            }
        );
        if (!doc?.data) return null;
        return {
            data: doc.data as Binary,
            revision: typeof doc.revision === 'number' ? doc.revision : 0,
            ...(typeof doc.stateHash === 'string' ? { stateHash: doc.stateHash } : {}),
            ...(typeof doc.htmlHash === 'string' ? { htmlHash: doc.htmlHash } : {}),
            ...(typeof doc.sourceTextHash === 'string'
                ? { sourceTextHash: doc.sourceTextHash }
                : {}),
            ...(typeof doc.bindingVersion === 'string'
                ? { bindingVersion: doc.bindingVersion }
                : {}),
            updatedAt: toEpoch(doc.updatedAt ?? 0)
        };
    }

    /**
     * Upsert a ydoc by scope. Stamps `_version` on both insert and update paths.
     * Uses `$setOnInsert` to avoid overwriting `createdAt` on updates.
     */
    async upsertByScope(scope: string, data: Binary): Promise<void> {
        const now = Date.now();
        await this.raw.updateOne(
            { scope },
            {
                $set: { scope, data, updatedAt: now, _version: this.currentVersion },
                $setOnInsert: { _id: new OID(), createdAt: now }
            },
            { upsert: true }
        );
    }

    /** Insert a revisioned snapshot only when no record for the scope exists. */
    async insertStateIfAbsent(
        scope: string,
        state: {
            data: Binary;
            revision: number;
            stateHash: string;
            htmlHash?: string;
            sourceTextHash?: string;
            bindingVersion: string;
        }
    ): Promise<boolean> {
        const now = Date.now();
        try {
            const result = await this.raw.updateOne(
                { scope },
                {
                    $setOnInsert: {
                        _id: new OID(),
                        scope,
                        ...state,
                        createdAt: now,
                        updatedAt: now,
                        _version: this.currentVersion
                    }
                },
                { upsert: true }
            );
            return result.upsertedCount === 1;
        } catch (error) {
            if ((error as { code?: number }).code === 11000) return false;
            throw error;
        }
    }

    /** Replace a snapshot only if its persisted revision has not changed. */
    async replaceStateAtRevision(
        scope: string,
        expectedRevision: number,
        state: {
            data: Binary;
            revision: number;
            stateHash: string;
            htmlHash?: string;
            sourceTextHash?: string;
            bindingVersion: string;
        }
    ): Promise<boolean> {
        const revisionFilter =
            expectedRevision === 0
                ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
                : { revision: expectedRevision };
        const result = await this.raw.updateOne(
            { scope, ...revisionFilter },
            {
                $set: {
                    ...state,
                    updatedAt: Date.now(),
                    _version: this.currentVersion
                }
            }
        );
        return result.modifiedCount === 1;
    }

    /** Delete a ydoc by scope string (used when the associated layer is removed). */
    async deleteByScope(scope: string): Promise<void> {
        await this.raw.deleteOne({ scope });
    }
}
