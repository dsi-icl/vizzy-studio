import '@tanstack/react-start/server-only';
import type { Db, Document, FindOptions, ObjectId } from 'mongodb';
import { ObjectId as OID } from 'mongodb';

import type { AuditLogDocument, AuditResourceType } from '../documents';
import { type MigrationMap, type PublicDoc, toEpoch, BaseCollection } from './_base';

type AuditOutcome = AuditLogDocument['outcome'];

export interface AuditQueryCursor {
    createdAt: number;
    id: string;
}

export interface AuditProjectQueryInput {
    projectId: string;
    limit?: number;
    cursor?: AuditQueryCursor | null;
    outcomes?: AuditOutcome[];
    actions?: string[];
    actorIds?: string[];
    resourceTypes?: AuditResourceType[];
    reasonCodes?: string[];
    operation?: string;
    surface?: NonNullable<NonNullable<AuditLogDocument['executionContext']>['surface']>;
    fromCreatedAt?: number;
    toCreatedAt?: number;
}

export interface AuditProjectQueryResult {
    items: PublicDoc<AuditLogDocument>[];
    nextCursor: AuditQueryCursor | null;
}

export interface AuditGlobalQueryInput {
    projectId?: string | null;
    limit?: number;
    cursor?: AuditQueryCursor | null;
    outcomes?: AuditOutcome[];
    actions?: string[];
    actorIds?: string[];
    resourceTypes?: AuditResourceType[];
    reasonCodes?: string[];
    operation?: string;
    surface?: NonNullable<NonNullable<AuditLogDocument['executionContext']>['surface']>;
    fromCreatedAt?: number;
    toCreatedAt?: number;
}

export class AuditsCollection extends BaseCollection<AuditLogDocument> {
    readonly collectionName = 'audits';
    readonly currentVersion = 2;
    private indexesReady: Promise<void> | null = null;

    protected readonly migrations: MigrationMap = {
        0: (doc) => ({
            ...doc,
            createdAt: toEpoch(doc.createdAt ?? Date.now())
        })
    };

    constructor(db: Db) {
        super(db.collection('audits'));
    }

    private ensureIndexes(): Promise<void> {
        if (!this.indexesReady) {
            this.indexesReady = this.raw
                .createIndexes([
                    {
                        key: { projectId: 1, createdAt: -1, _id: -1 },
                        name: 'audits_project_createdAt_desc'
                    },
                    {
                        key: { projectId: 1, action: 1, createdAt: -1 },
                        name: 'audits_project_action_createdAt_desc'
                    },
                    {
                        key: { projectId: 1, outcome: 1, createdAt: -1 },
                        name: 'audits_project_outcome_createdAt_desc'
                    },
                    {
                        key: { projectId: 1, resourceType: 1, createdAt: -1 },
                        name: 'audits_project_resourceType_createdAt_desc'
                    },
                    {
                        key: { projectId: 1, 'executionContext.operation': 1, createdAt: -1 },
                        name: 'audits_project_operation_createdAt_desc'
                    },
                    {
                        key: { createdAt: -1, _id: -1 },
                        name: 'audits_createdAt_desc'
                    },
                    {
                        key: { outcome: 1, createdAt: -1 },
                        name: 'audits_outcome_createdAt_desc'
                    },
                    {
                        key: { resourceType: 1, createdAt: -1 },
                        name: 'audits_resourceType_createdAt_desc'
                    },
                    {
                        key: { 'executionContext.surface': 1, createdAt: -1 },
                        name: 'audits_surface_createdAt_desc'
                    },
                    {
                        key: { expireAt: 1 },
                        name: 'audits_expireAt_ttl',
                        expireAfterSeconds: 0
                    }
                ])
                .then(() => {})
                .catch((error) => {
                    this.indexesReady = null;
                    throw error;
                });
        }
        return this.indexesReady;
    }

    protected override toRaw(data: any): Record<string, any> {
        const raw = super.toRaw(data);
        return {
            ...raw,
            expireAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
        };
    }

    protected fromDB(doc: Document): AuditLogDocument {
        const base = super.fromDB(doc) as unknown as AuditLogDocument & { projectId: unknown };
        return {
            ...base,
            projectId: base.projectId ? String(base.projectId) : null
        };
    }

    async findByProject(
        projectId: string | ObjectId,
        options?: FindOptions
    ): Promise<PublicDoc<AuditLogDocument>[]> {
        await this.ensureIndexes();
        return this.find({ projectId: new OID(projectId) }, options);
    }

