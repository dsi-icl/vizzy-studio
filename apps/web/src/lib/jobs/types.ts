import type { ObjectId } from 'mongodb';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stalled';
export type JobType = 'process_image_asset' | 'process_video_asset' | 'process_image_tiles';

export interface ProcessImageTilesPayload {
    assetId: string;
    // Snapshot upload attribution so audits remain linked even if the asset is removed.
    // Optional for jobs accepted before this context was stored.
    projectId?: string;
    createdBy?: string;
    sourceFilename: string;
    sourceId: string;
    width: number;
    height: number;
    maxPixels: number;
}

export interface ProcessImageTilesResult {
    sourceId: string;
    previewFilename: string;
    reused: boolean;
}

export interface ProcessImageAssetPayload {
    uploadId: string;
    sourceExt: string;
    sourceFilename: string;
    /** @deprecated Legacy field — use sourceFilename instead */
    sourcePath?: string;
}

export interface ProcessVideoAssetPayload {
    uploadId: string;
    sourceFilename: string;
    sourceExt: string;
    duration: number;
    numericId: number;
    /** @deprecated Legacy field — use sourceFilename instead */
    sourcePath?: string;
    /** @deprecated Legacy field */
    outputPath?: string;
    /** @deprecated Legacy field */
    previewPath?: string;
}

export interface ProcessImageAssetResult {
    blurhash?: string;
    sizes?: number[];
}

export interface ProcessVideoAssetResult {
    blurhash?: string;
    sizes?: number[];
    previewFilename?: string;
}

export type JobPayload =
    | ProcessImageAssetPayload
    | ProcessVideoAssetPayload
    | ProcessImageTilesPayload;
export type JobResult = ProcessImageAssetResult | ProcessVideoAssetResult | ProcessImageTilesResult;

export interface JobDocument {
    _id: ObjectId;
    nodeId: string;
    type: JobType;
    status: JobStatus;
    payload: JobPayload;
    result?: JobResult;
    error?: string;
    attempts: number;
    maxAttempts: number;
    runAfter: Date;
    leaseOwner?: string;
    leaseUntil?: Date;
    startedAt?: Date;
    completedAt?: Date;
    lastHeartbeatAt?: Date;
    lastProgressAt?: Date;
    createdAt: Date;
    updatedAt: Date;
    assetStateReconciled?: boolean;
}
