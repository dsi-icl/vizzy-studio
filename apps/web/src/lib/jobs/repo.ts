import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { db } from '@repo/db';
import type { AssetDocument } from '@repo/db/documents';
import type { ImageDeepZoomAsset } from '@repo/db/schema';
import { ObjectId, type ClientSession } from 'mongodb';

import { dbCol, collections } from '~/server/collections';

import { PUBLIC_ASSET_PROJECT_ID } from '../constants';
import { ASSET_DIR } from '../serverVariables';
import type { ImageTileSettings } from './imageTileRuntime';
import type {
    JobDocument,
    JobPayload,
    JobResult,
    JobType,
    ProcessImageTilesPayload,
    ProcessImageTilesResult
} from './types';

const LEASE_MS = 30_000;
const RETRY_BACKOFF_MS = 5_000;

let indexesReady = false;

export async function ensureJobIndexes() {
    if (indexesReady) return;
    await collections.jobs.createIndexes([
        {
            key: { nodeId: 1, status: 1, runAfter: 1, createdAt: 1 },
            name: 'nodeId_status_runAfter_createdAt'
        },
        { key: { leaseUntil: 1 }, name: 'leaseUntil' },
        { key: { updatedAt: 1 }, name: 'updatedAt' }
    ]);
    indexesReady = true;
}

export async function enqueueJob({
    nodeId,
    type,
    payload,
    maxAttempts = 3,
    id = new ObjectId(),
    session
}: {
    nodeId: string;
    type: JobType;
    payload: JobPayload;
    maxAttempts?: number;
    id?: ObjectId;
    session?: ClientSession;
}) {
    const now = new Date();
    const doc: JobDocument = {
        _id: id,
        nodeId,
        type,
        status: 'queued' as const,
        payload,
        attempts: 0,
        maxAttempts,
        runAfter: now,
        createdAt: now,
        updatedAt: now
    };
    const inserted = await collections.jobs.insertOne(doc, { session });
    return inserted.insertedId;
}

export async function getJobById(jobId: ObjectId) {
    return collections.jobs.findOne({ _id: jobId });
}

export async function claimNextJob(
    workerId: string,
    nodeId: string,
    types: JobType[] = ['process_image_asset', 'process_video_asset']
) {
    const now = new Date();
    const claimed = await collections.jobs.findOneAndUpdate(
        {
            nodeId,
            type: { $in: types },
            status: 'queued',
            runAfter: { $lte: now }
        },
        {
            $set: {
                status: 'running',
                leaseOwner: workerId,
                leaseUntil: new Date(now.getTime() + LEASE_MS),
                startedAt: now,
                lastHeartbeatAt: now,
                updatedAt: now
            },
            $inc: { attempts: 1 }
        },
        {
            sort: { createdAt: 1 },
            returnDocument: 'after'
        }
    );
    return claimed;
}

export async function heartbeatJob(
    jobId: ObjectId,
    workerId: string,
    progress?: number,
    requireLiveLease = false
) {
    const now = new Date();
    const result = await collections.jobs.updateOne(
        {
            _id: jobId,
            status: 'running',
            leaseOwner: workerId,
            ...(requireLiveLease ? { leaseUntil: { $gt: now } } : {})
        },
        {
            $set: {
                leaseUntil: new Date(now.getTime() + LEASE_MS),
                lastHeartbeatAt: now,
                ...(typeof progress === 'number' ? { lastProgressAt: now } : {}),
                updatedAt: now
            }
        }
    );
    return result.matchedCount === 1;
}

export async function completeJob(jobId: ObjectId, workerId: string, result: JobResult) {
    const now = new Date();
    await collections.jobs.updateOne(
        { _id: jobId, status: 'running', leaseOwner: workerId },
        {
            $set: {
                status: 'completed',
                result,
                completedAt: now,
                updatedAt: now
            },
            $unset: { leaseOwner: '', leaseUntil: '' }
        }
    );
}

export async function failJob(jobId: ObjectId, workerId: string, error: string) {
    const now = new Date();
    const current = await collections.jobs.findOne({ _id: jobId });
    if (!current) return;

    const shouldRetry = current.attempts < current.maxAttempts;
    await collections.jobs.updateOne(
        { _id: jobId, status: 'running', leaseOwner: workerId },
        shouldRetry
            ? {
                  $set: {
                      status: 'queued',
                      error,
                      runAfter: new Date(now.getTime() + RETRY_BACKOFF_MS * current.attempts),
                      updatedAt: now
                  },
                  $unset: { leaseOwner: '', leaseUntil: '', startedAt: '' }
              }
            : {
                  $set: {
                      status: 'failed',
                      error,
                      completedAt: now,
                      updatedAt: now
                  },
                  $unset: { leaseOwner: '', leaseUntil: '' }
              }
    );
}

