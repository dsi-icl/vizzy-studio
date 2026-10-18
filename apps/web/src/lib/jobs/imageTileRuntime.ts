import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { z } from '../zod';
import type { ProcessImageTilesPayload } from './types';

const UploadSettings = z.object({
    IMAGE_DEEP_ZOOM_NODE_ID: z.string().trim().min(1).max(120),
    IMAGE_MARTIN_URL: z
        .url()
        .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol))
});

/** The web process only needs the destination, not the worker's executable paths. */
export function readImageTileUploadSettings(settings: Record<string, unknown>) {
    const parsed = UploadSettings.parse(settings);
    return {
        nodeId: parsed.IMAGE_DEEP_ZOOM_NODE_ID,
        martinUrl: parsed.IMAGE_MARTIN_URL.replace(/\/$/, '')
    };
}

export type ImageTileUploadSettings = ReturnType<typeof readImageTileUploadSettings>;

const Settings = UploadSettings.extend({
    IMAGE_DEEP_ZOOM_WORKERS: z.coerce.number().int().min(1).max(8).default(1),
    IMAGE_DEEP_ZOOM_THREADS: z.coerce.number().int().min(1).max(16).default(2),
    IMAGE_DEEP_ZOOM_TIMEOUT_MS: z.coerce.number().int().positive().default(3_600_000),
    IMAGE_TILE_WORKER_NODE: z.string().refine(isAbsolute, 'Use an explicit absolute Node path.'),
    IMAGE_TILE_WORKER_PATH: z.string().refine(isAbsolute, 'Use an absolute worker entry path.')
});

export function readImageTileSettings(settings: Record<string, unknown>) {
    const parsed = Settings.parse(settings);
    return {
        nodeId: parsed.IMAGE_DEEP_ZOOM_NODE_ID,
        workers: parsed.IMAGE_DEEP_ZOOM_WORKERS,
        threads: parsed.IMAGE_DEEP_ZOOM_THREADS,
        timeoutMs: parsed.IMAGE_DEEP_ZOOM_TIMEOUT_MS,
        node: parsed.IMAGE_TILE_WORKER_NODE,
        workerPath: parsed.IMAGE_TILE_WORKER_PATH,
        martinUrl: parsed.IMAGE_MARTIN_URL.replace(/\/$/, ''),
        readinessTimeoutMs: 30_000
    };
}

export type ImageTileSettings = ReturnType<typeof readImageTileSettings>;

/** Per-process admission control: claims plus running tasks count toward the limit. */
export function createConcurrentJobDrain<T>(options: {
    concurrency: number;
    claim: () => Promise<T | null>;
    process: (job: T) => Promise<void>;
    onError: (error: unknown) => void;
}) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
        throw new RangeError('Job concurrency must be a positive integer.');
    let active = 0;
    let stopped = false;
    let resolveStopped: (() => void) | undefined;
    const idle = new Promise<void>((resolveIdle) => {
        resolveStopped = resolveIdle;
    });
    const wake = () => {
        while (!stopped && active < options.concurrency) {
            active++;
            void (async () => {
                let claimed = false;
                try {
                    const job = await options.claim();
                    if (!job) return;
                    claimed = true;
                    await options.process(job);
                } catch (error) {
                    options.onError(error);
                } finally {
                    active--;
                    if (claimed) wake();
                    if (stopped && active === 0) resolveStopped?.();
                }
            })();
        }
    };
    return {
        wake,
        stop() {
            stopped = true;
            if (active === 0) resolveStopped?.();
            // Includes claims already in flight; their jobs must be processed/released.
            return idle;
        }
    };
}

const Manifest = z.object({
    stage: z.literal('published'),
    sourceId: z.string(),
    width: z.int().positive(),
    height: z.int().positive(),
    tileSize: z.literal(512),
    maxZoom: z.int().nonnegative(),
    preview: z.string(),
    output: z.string(),
    reused: z.boolean()
});
export type ImageTileManifest = z.infer<typeof Manifest>;