    async queryByProject(input: AuditProjectQueryInput): Promise<AuditProjectQueryResult> {
        await this.ensureIndexes();

        const limit = Math.max(1, Math.min(input.limit ?? 100, 250));
        const filter: Document = {
            projectId: new OID(input.projectId)
        };

        if (input.outcomes && input.outcomes.length > 0) {
            filter.outcome = { $in: input.outcomes };
        }
        if (input.actions && input.actions.length > 0) {
            filter.action = { $in: input.actions };
        }
        if (input.actorIds && input.actorIds.length > 0) {
            filter.actorId = { $in: input.actorIds };
        }
        if (input.resourceTypes && input.resourceTypes.length > 0) {
            filter.resourceType = { $in: input.resourceTypes };
        }
        if (input.reasonCodes && input.reasonCodes.length > 0) {
            filter.reasonCode = { $in: input.reasonCodes };
        }
        if (input.operation && input.operation.trim().length > 0) {
            filter['executionContext.operation'] = input.operation.trim();
        }
        if (input.surface) {
            filter['executionContext.surface'] = input.surface;
        }
        if (input.fromCreatedAt || input.toCreatedAt) {
            filter.createdAt = {
                ...(input.fromCreatedAt ? { $gte: input.fromCreatedAt } : {}),
                ...(input.toCreatedAt ? { $lte: input.toCreatedAt } : {})
            };
        }

        if (input.cursor?.createdAt && input.cursor?.id) {
            const cursorCreatedAt = input.cursor.createdAt;
            const cursorId = new OID(input.cursor.id);
            filter.$or = [
                { createdAt: { $lt: cursorCreatedAt } },
                { createdAt: cursorCreatedAt, _id: { $lt: cursorId } }
            ];
        }

        const docs = await this.raw
            .find(filter, { sort: { createdAt: -1, _id: -1 }, limit: limit + 1 })
            .toArray();

        const hasMore = docs.length > limit;
        const pageDocs = hasMore ? docs.slice(0, limit) : docs;
        const items = pageDocs.map((doc) => this.expose(this.fromDB(doc)));
        const next = pageDocs[pageDocs.length - 1];

        return {
            items,
            nextCursor:
                hasMore && next
                    ? {
                          createdAt: Number(next.createdAt ?? 0),
                          id: String(next._id)
                      }
                    : null
        };
    }

    async queryGlobal(input: AuditGlobalQueryInput): Promise<AuditProjectQueryResult> {
        await this.ensureIndexes();

        const limit = Math.max(1, Math.min(input.limit ?? 100, 250));
        const filter: Document = {};

        if (input.projectId) {
            filter.projectId = new OID(input.projectId);
        }
        if (input.outcomes && input.outcomes.length > 0) {
            filter.outcome = { $in: input.outcomes };
        }
        if (input.actions && input.actions.length > 0) {
            filter.action = { $in: input.actions };
        }
        if (input.actorIds && input.actorIds.length > 0) {
            filter.actorId = { $in: input.actorIds };
        }
        if (input.resourceTypes && input.resourceTypes.length > 0) {
            filter.resourceType = { $in: input.resourceTypes };
        }
        if (input.reasonCodes && input.reasonCodes.length > 0) {
            filter.reasonCode = { $in: input.reasonCodes };
        }
        if (input.operation && input.operation.trim().length > 0) {
            filter['executionContext.operation'] = input.operation.trim();
        }
        if (input.surface) {
            filter['executionContext.surface'] = input.surface;
        }
        if (input.fromCreatedAt || input.toCreatedAt) {
            filter.createdAt = {
                ...(input.fromCreatedAt ? { $gte: input.fromCreatedAt } : {}),
                ...(input.toCreatedAt ? { $lte: input.toCreatedAt } : {})
            };
        }

        if (input.cursor?.createdAt && input.cursor?.id) {
            const cursorCreatedAt = input.cursor.createdAt;
            const cursorId = new OID(input.cursor.id);
            filter.$or = [
                { createdAt: { $lt: cursorCreatedAt } },
                { createdAt: cursorCreatedAt, _id: { $lt: cursorId } }
            ];
        }

        const docs = await this.raw
            .find(filter, { sort: { createdAt: -1, _id: -1 }, limit: limit + 1 })
            .toArray();

        const hasMore = docs.length > limit;
        const pageDocs = hasMore ? docs.slice(0, limit) : docs;
        const items = pageDocs.map((doc) => this.expose(this.fromDB(doc)));
        const next = pageDocs[pageDocs.length - 1];

        return {
            items,
            nextCursor:
                hasMore && next
                    ? {
                          createdAt: Number(next.createdAt ?? 0),
                          id: String(next._id)
                      }
                    : null
        };
    }

    /**
     * Audit logs are append-only — no updates or soft-deletes.
     * Override insert to skip the `updatedAt` stamp that the base would add.
     */
    async insertLog(
        data: Omit<AuditLogDocument, '_id' | 'id' | 'createdAt' | '_version'>
    ): Promise<PublicDoc<AuditLogDocument>> {
        await this.ensureIndexes();
        const doc = {
            _id: new OID(),
            createdAt: Date.now(),
            _version: this.currentVersion,
            ...data,
            projectId: data.projectId ? new OID(data.projectId) : null
        };
        await this.raw.insertOne(doc);
        return this.expose(this.fromDB(doc));
    }
}
