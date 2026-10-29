import '@tanstack/react-start/server-only';
import type { ClientSession, Db, Document, FindOptions, ObjectId } from 'mongodb';
import { ObjectId as OID } from 'mongodb';

import type { AssetDocument } from '../documents';
import type { ImageDeepZoomAsset } from '../schema';
import { type MigrationMap, type PublicDoc, toEpoch, BaseCollection } from './_base';

type AssetInsertData = Omit<AssetDocument, '_id' | 'id' | 'createdAt' | 'updatedAt' | '_version'>;

export class AssetsCollection extends BaseCollection<AssetDocument> {
    readonly collectionName = 'assets';
    readonly currentVersion = 1;

    protected readonly migrations: MigrationMap = {
        0: (doc) => ({
            ...doc,
            createdAt: toEpoch(doc.createdAt ?? Date.now()),
            ...(doc.updatedAt != null ? { updatedAt: toEpoch(doc.updatedAt) } : {}),
            ...(doc.deletedAt != null ? { deletedAt: toEpoch(doc.deletedAt) } : {})
        })
    };

    constructor(db: Db) {
        super(db.collection('assets'));
    }

    /** Only the transactional tiled-upload path supplies a deterministic id. */
    async insertDeepZoomUpload(id: string, data: AssetInsertData, session: ClientSession) {
        const now = Date.now();
        const doc = {
            _id: new OID(id),
            ...this.toRaw(data),
            deepZoomJobId: id,
            createdAt: now,
            updatedAt: now,
            _version: this.currentVersion
        };
        await this.raw.insertOne(doc, { session });
        return this.expose(this.fromDB(doc));
    }

    async findDeepZoomUpload(id: string, session?: ClientSession) {
        const record = await this.raw.findOne(
            { _id: new OID(id), deepZoomJobId: id, deepZoom: { $exists: true } },
            { session }
        );
        return record ? this.expose(this.fromDB(record)) : null;
    }

    /** The caller fences this update with the matching job lease in the same transaction. */
    async updateDeepZoomJob(
        id: string,
        deepZoom: ImageDeepZoomAsset,
        fields: { previewUrl?: string; blurhash?: string },
        session: ClientSession
    ) {
        const result = await this.raw.updateOne(
            {
                _id: new OID(id),
                deepZoomJobId: id,
                deletedAt: { $exists: false },
                'deepZoom.status': { $ne: 'ready' }
            },
            { $set: { deepZoom, ...fields, updatedAt: Date.now() } },
            { session }
        );
        return result.matchedCount === 1;
    }

    protected fromDB(doc: Document): AssetDocument {
        const base = super.fromDB(doc) as unknown as AssetDocument & { projectId: unknown };
        return {
            ...base,
            projectId: String(base.projectId)
        };
    }

    protected toRaw(data: AssetInsertData): Record<string, unknown> {
        return {
            ...data,
            projectId: new OID(data.projectId)
        };
    }

    async findByProject(
        projectId: string | ObjectId,
        includeDeleted = false,
        options?: FindOptions
    ): Promise<PublicDoc<AssetDocument>[]> {
        const filter: Record<string, unknown> = {
            projectId: new OID(projectId),
            hidden: { $ne: true }
        };
        if (!includeDeleted) filter.deletedAt = { $exists: false };
        return this.find(filter, options);
    }

    async findPublic(
        includeDeleted = false,
        options?: FindOptions
    ): Promise<PublicDoc<AssetDocument>[]> {
        const filter: Record<string, unknown> = { public: true, hidden: { $ne: true } };
        if (!includeDeleted) filter.deletedAt = { $exists: false };
        return this.find(filter, options);
    }

    async findByProjectOrPublicUrls(
        projectId: string | ObjectId,
        urls: string[],
        includeDeleted = false
    ): Promise<PublicDoc<AssetDocument>[]> {
        if (urls.length === 0) return [];
        const filter: Record<string, unknown> = {
            $and: [
                {
                    $or: [
                        { url: { $in: urls } },
                        { deepZoom: { $exists: true }, previewUrl: { $in: urls } }
                    ]
                }
            ],
            hidden: { $ne: true },
            $or: [{ projectId: new OID(projectId) }, { public: true }]
        };
        if (!includeDeleted) filter.deletedAt = { $exists: false };
        const records = await this.raw.find(filter).toArray();
        return records.map((r) => this.expose(this.fromDB(r)));
    }

    /**
     * Fetch blurhash and sizes metadata for a list of asset URLs.
     * Projection-only query — avoids loading full asset documents for hero image display.
     */
    async findBlurhashMetaByUrls(
        urls: string[]
    ): Promise<{ url: string; blurhash?: string | null; sizes?: number[] | null }[]> {
        if (urls.length === 0) return [];
        return this.raw
            .find<{ url: string; blurhash?: string | null; sizes?: number[] | null }>(
                { url: { $in: urls }, deletedAt: { $exists: false } },
                { projection: { url: 1, blurhash: 1, sizes: 1 } }
            )
            .toArray();
    }

    /**
     * Hard-delete an asset record by URL.
     * @deprecated Only for web-screenshot cleanup where a hidden placeholder record
     * must be fully removed. All other asset deletions must use `softDelete()`.
     */
    async hardDeleteByUrl(url: string): Promise<void> {
        await this.raw.deleteOne({ url });
    }
}
