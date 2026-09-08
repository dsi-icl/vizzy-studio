import { spawn } from 'node:child_process';
import { readdir, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { computeBlurhash, generateVariants } from '~/lib/serverAssetUtils';
import { ASSET_DIR, TMP_DIR } from '~/lib/serverVariables';
import { collections } from '~/server/collections';

import {
    claimNextJob,
    completeJob,
    ensureJobIndexes,
    failJob,
    heartbeatJob,
    markStalledRunningJobs
} from './repo';
import type { JobDocument, ProcessImageAssetPayload, ProcessVideoAssetPayload } from './types';

const FFMPEG_COMMAND = process.env.FFMPEG_PATH || 'ffmpeg';
const HEARTBEAT_INTERVAL_MS = 2_000;
const STALE_HEARTBEAT_MS = 2 * 60 * 1000;
const REAPER_INTERVAL_MS = 10_000;
const SWEEP_INTERVAL_MS = 5_000;

const workerId = `media_worker_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const workerNodeId = hostname();

let draining = false;
let shouldDrainAgain = false;

function getCleanString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === 'undefined' || trimmed.toLowerCase() === 'null')
        return null;
    return trimmed;
}

async function resolveVideoSourcePath(payload: ProcessVideoAssetPayload): Promise<string> {
    const legacyPath = getCleanString(payload.sourcePath);
    if (legacyPath) return legacyPath;

    const sourceFilename = getCleanString(payload.sourceFilename);
    if (sourceFilename) return join(TMP_DIR, sourceFilename);

    const sourceExt = getCleanString(payload.sourceExt);
    if (sourceExt) return join(TMP_DIR, `${payload.uploadId}_raw${sourceExt}`);

    const prefix = `${payload.uploadId}_raw`;
    const candidates = await readdir(TMP_DIR);
    const match = candidates.find((entry) => entry.startsWith(prefix));
    if (match) return join(TMP_DIR, match);

    return join(TMP_DIR, `${payload.uploadId}_raw`);
}

async function processImageJob(job: JobDocument) {
    const payload = job.payload as ProcessImageAssetPayload;
    const sourcePath =
        getCleanString(payload.sourcePath) ?? join(ASSET_DIR, payload.sourceFilename);
    const blurhash = await computeBlurhash(sourcePath);
    const sizes =
        payload.sourceExt === '.svg' ? [] : await generateVariants(sourcePath, payload.uploadId);
    await completeJob(job._id, workerId, {
        blurhash: blurhash ?? undefined,
        sizes: sizes.length > 0 ? sizes : undefined
    });
}

const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const FFMPEG_PREVIEW_TIMEOUT_MS = 30 * 1000; // 30 seconds

function runFFmpegWithProgress(
    args: string[],
    onProgress: (progress: number) => void,
    duration: number
): Promise<{ code: number; stderr: string }> {
    return new Promise((resolve) => {
        const proc = spawn(FFMPEG_COMMAND, args);
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
                proc.kill('SIGKILL');
            } catch {}
            resolve({
                code: 124,
                stderr: `${stderr}\n[MediaWorker] FFmpeg process timed out after ${FFMPEG_TIMEOUT_MS}ms`
            });
        }, FFMPEG_TIMEOUT_MS);

        proc.stderr.on('data', (d) => {
            const text = d.toString();
            stderr += text;
            const match = text.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
            if (!match) return;
            const h = parseInt(match[1], 10);
            const m = parseInt(match[2], 10);
            const s = parseFloat(match[3]);
            const timeInSeconds = h * 3600 + m * 60 + s;
            const progress =
                duration > 0
                    ? Math.min(99, Math.round((timeInSeconds / duration) * 100))
                    : Math.min(99, Math.round(timeInSeconds));
            onProgress(progress);
        });
        proc.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
                code: 127,
                stderr: `[MediaWorker] FFmpeg unavailable at ${FFMPEG_COMMAND}: ${String(err?.message || err)}`
            });
        });
        proc.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code: code ?? 0, stderr });
        });
    });
}

async function extractVideoPreview(
    videoPath: string,
    outputPath: string,
    duration: number
): Promise<boolean> {
    const seekTo = Math.min(0.5, duration / 2);
    return new Promise((resolve) => {
        let settled = false;
        const proc = spawn(FFMPEG_COMMAND, [
            '-y',
            '-ss',
            seekTo.toString(),
            '-i',
            videoPath,
            '-frames:v',
            '1',
            '-q:v',
            '2',
            outputPath
        ]);
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
                proc.kill('SIGKILL');
            } catch {}
            resolve(false);
        }, FFMPEG_PREVIEW_TIMEOUT_MS);

        proc.on('error', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(false);
        });
        proc.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(code === 0);
        });
    });
}

async function processVideoJob(job: JobDocument) {
    const payload = job.payload as ProcessVideoAssetPayload;
    const sourcePath = await resolveVideoSourcePath(payload);
    const outputPath =
        getCleanString(payload.outputPath) ?? join(ASSET_DIR, `${payload.uploadId}.mp4`);
    const previewPath =
        getCleanString(payload.previewPath) ?? join(ASSET_DIR, `${payload.uploadId}.jpg`);
    const sourceExists = await stat(sourcePath)
        .then((s) => s.isFile())
        .catch(() => false);
    if (!sourceExists) {
        throw new Error(`Video source file not found: ${sourcePath}`);
    }

    const result = await runFFmpegWithProgress(
        [
            '-y',
            '-i',
            sourcePath,
            '-c:v',
            'libx264',
            '-preset',
            'fast',
            '-crf',
            '22',
            '-r',
            '60',
            '-g',
            '60',
            '-keyint_min',
            '60',
            '-sc_threshold',
            '0',
            '-an',
            '-movflags',
            '+faststart',
            outputPath
        ],
        (progress) => {
            if (process.__BROADCAST_EDITORS__) {
                process.__BROADCAST_EDITORS__({
                    type: 'processing_progress',
                    numericId: payload.numericId,
                    progress
                });
            }
            void heartbeatJob(job._id, workerId, progress);
        },
        payload.duration
    );

    if (result.code !== 0) {
        throw new Error(`FFmpeg transcode failed (source=${sourcePath}): ${result.stderr}`);
    }

    let blurhash: string | undefined;
    let sizes: number[] | undefined;
    const previewOk = await extractVideoPreview(outputPath, previewPath, payload.duration);
    if (previewOk) {
        const hash = await computeBlurhash(previewPath);
        blurhash = hash ?? undefined;
        const generated = await generateVariants(previewPath, payload.uploadId);
        sizes = generated.length > 0 ? generated : undefined;
    }

    await completeJob(job._id, workerId, {
        blurhash,
        sizes,
        previewFilename: `${payload.uploadId}.jpg`
    });

    // Only remove raw source after successful transcode so retries remain possible on failure.
    await unlink(sourcePath).catch(() => {});
}

async function processJob(job: JobDocument) {
    const heartbeats = setInterval(() => {
        void heartbeatJob(job._id, workerId);
    }, HEARTBEAT_INTERVAL_MS);

    try {
        if (job.type === 'process_image_asset') {
            await processImageJob(job);
            return;
        }
        if (job.type === 'process_video_asset') {
            await processVideoJob(job);
            return;
        }
        throw new Error('Unsupported job type');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await failJob(job._id, workerId, message);
    } finally {
        clearInterval(heartbeats);
    }
}

async function drainQueue() {
    if (draining) {
        shouldDrainAgain = true;
        return;
    }

    draining = true;
    try {
        while (true) {
            const job = await claimNextJob(workerId, workerNodeId);
            if (!job) break;
            await processJob(job);
        }
    } finally {
        draining = false;
        if (shouldDrainAgain) {
            shouldDrainAgain = false;
            void drainQueue();
        }
    }
}

function startSignalWatcher() {
    const stream = collections.jobs.watch(
        [
            {
                $match: {
                    operationType: { $in: ['insert', 'update', 'replace'] }
                }
            }
        ],
        { fullDocument: 'updateLookup' }
    );

    stream.on('change', (change) => {
        if (!('fullDocument' in change)) return;
        const job = change.fullDocument as JobDocument | undefined;
        if (!job) return;
        if (job.status === 'queued') {
            void drainQueue();
        }
    });
    stream.on('error', (err) => {
        console.error('[MediaWorker] Job change stream error:', err);
    });
}

export async function startMediaWorker() {
    if (process.__MEDIA_WORKER_STARTED__) return;
    process.__MEDIA_WORKER_STARTED__ = true;

    await ensureJobIndexes();
    startSignalWatcher();
    setInterval(() => {
        void drainQueue();
    }, SWEEP_INTERVAL_MS);
    setInterval(() => {
        void markStalledRunningJobs(STALE_HEARTBEAT_MS);
    }, REAPER_INTERVAL_MS);

    void drainQueue();
}
