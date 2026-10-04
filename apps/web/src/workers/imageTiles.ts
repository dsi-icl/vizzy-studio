import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
    access,
    constants,
    copyFile,
    link,
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { db } from '@repo/db';
import { ImageDeepZoomAsset } from '@repo/db/schema';
import { env } from '@repo/env';
import { ObjectId, type ChangeStream } from 'mongodb';
import sharp from 'sharp';

import {
    type ImageTileSettings,
    type ImageTileManifest,
    runImageTileWorker,
    createConcurrentJobDrain,
    cleanImageTileScratch,
    readImageTileSettings
} from '../lib/jobs/imageTileRuntime';
import {
    claimNextJob,
    heartbeatJob,
    markStalledRunningJobs,
    completeImageTileJob,
    failImageTileJob,
    ImageTileLeaseLost,
    updateImageTileAsset,
    reconcileStalledImageTiles,
    ensureJobIndexes
} from '../lib/jobs/repo';
import type { JobDocument, ProcessImageTilesPayload } from '../lib/jobs/types';
import { computeBlurhash } from '../lib/serverAssetUtils';
import { APP_DATA_DIR, ASSET_DIR } from '../lib/serverVariables';
import { collections } from '../server/collections';

const healthFile = join(tmpdir(), 'vizzy-image-worker-health.json');

if (process.argv.includes('--healthcheck')) {
    try {
        const health = JSON.parse(await readFile(healthFile, 'utf8'));
        if (
            !Number.isSafeInteger(health.pid) ||
            health.pid <= 0 ||
            !Number.isFinite(health.checkedAt) ||
            Date.now() - health.checkedAt > 30_000
        )
            throw new Error('Image worker queue heartbeat is stale.');
        process.kill(health.pid, 0);
    } catch {
        process.exitCode = 1;
    }
} else {
    let stopping = false;
    let startup: Promise<Awaited<ReturnType<typeof startImageTileQueue>> | undefined>;
    let shutdownPromise: Promise<void> | undefined;

    const clearHealth = () => rm(healthFile, { force: true });
    const writeHealth = async () => {
        await db.command({ ping: 1 });
        if (stopping) return;
        const temporary = `${healthFile}.${process.pid}`;
        await writeFile(temporary, JSON.stringify({ pid: process.pid, checkedAt: Date.now() }));
        await rename(temporary, healthFile);
    };

    async function start() {
        await clearHealth();
        if (!env.SERVER_DATABASE_URL) throw new Error('SERVER_DATABASE_URL is required.');
        const settings = readImageTileSettings({
            ...env,
            IMAGE_TILE_WORKER_NODE: env.IMAGE_TILE_WORKER_NODE || process.execPath,
            IMAGE_TILE_WORKER_PATH:
                env.IMAGE_TILE_WORKER_PATH ||
                fileURLToPath(new URL('./worker.mjs', import.meta.url))
        });
        const { stdout } = await promisify(execFile)(settings.node, ['--version']);
        if (!/^v(\d+)/.test(stdout) || Number(stdout.match(/^v(\d+)/)?.[1]) < 26)
            throw new Error('The image worker requires Node.js 26 or newer.');
        await access(settings.workerPath, constants.R_OK);

        const hello = await db.command({ hello: 1 });
        if (!hello.setName && hello.msg !== 'isdbgrid')
            throw new Error('Image jobs require a MongoDB replica set or mongos.');

        const work = join(APP_DATA_DIR, 'image-tile-work');
        const tiles = join(APP_DATA_DIR, 'image-tiles');
        const previews = join(APP_DATA_DIR, 'previews');
        for (const directory of [ASSET_DIR, work, tiles, previews]) {
            await mkdir(directory, { recursive: true });
            await access(directory, constants.R_OK | constants.W_OK);
        }
        // Publishing uses hard links: scratch, previews and tiles must share a filesystem.
        const probe = await mkdtemp(join(work, '.startup-'));
        const target = join(tiles, basename(probe));
        const previewTarget = join(previews, basename(probe));
        try {
            const source = join(probe, 'probe');
            await writeFile(source, 'storage-check');
            await link(source, target);
            await link(source, previewTarget);
        } finally {
            await Promise.all([
                rm(probe, { recursive: true, force: true }),
                rm(target, { force: true }),
                rm(previewTarget, { force: true })
            ]);
        }
        const deadline = Date.now() + 30_000;
        let martinReady = false;
        while (!stopping && Date.now() < deadline) {
            try {
                const response = await fetch(`${settings.martinUrl}/health`, {
                    signal: AbortSignal.timeout(2000),
                    redirect: 'error'
                });
                await response.body?.cancel();
                if (response.ok) {
                    martinReady = true;
                    break;
                }
            } catch {
                /* Allow local development services to start together. */
            }
            await sleep(250);
        }
        if (stopping) return;
        if (!martinReady) throw new Error('Image Martin did not become healthy within 30 seconds.');
        const queue = await startImageTileQueue(settings, writeHealth, clearHealth);
        console.log(
            `[ImageTiles] Worker started: node=${settings.nodeId}, concurrency=${settings.workers}, data=${APP_DATA_DIR}`
        );
        return queue;
    }

    function shutdown() {
        if (shutdownPromise) return shutdownPromise;
        stopping = true;
        const deadline = setTimeout(() => {
            console.error('[ImageTiles] Shutdown timed out; remaining leases will be recovered.');
            process.exit(1);
        }, 25_000);
        deadline.unref();
        shutdownPromise = (async () => {
            try {
                await clearHealth();
                const queue = await startup.catch(() => undefined);
                await queue?.stop();
            } finally {
                await clearHealth();
                await db.client?.close();
                clearTimeout(deadline);
            }
        })();
        return shutdownPromise;
    }

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
            console.log(`[ImageTiles] ${signal}: stopping claims and releasing active jobs.`);
            void shutdown().catch((error) => {
                console.error('[ImageTiles] Shutdown failed:', error);
                process.exitCode = 1;
            });
        });
    }
    startup = start();
    try {
        await startup;
    } catch (error) {
        console.error('[ImageTiles] Startup failed:', error);
        process.exitCode = 1;
        await shutdown();
    }
}