export async function runImageTileWorker(input: {
    payload: ProcessImageTilesPayload;
    dataDir: string;
    assetDir: string;
    settings: ImageTileSettings;
    signal: AbortSignal;
    onPreview: (filename: string) => Promise<void>;
}): Promise<ImageTileManifest> {
    const { payload, settings, signal } = input;
    const dataDir = resolve(input.dataDir);
    const workRoot = join(dataDir, 'image-tile-work');
    await mkdir(workRoot, { recursive: true });
    const workDir = await mkdtemp(join(workRoot, `${payload.sourceId}-`));
    const preview = join(dataDir, 'previews', `${payload.sourceId}.webp`);
    const output = join(dataDir, 'image-tiles', `${payload.sourceId}.mbtiles`);
    const config = join(workDir, 'request.json');
    try {
        await writeFile(
            config,
            JSON.stringify({
                source: resolve(input.assetDir, payload.sourceFilename),
                dataDir,
                sourceId: payload.sourceId,
                maxPixels: payload.maxPixels,
                concurrency: settings.threads,
                workDir,
                reusePublished: true
            })
        );
        signal.throwIfAborted();
        return await new Promise<ImageTileManifest>((resolveResult, reject) => {
            const child = spawn(settings.node, [settings.workerPath, config], {
                stdio: ['ignore', 'pipe', 'pipe', 'ipc']
            });
            let stderr = '',
                pending = '';
            let failure: Error | undefined;
            let manifest: ImageTileManifest | undefined;
            let events = Promise.resolve();
            const stop = (error: Error) => {
                failure ??= error;
                child.kill('SIGKILL');
            };
            const abort = () => stop(new Error('Image tile worker cancelled.'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
            const timeout = setTimeout(
                () => stop(new Error('Image tile worker timed out.')),
                settings.timeoutMs
            );
            child.stderr!.on('data', (chunk) => {
                stderr = (stderr + String(chunk)).slice(-4000);
            });
            child.stdout!.on('data', (chunk) => {
                pending += String(chunk);
                if (pending.length > 16_384) {
                    stop(new Error('Image tile worker emitted oversized output.'));
                    return;
                }
                const lines = pending.split('\n');
                pending = lines.pop() ?? '';
                for (const line of lines) {
                    events = events
                        .then(async () => {
                            signal.throwIfAborted();
                            const event = JSON.parse(line);
                            if (event.stage === 'preview') {
                                if (
                                    event.preview !== preview ||
                                    event.width !== payload.width ||
                                    event.height !== payload.height
                                )
                                    throw new Error('Image preview metadata mismatch.');
                                await input.onPreview(preview);
                            } else if (event.stage === 'published') {
                                const result = Manifest.parse(event);
                                if (
                                    result.sourceId !== payload.sourceId ||
                                    result.width !== payload.width ||
                                    result.height !== payload.height ||
                                    result.preview !== preview ||
                                    result.output !== output ||
                                    result.maxZoom !==
                                        Math.max(
                                            0,
                                            Math.ceil(
                                                Math.log2(
                                                    Math.max(result.width, result.height) / 512
                                                )
                                            )
                                        )
                                )
                                    throw new Error('Image tile manifest mismatch.');
                                manifest = result;
                            } else if (event.stage !== 'packing')
                                throw new Error('Unknown image tile worker event.');
                        })
                        .catch((error: unknown) =>
                            stop(error instanceof Error ? error : new Error(String(error)))
                        );
                }
            });
            child.on('error', (error) => {
                failure ??= error;
            });
            child.on('close', (code) => {
                clearTimeout(timeout);
                signal.removeEventListener('abort', abort);
                void events.then(() => {
                    if (failure) reject(failure);
                    else if (code !== 0)
                        reject(new Error(`Image tile worker exited ${String(code)}: ${stderr}`));
                    else if (!manifest || pending.trim())
                        reject(new Error('Missing image tile worker manifest.'));
                    else resolveResult(manifest);
                });
            });
        });
    } finally {
        // Waited for child close above, including timeout/cancellation, so native
        // processing can no longer write into this attempt's scratch directory.
        await rm(workDir, { recursive: true, force: true });
    }
}

/** Reclaim only old, recognizable attempts whose persistent job is no longer running. */
export async function cleanImageTileScratch(input: {
    dataDir: string;
    timeoutMs: number;
    canRemove: (assetId: string) => Promise<boolean>;
}) {
    const root = join(input.dataDir, 'image-tile-work');
    const entries = await readdir(root, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
    );
    const cutoff = Date.now() - input.timeoutMs - 60_000;
    for (const entry of entries) {
        const match = /^img_([a-f0-9]{24})_v1-[a-zA-Z0-9]{6}$/.exec(entry.name);
        if (!match || !entry.isDirectory()) continue;
        const path = join(root, entry.name);
        // Directory mtime advances as artifacts are created. Never follow symlinks.
        const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (!info?.isDirectory() || info.mtimeMs >= cutoff) continue;
        if (await input.canRemove(match[1])) await rm(path, { recursive: true, force: true });
    }
}
