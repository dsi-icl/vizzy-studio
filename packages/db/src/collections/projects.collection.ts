import '@tanstack/react-start/server-only';
import type { Db } from 'mongodb';
import { ObjectId as OID } from 'mongodb';
import type { Document } from 'mongodb';

import type { ProjectDocument, ProjectStage } from '../documents';
import { type MigrationMap, type PublicDoc, toEpoch, BaseCollection } from './_base';
import { migrateProjectV1ToV2 } from './stageMigrations';

type ProjectInsertData = Omit<
    ProjectDocument,
    '_id' | 'id' | 'createdAt' | 'updatedAt' | '_version'
>;

function stageToRaw(stage: ProjectStage): Record<string, unknown> {
    return {
        ...stage,
        headCommitId: stage.headCommitId ? new OID(stage.headCommitId) : null,
        publishedCommitId: stage.publishedCommitId ? new OID(stage.publishedCommitId) : null
    };
}

export class ProjectsCollection extends BaseCollection<ProjectDocument> {
    readonly collectionName = 'projects';
    readonly currentVersion = 2;

    protected readonly migrations: MigrationMap = {
        0: (doc) => ({
            ...doc,
            createdAt: toEpoch(doc.createdAt ?? Date.now()),
            updatedAt: toEpoch(doc.updatedAt ?? Date.now()),
            ...(doc.deletedAt != null ? { deletedAt: toEpoch(doc.deletedAt) } : {})
        }),
        1: migrateProjectV1ToV2
    };

    constructor(db: Db) {
        super(db.collection('projects'));
    }

    protected fromDB(doc: Document): ProjectDocument {
        const base = super.fromDB(doc) as unknown as ProjectDocument;
        return {
            ...base,
            stages: base.stages.map((stage) => ({
                ...stage,
                headCommitId: stage.headCommitId ? String(stage.headCommitId) : null,
                publishedCommitId: stage.publishedCommitId ? String(stage.publishedCommitId) : null
            }))
        };
    }

    protected toRaw(data: ProjectInsertData): Record<string, unknown> {
        return {
            ...data,
            stages: data.stages.map(stageToRaw)
        };
    }

    async findByUser(
        userEmail: string,
        includeArchived = false
    ): Promise<PublicDoc<ProjectDocument>[]> {
        const filter: Record<string, unknown> = {
            $or: [{ createdBy: userEmail }, { 'collaborators.email': userEmail }]
        };
        if (!includeArchived) filter.deletedAt = { $exists: false };
        return this.find(filter);
    }

    async findPublished(): Promise<PublicDoc<ProjectDocument>[]> {
        const projects = await this.find({
            deletedAt: { $exists: false },
            visibility: 'public',
            $or: [
                { 'stages.publishedCommitId': { $ne: null } },
                { publishedCommitId: { $ne: null } }
            ]
        });
        return projects.filter((project) => {
            const stage = project.stages.find(({ id }) => id === project.defaultStageId);
            return Boolean(stage?.publishedCommitId);
        });
    }

    /**
     * Fetch only the `tags` field for all projects visible to a user.
     * Used to compute the full tag vocabulary without loading whole project documents.
     */
    async findTagsByUser(userEmail: string): Promise<(string[] | null | undefined)[]> {
        const projects = await this.raw
            .find<{ tags?: string[] | null }>(
                { $or: [{ createdBy: userEmail }, { 'collaborators.email': userEmail }] },
                { projection: { tags: 1 } }
            )
            .toArray();
        return projects.map((project) => project.tags);
    }

    /**
     * Fetch the default stage's published commit for all published projects.
     */
    async findPublishedCommitRefs(): Promise<
        { projectId: string; publishedCommitId: string | null }[]
    > {
        const projects = await this.findPublished();
        return projects.map((project) => {
            const stage = project.stages.find(({ id }) => id === project.defaultStageId);
            return {
                projectId: project.id,
                publishedCommitId: stage?.publishedCommitId ?? null
            };
        });
    }

    /** Set a stage's mutable HEAD pointer. Accepts a string commit ID. */
    async setStageHeadCommit(projectId: string, stageId: string, commitId: string): Promise<void> {
        await this.raw.updateOne(
            { _id: new OID(projectId), 'stages.id': stageId },
            {
                $set: {
                    'stages.$[stage].headCommitId': new OID(commitId),
                    updatedAt: Date.now(),
                    _version: this.currentVersion
                }
            },
            { arrayFilters: [{ 'stage.id': stageId }] }
        );
    }

    /** Set (or clear) a stage's published commit pointer. */
    async setStagePublishedCommit(
        projectId: string,
        stageId: string,
        commitId: string | null
    ): Promise<void> {
        await this.raw.updateOne(
            { _id: new OID(projectId), 'stages.id': stageId },
            {
                $set: {
                    'stages.$[stage].publishedCommitId': commitId ? new OID(commitId) : null,
                    updatedAt: Date.now(),
                    _version: this.currentVersion
                }
            },
            { arrayFilters: [{ 'stage.id': stageId }] }
        );
    }

    async replaceStages(
        projectId: string,
        stages: ProjectStage[],
        defaultStageId: string
    ): Promise<PublicDoc<ProjectDocument> | null> {
        const result = await this.raw.findOneAndUpdate(
            { _id: new OID(projectId) },
            {
                $set: {
                    stages: stages.map(stageToRaw),
                    defaultStageId,
                    updatedAt: Date.now(),
                    _version: this.currentVersion
                }
            },
            { returnDocument: 'after' }
        );
        return result ? this.expose(this.fromDB(result)) : null;
    }
}