/** Long-lived consumer; only the standalone worker starts this queue. */
async function startImageTileQueue(
    settings: ImageTileSettings,
    onPoll: () => Promise<void> = async () => {},
    onPollError: () => Promise<void> = async () => {}
) {
    await ensureJobIndexes();
    const shutdown = new AbortController();
    const drain = createConcurrentJobDrain({
        concurrency: settings.workers,
        claim: async () => {
            const owner = `image_tiles_${randomUUID()}`;
            const job = await claimNextJob(owner, settings.nodeId, ['process_image_tiles']);
            return job ? { job, owner } : null;
        },
        process: ({ job, owner }) => processImageTileJob(job, owner, settings, shutdown.signal),
        onError: (error) => console.error('[ImageTiles] Queue error:', error)
    });
    let stream: ChangeStream<JobDocument> | undefined;
    try {
        stream = collections.jobs.watch(
            [{ $match: { operationType: { $in: ['insert', 'update', 'replace'] } } }],
            { fullDocument: 'updateLookup' }
        );
        stream.on('change', (change) => {
            if (
                'fullDocument' in change &&
                change.fullDocument?.nodeId === settings.nodeId &&
                change.fullDocument.type === 'process_image_tiles' &&
                change.fullDocument.status === 'queued'
            )
                drain.wake();
        });
        stream.on('error', (error) =>
            console.error('[ImageTiles] Change stream unavailable; polling remains active:', error)
        );
    } catch (error) {
        console.error('[ImageTiles] Change stream unavailable; polling remains active:', error);
    }
    let nextCleanup = 0;
    let polling: Promise<void> | undefined;
    const poll = () => {
        if (shutdown.signal.aborted || polling) return;
        polling = (async () => {
            // Recovery lives with the consumer, even while the web app is offline.
            await markStalledRunningJobs(120_000, {
                nodeId: settings.nodeId,
                types: ['process_image_tiles']
            });
            await reconcileStalledImageTiles(settings.nodeId);
            if (Date.now() >= nextCleanup) {
                await cleanImageTileScratch({
                    dataDir: APP_DATA_DIR,
                    timeoutMs: settings.timeoutMs,
                    canRemove: async (id) => {
                        const job = await collections.jobs.findOne({
                            _id: new ObjectId(id),
                            nodeId: settings.nodeId,
                            type: 'process_image_tiles'
                        });
                        return Boolean(job && job.status !== 'running');
                    }
                });
                nextCleanup = Date.now() + 60_000;
            }
            if (shutdown.signal.aborted) return;
            drain.wake();
            await onPoll();
        })()
            .catch(async (error) => {
                console.error('[ImageTiles] Queue poll failed:', error);
                await onPollError().catch((healthError) =>
                    console.error('[ImageTiles] Health update failed:', healthError)
                );
            })
            .finally(() => {
                polling = undefined;
            });
    };
    const timer = setInterval(poll, 5000);
    poll();
    let stopping: Promise<void> | undefined;
    return {
        stop() {
            if (stopping) return stopping;
            clearInterval(timer);
            const idle = drain.stop();
            shutdown.abort(new Error('Image worker is shutting down.'));
            const closed = stream
                ?.close()
                .catch((error) => console.error('[ImageTiles] Change stream close failed:', error));
            stopping = Promise.all([idle, polling, closed]).then(() => {});
            return stopping;
        }
    };
}