export async function markStalledRunningJobs(staleMs: number) {
    const cutoff = new Date(Date.now() - staleMs);
    const cursor = collections.jobs.find({
        status: 'running',
        $or: [{ lastHeartbeatAt: { $lt: cutoff } }, { leaseUntil: { $lt: new Date() } }]
    });
    for await (const job of cursor) {
        const shouldRetry = job.attempts < job.maxAttempts;
        const now = new Date();
        await collections.jobs.updateOne(
            {
                _id: job._id,
                status: 'running',
                leaseOwner: job.leaseOwner,
                attempts: job.attempts,
                $or: [{ lastHeartbeatAt: { $lt: cutoff } }, { leaseUntil: { $lt: now } }]
            },
            shouldRetry
                ? {
                      $set: {
                          status: 'queued',
                          error: 'Job heartbeat stalled; re-queued',
                          runAfter: new Date(now.getTime() + RETRY_BACKOFF_MS),
                          updatedAt: now
                      },
                      $unset: { leaseOwner: '', leaseUntil: '', startedAt: '' }
                  }
                : {
                      $set: {
                          status: 'stalled',
                          error: 'Job heartbeat stalled',
                          completedAt: now,
                          updatedAt: now
                      },
                      $unset: { leaseOwner: '', leaseUntil: '' }
                  }
        );
    }
}

export function imageTileUploadId(projectId: string, uploadId: string) {
    return createHash('sha256')
        .update(`image-tiles:${projectId}:${uploadId}`)
        .digest('hex')
        .slice(0, 24);
}

export class ImageTileLeaseLost extends Error {
    constructor() {
        super('Image tile job lease was lost.');
    }
}

export async function acceptImageTileUpload(input: {
    id: string;
    nodeId: string;
    asset: Omit<AssetDocument, '_id' | 'id' | 'createdAt' | 'updatedAt'>;
    payload: ProcessImageTilesPayload;
}) {
    return db.client.withSession((session) =>
        session.withTransaction(async () => {
            const existing = await dbCol.assets.findDeepZoomUpload(input.id, session);
            if (existing) {
                if (
                    existing.projectId !== input.asset.projectId ||
                    existing.createdBy !== input.asset.createdBy ||
                    existing.url !== input.asset.url
                ) {
                    throw new Error('Conflicting image upload identity.');
                }
                return existing;
            }
            const asset = await dbCol.assets.insertDeepZoomUpload(input.id, input.asset, session);
            await enqueueJob({
                id: new ObjectId(input.id),
                nodeId: input.nodeId,
                type: 'process_image_tiles',
                payload: input.payload,
                session
            });
            return asset;
        })
    );
}

async function fenceLease(job: JobDocument, owner: string, session: ClientSession) {
    const now = new Date();
    const result = await collections.jobs.updateOne(
        {
            _id: job._id,
            status: 'running',
            leaseOwner: owner,
            attempts: job.attempts,
            leaseUntil: { $gt: now }
        },
        { $set: { updatedAt: now } },
        { session }
    );
    if (result.matchedCount !== 1) throw new ImageTileLeaseLost();
}

export async function updateImageTileAsset(
    job: JobDocument,
    owner: string,
    state: ImageDeepZoomAsset,
    fields: { previewUrl?: string; blurhash?: string } = {}
) {
    return db.client.withSession((session) =>
        session.withTransaction(async () => {
            await fenceLease(job, owner, session);
            const payload = job.payload as ProcessImageTilesPayload;
            if (!(await dbCol.assets.updateDeepZoomJob(payload.assetId, state, fields, session))) {
                throw new Error('Image asset is no longer available for processing.');
            }
        })
    );
}

export async function completeImageTileJob(
    job: JobDocument,
    owner: string,
    state: ImageDeepZoomAsset,
    result: ProcessImageTilesResult
) {
    return db.client.withSession((session) =>
        session.withTransaction(async () => {
            await fenceLease(job, owner, session);
            const payload = job.payload as ProcessImageTilesPayload;
            if (
                !(await dbCol.assets.updateDeepZoomJob(
                    payload.assetId,
                    state,
                    { previewUrl: result.previewFilename },
                    session
                ))
            ) {
                throw new Error('Image asset is no longer available for processing.');
            }
            await collections.jobs.updateOne(
                { _id: job._id },
                {
                    $set: {
                        status: 'completed',
                        result,
                        completedAt: new Date(),
                        updatedAt: new Date()
                    },
                    $unset: { leaseOwner: '', leaseUntil: '', error: '' }
                },
                { session }
            );
        })
    );
}

