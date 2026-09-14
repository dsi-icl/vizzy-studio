import '@tanstack/react-start/server-only';
import type { Db, Document, FindOptions, ObjectId } from 'mongodb';
import { ObjectId as OID } from 'mongodb';

import type { CommitDocument } from '../documents';
import { type MigrationMap, type PublicDoc, toEpoch, BaseCollection } from './_base';
import { migrateCommitV2ToV3 } from './stageMigrations';

type CommitInsertData = Omit<CommitDocument, '_id' | 'id' | 'createdAt' | 'updatedAt' | '_version'>;

export class CommitsCollection extends BaseCollection<CommitDocument> {
    readonly collectionName = 'commits';
    readonly currentVersion = 3;

    protected readonly migrations: MigrationMap = {
        0: (doc) => ({
            ...doc,
            createdAt: toEpoch(doc.createdAt ?? Date.now()),
            ...(doc.updatedAt != null ? { updatedAt: toEpoch(doc.updatedAt) } : {})
        }),
        1: (doc) => doc,
        2: migrateCommitV2ToV3
    };

    constructor(db: Db) {
        super(db.collection('commits'));
    }

    protected fromDB(doc: Document): CommitDocument {
        const base = super.fromDB(doc) as unknown as CommitDocument & {
            projectId: unknown;
            parentId: unknown;
            authorEmail: unknown;
        };
        const rawAuthorEmail =
            typeof base.authorEmail === 'string' && base.authorEmail.trim().length > 0
                ? base.authorEmail.trim()
                : null;
        return {
            ...base,
            projectId: String(base.projectId),
            parentId: base.parentId ? String(base.parentId) : null,
            authorEmail: rawAuthorEmail
        };
    }

    protected toRaw(data: CommitInsertData): Record<string, unknown> {
        const authorEmail =
            typeof data.authorEmail === 'string'
                ? data.authorEmail.trim()
                : (data.authorEmail ?? null);
        return {
            ...data,
            projectId: new OID(data.projectId),
            parentId: data.parentId ? new OID(data.parentId) : null,
            authorEmail: authorEmail && authorEmail.length > 0 ? authorEmail : null
        };
    }

    async findByProject(
        projectId: string | ObjectId,
        options?: FindOptions
    ): Promise<PublicDoc<CommitDocument>[]> {
        return this.find({ projectId: new OID(projectId) }, options);
    }

    async findByProjectStage(
        projectId: string | ObjectId,
        stageId: string,
        options?: FindOptions
    ): Promise<PublicDoc<CommitDocument>[]> {
        const stageFilter =
            stageId === 'main'
                ? { $or: [{ stageId }, { stageId: { $exists: false } }] }
                : { stageId };
        return this.find({ projectId: new OID(projectId), ...stageFilter }, options);
    }

    async findMutableHead(
        projectId: string | ObjectId,
        stageId: string
    ): Promise<PublicDoc<CommitDocument> | null> {
        const stageFilter =
            stageId === 'main'
                ? { $or: [{ stageId }, { stageId: { $exists: false } }] }
                : { stageId };
        return this.findOne({
            projectId: new OID(projectId),
            isMutableHead: true,
            ...stageFilter
        });
    }

    /**
     * Replace `content.slides` in place using dot-notation `$set`.
     * This updates ONLY the slides sub-field without touching other `content` keys.
     * `updatedAt` and `_version` are always stamped.
     */
    /** Point a commit's `parentId` to another commit. Used when creating snapshot/HEAD pointers. */
    async setParent(commitId: string, parentId: string): Promise<void> {
        await this.raw.updateOne(
            { _id: new OID(commitId) },
            { $set: { parentId: new OID(parentId), updatedAt: Date.now() } }
        );
    }

    async updateSlides(
        id: string | ObjectId,
        slides: CommitDocument['content']['slides']
    ): Promise<void> {
        await this.raw.updateOne(
            { _id: new OID(id) },
            {
                $set: {
                    'content.slides': slides,
                    updatedAt: Date.now(),
                    _version: this.currentVersion
                }
            }
        );
    }
}