async function publishPreview(source: string, filename: string) {
    await mkdir(ASSET_DIR, { recursive: true });
    const temporary = await mkdtemp(join(ASSET_DIR, '.image-preview-'));
    try {
        const copied = join(temporary, 'preview.webp');
        await copyFile(source, copied);
        await link(copied, join(ASSET_DIR, filename)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
        });
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

async function waitForImageTile(
    manifest: ImageTileManifest,
    settings: ImageTileSettings,
    signal: AbortSignal
) {
    const deadline = Date.now() + settings.readinessTimeoutMs;
    while (Date.now() < deadline) {
        signal.throwIfAborted();
        try {
            const response = await fetch(`${settings.martinUrl}/${manifest.sourceId}/0/0/0`, {
                signal: AbortSignal.any([signal, AbortSignal.timeout(2000)])
            });
            if (response.ok && response.headers.get('content-type')?.startsWith('image/webp')) {
                const { info } = await sharp(Buffer.from(await response.arrayBuffer()))
                    .raw()
                    .toBuffer({ resolveWithObject: true });
                if (info.width === manifest.tileSize && info.height === manifest.tileSize) return;
            } else await response.body?.cancel();
        } catch {
            signal.throwIfAborted();
        }
        await sleep(250, undefined, { signal });
    }
    throw new Error('Published image tiles are not yet available from Martin.');
}

async function processImageTileJob(
    job: JobDocument,
    owner: string,
    settings: ImageTileSettings,
    shutdownSignal?: AbortSignal
) {
    const payload = job.payload as ProcessImageTilesPayload;
    const dimensions = { schemaVersion: 1 as const, width: payload.width, height: payload.height };
    const controller = new AbortController();
    const signal = shutdownSignal
        ? AbortSignal.any([controller.signal, shutdownSignal])
        : controller.signal;
    let heartbeatPending = false;
    let finished = false;
    let watchdog = setTimeout(() => controller.abort(), 25_000);
    const heartbeat = setInterval(() => {
        if (heartbeatPending) return;
        heartbeatPending = true;
        void heartbeatJob(job._id, owner, undefined, true)
            .then((owned) => {
                if (finished) return;
                if (!owned) {
                    controller.abort();
                    return;
                }
                clearTimeout(watchdog);
                watchdog = setTimeout(() => controller.abort(), 25_000);
            })
            .catch(() => controller.abort())
            .finally(() => {
                heartbeatPending = false;
            });
    }, 2000);
    try {
        signal.throwIfAborted();
        console.log(`[ImageTiles] Claimed job ${String(job._id)} (attempt ${job.attempts})`);
        await updateImageTileAsset(job, owner, { ...dimensions, status: 'processing' });
        const previewFilename = `${payload.sourceId}.webp`;
        const manifest = await runImageTileWorker({
            payload,
            dataDir: APP_DATA_DIR,
            assetDir: ASSET_DIR,
            settings,
            signal,
            onPreview: async (preview) => {
                await publishPreview(preview, previewFilename);
                const blurhash = await computeBlurhash(preview);
                await updateImageTileAsset(
                    job,
                    owner,
                    { ...dimensions, status: 'processing' },
                    { previewUrl: previewFilename, ...(blurhash ? { blurhash } : {}) }
                );
            }
        });
        await waitForImageTile(manifest, settings, signal);
        signal.throwIfAborted();
        const ready = ImageDeepZoomAsset.parse({
            ...dimensions,
            status: 'ready',
            tiles: {
                sourceId: payload.sourceId,
                tileSize: manifest.tileSize,
                maxZoom: manifest.maxZoom,
                format: 'webp'
            }
        });
        await completeImageTileJob(job, owner, ready, {
            sourceId: payload.sourceId,
            previewFilename,
            reused: manifest.reused
        });
        console.log(`[ImageTiles] Completed job ${String(job._id)}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
            console.error(`[ImageTiles] Job ${String(job._id)}: ${message}`);
            await failImageTileJob(job, owner, message, shutdownSignal?.aborted ?? false);
        } catch (failure) {
            if (!(failure instanceof ImageTileLeaseLost)) throw failure;
        }
    } finally {
        finished = true;
        clearInterval(heartbeat);
        clearTimeout(watchdog);
        controller.abort();
    }
}