export async function failImageTileJob(job: JobDocument, owner: string, error: string) {
    return db.client.withSession((session) =>
        session.withTransaction(async () => {
            await fenceLease(job, owner, session);
            const retry = job.attempts < job.maxAttempts;
            const payload = job.payload as ProcessImageTilesPayload;
            const dimensions = {
                schemaVersion: 1 as const,
                width: payload.width,
                height: payload.height
            };
            await dbCol.assets.updateDeepZoomJob(
                payload.assetId,
                retry
                    ? { ...dimensions, status: 'queued' }
                    : {
                          ...dimensions,
                          status: 'failed',
                          error: 'Image processing failed. Please contact the project administrator.'
                      },
                {},
                session
            );
            await collections.jobs.updateOne(
                { _id: job._id },
                {
                    $set: {
                        status: retry ? 'queued' : 'failed',
                        error,
                        runAfter: new Date(Date.now() + 5000 * job.attempts),
                        updatedAt: new Date(),
                        ...(!retry ? { completedAt: new Date() } : {})
                    },
                    $unset: { leaseOwner: '', leaseUntil: '', startedAt: '' }
                },
                { session }
            );
        })
    );
}

/** A reaped final attempt must not leave the library permanently "processing". */
export async function reconcileStalledImageTiles(nodeId: string) {
    for await (const job of collections.jobs.find({
        nodeId,
        type: 'process_image_tiles',
        status: 'stalled',
        assetStateReconciled: { $ne: true }
    })) {
        await db.client.withSession((session) =>
            session.withTransaction(async () => {
                const current = await collections.jobs.updateOne(
                    { _id: job._id, status: 'stalled', assetStateReconciled: { $ne: true } },
                    { $set: { assetStateReconciled: true } },
                    { session }
                );
                if (!current.matchedCount) return;
                const payload = job.payload as ProcessImageTilesPayload;
                await dbCol.assets.updateDeepZoomJob(
                    payload.assetId,
                    {
                        schemaVersion: 1,
                        width: payload.width,
                        height: payload.height,
                        status: 'failed',
                        error: 'Image processing stopped after repeated worker interruptions.'
                    },
                    {},
                    session
                );
            })
        );
    }
}

export async function findAcceptedImageTileUpload(
    projectId: string,
    uploadId: string,
    createdBy: string
) {
    const asset = await dbCol.assets.findDeepZoomUpload(imageTileUploadId(projectId, uploadId));
    if (asset && (asset.projectId !== projectId || asset.createdBy !== createdBy))
        throw new Error('Conflicting image upload identity.');
    return asset;
}

export async function finalizeImageTileUpload(input: {
    uploadId: string;
    projectId: string;
    createdBy: string;
    name: string;
    filename: string;
    sourcePath: string;
    mimeType: string;
    width: number;
    height: number;
    maxPixels: number;
    settings: ImageTileSettings;
}) {
    const existing = await findAcceptedImageTileUpload(
        input.projectId,
        input.uploadId,
        input.createdBy
    );
    if (existing) return existing;
    if (basename(input.filename) !== input.filename)
        throw new Error('Invalid image source filename.');
    await mkdir(ASSET_DIR, { recursive: true });
    const temporary = await mkdtemp(join(ASSET_DIR, '.image-upload-'));
    const destination = join(ASSET_DIR, input.filename);
    try {
        const copied = join(temporary, 'source');
        await copyFile(input.sourcePath, copied);
        await link(copied, destination).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
        });
    } catch (error) {
        const accepted = await findAcceptedImageTileUpload(
            input.projectId,
            input.uploadId,
            input.createdBy
        );
        if (accepted) return accepted;
        throw error;
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
    const id = imageTileUploadId(input.projectId, input.uploadId);
    return acceptImageTileUpload({
        id,
        nodeId: input.settings.nodeId,
        asset: {
            projectId: input.projectId,
            name: input.name,
            url: input.filename,
            size: (await stat(destination)).size,
            mimeType: input.mimeType,
            public: input.projectId === PUBLIC_ASSET_PROJECT_ID,
            createdBy: input.createdBy,
            deepZoom: {
                schemaVersion: 1,
                width: input.width,
                height: input.height,
                status: 'queued'
            }
        },
        payload: {
            assetId: id,
            sourceFilename: input.filename,
            sourceId: `img_${id}_v1`,
            width: input.width,
            height: input.height,
            maxPixels: input.maxPixels
        }
    });
}
