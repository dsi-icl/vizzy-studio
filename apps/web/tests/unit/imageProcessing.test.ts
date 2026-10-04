import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readdir, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { AuthContext } from '@repo/db/documents';
import type { ImageDeepZoomAsset } from '@repo/db/schema';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';

import { evaluateAssetReadAccess } from '../../src/lib/authz';
import { PUBLIC_ASSET_PROJECT_ID } from '../../src/lib/constants';
import {
    createConcurrentJobDrain,
    cleanImageTileScratch,
    readImageTileSettings,
    readImageTileUploadSettings,
    runImageTileWorker
} from '../../src/lib/jobs/imageTileRuntime';
import type { JobDocument, ProcessImageTilesPayload } from '../../src/lib/jobs/types';
import { isImageTileInBounds, parseImageTilePath } from '../../src/lib/mediaUtils';
import {
    classifyNewImageUpload,
    readImageUploadPolicy,
    type ImageUploadPolicy,
    inspectNewImageUpload,
    fetchImageTile
} from '../../src/lib/serverAssetUtils';
import type { AuditLogInput } from '../../src/server/audit';

describe('New image upload policy', () => {
    const enabled = readImageUploadPolicy({
        IMAGE_DEEP_ZOOM_UPLOADS_ENABLED: 'true',
        IMAGE_DEEP_ZOOM_MAX_PIXELS: '100000000'
    });

    test('defaults off and does not interpret unused processing settings', () => {
        expect(readImageUploadPolicy({})).toEqual({ enabled: false });
        for (const flag of ['', '0', 'false', 'OFF', ' no ']) {
            expect(
                readImageUploadPolicy({
                    IMAGE_DEEP_ZOOM_UPLOADS_ENABLED: flag,
                    IMAGE_DEEP_ZOOM_MAX_PIXELS: 'invalid'
                })
            ).toEqual({ enabled: false });
        }
        expect(classifyNewImageUpload({}, { enabled: false })).toEqual({ kind: 'standard' });
    });

    test('uses the do-image ceiling when the override is absent or blank', () => {
        for (const value of [undefined, '', '   ']) {
            const policy = readImageUploadPolicy({
                IMAGE_DEEP_ZOOM_UPLOADS_ENABLED: 'true',
                IMAGE_DEEP_ZOOM_MAX_PIXELS: value
            });
            expect(policy).toEqual({
                enabled: true,
                tilePixels: 24_000_000,
                tileEdge: 8192,
                maxPixels: 16_000_000_000
            });
            expect(
                classifyNewImageUpload({ format: 'png', width: 10000, height: 5000 }, policy)
            ).toEqual({ kind: 'deep-zoom', width: 10000, height: 5000 });
            expect(
                classifyNewImageUpload({ format: 'png', width: 160000, height: 100000 }, policy)
            ).toEqual({ kind: 'deep-zoom', width: 160000, height: 100000 });
            expect(() =>
                classifyNewImageUpload({ format: 'png', width: 160001, height: 100000 }, policy)
            ).toThrow('MAX_PIXELS');
        }
    });

    test('honors a deployment-specific ceiling instead of replacing it with the default', () => {
        const policy = readImageUploadPolicy({
            IMAGE_DEEP_ZOOM_UPLOADS_ENABLED: 'true',
            IMAGE_DEEP_ZOOM_MAX_PIXELS: ' 40000000 '
        });
        expect(
            classifyNewImageUpload({ format: 'png', width: 10000, height: 4000 }, policy)
        ).toEqual({ kind: 'deep-zoom', width: 10000, height: 4000 });
        expect(() =>
            classifyNewImageUpload({ format: 'png', width: 10000, height: 5000 }, policy)
        ).toThrow('MAX_PIXELS');
    });

    test('rejects invalid flags and non-positive or non-integer processing overrides', () => {
        expect(() => readImageUploadPolicy({ IMAGE_DEEP_ZOOM_UPLOADS_ENABLED: 'maybe' })).toThrow();
        for (const value of ['0', '-1', '1.5', 'Infinity', 'bad']) {
            expect(() =>
                readImageUploadPolicy({
                    IMAGE_DEEP_ZOOM_UPLOADS_ENABLED: 'true',
                    IMAGE_DEEP_ZOOM_MAX_PIXELS: value
                })
            ).toThrow();
        }
        for (const key of ['IMAGE_DEEP_ZOOM_TILE_PIXELS', 'IMAGE_DEEP_ZOOM_TILE_EDGE']) {
            expect(() =>
                readImageUploadPolicy({
                    IMAGE_DEEP_ZOOM_UPLOADS_ENABLED: 'true',
                    IMAGE_DEEP_ZOOM_MAX_PIXELS: '100000000',
                    [key]: '0'
                })
            ).toThrow();
        }
    });

    test('uses do-image pixel/edge thresholds, with equality staying on the standard path', () => {
        expect(enabled).toEqual({
            enabled: true,
            tilePixels: 24_000_000,
            tileEdge: 8192,
            maxPixels: 100_000_000
        });
        expect(
            classifyNewImageUpload({ format: 'jpeg', width: 6000, height: 4000 }, enabled)
        ).toEqual({ kind: 'standard' });
        expect(
            classifyNewImageUpload({ format: 'jpeg', width: 6001, height: 4000 }, enabled)
        ).toEqual({ kind: 'deep-zoom', width: 6001, height: 4000 });
        expect(classifyNewImageUpload({ format: 'png', width: 8192, height: 1 }, enabled)).toEqual({
            kind: 'standard'
        });
        expect(classifyNewImageUpload({ format: 'png', width: 8193, height: 1 }, enabled)).toEqual({
            kind: 'deep-zoom',
            width: 8193,
            height: 1
        });
    });

    test('classifies decoded TIFF even when small, and keeps SVG on the existing path', () => {
        expect(classifyNewImageUpload({ format: 'tiff', width: 20, height: 30 }, enabled)).toEqual({
            kind: 'deep-zoom',
            width: 20,
            height: 30
        });
        expect(
            classifyNewImageUpload({ format: 'svg', width: 100000, height: 100000 }, enabled)
        ).toEqual({ kind: 'standard' });
    });

    test('normalizes orientations 5–8 without changing the area', () => {
        for (let orientation = 1; orientation <= 8; orientation++) {
            const swapped = orientation >= 5;
            expect(
                classifyNewImageUpload(
                    { format: 'tiff', width: 1200, height: 650, orientation },
                    enabled
                )
            ).toEqual({
                kind: 'deep-zoom',
                width: swapped ? 650 : 1200,
                height: swapped ? 1200 : 650
            });
        }
    });

    test('keeps small animations standard but rejects tiled animations and multipage TIFF', () => {
        expect(
            classifyNewImageUpload(
                { format: 'gif', width: 100, height: 10000, pageHeight: 100, pages: 100 },
                enabled
            )
        ).toEqual({ kind: 'standard' });
        for (const format of ['gif', 'webp', 'tiff']) {
            expect(() =>
                classifyNewImageUpload({ format, width: 9000, height: 100, pages: 2 }, enabled)
            ).toThrow('single-frame');
        }
        expect(() =>
            classifyNewImageUpload({ format: 'tiff', width: 10, height: 10, pages: 2 }, enabled)
        ).toThrow('single-frame');
    });

    test('rejects over-budget tiled inputs and invalid dimensions before pixel decoding', () => {
        expect(
            classifyNewImageUpload({ format: 'png', width: 10000, height: 10000 }, enabled).kind
        ).toBe('deep-zoom');
        expect(() =>
            classifyNewImageUpload({ format: 'png', width: 10001, height: 10000 }, enabled)
        ).toThrow('MAX_PIXELS');
        for (const width of [undefined, 0, -1, 1.5, Infinity, NaN]) {
            expect(() =>
                classifyNewImageUpload({ format: 'png', width, height: 100 }, enabled)
            ).toThrow('dimensions');
        }
    });

    test('the Deep Zoom budget does not change ordinary image policy', () => {
        const smallBudget: ImageUploadPolicy = {
            enabled: true,
            tilePixels: 24_000_000,
            tileEdge: 8192,
            maxPixels: 100
        };
        expect(
            classifyNewImageUpload({ format: 'png', width: 200, height: 200 }, smallBudget)
        ).toEqual({ kind: 'standard' });
        expect(() =>
            classifyNewImageUpload({ format: 'tiff', width: 200, height: 200 }, smallBudget)
        ).toThrow('MAX_PIXELS');
    });
});

describe('Sharp upload inspection', () => {
    const policy = readImageUploadPolicy({
        IMAGE_DEEP_ZOOM_UPLOADS_ENABLED: 'true',
        IMAGE_DEEP_ZOOM_TILE_PIXELS: '100',
        IMAGE_DEEP_ZOOM_MAX_PIXELS: '1000000'
    });

    let directory: string;

    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'vizzy-image-policy-'));
    });

    afterAll(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    test('closed gate does no file IO', async () => {
        expect(
            await inspectNewImageUpload(join(directory, 'does-not-exist'), { enabled: false })
        ).toEqual({ kind: 'standard' });
    });

    test('uses actual encoding and EXIF orientation despite the filename', async () => {
        const file = join(directory, 'misnamed.png');
        await sharp({ create: { width: 30, height: 20, channels: 3, background: 'red' } })
            .jpeg()
            .withMetadata({ orientation: 6 })
            .toFile(file);
        expect(await inspectNewImageUpload(file, policy)).toEqual({
            kind: 'deep-zoom',
            width: 20,
            height: 30
        });
    });

    test('keeps small raster and SVG uploads on their existing path', async () => {
        const small = join(directory, 'small.tiff');
        await sharp({ create: { width: 5, height: 5, channels: 3, background: 'blue' } })
            .png()
            .toFile(small);
        expect(await inspectNewImageUpload(small, policy)).toEqual({ kind: 'standard' });
        const svg = join(directory, 'vector.svg');
        await writeFile(
            svg,
            '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000"/></svg>'
        );
        expect(await inspectNewImageUpload(svg, policy)).toEqual({ kind: 'standard' });
    });

    test('recognizes a small TIFF regardless of its extension', async () => {
        const file = join(directory, 'actually-tiff.jpg');
        await sharp({ create: { width: 5, height: 5, channels: 3, background: 'red' } })
            .tiff()
            .toFile(file);
        expect(await inspectNewImageUpload(file, policy)).toEqual({
            kind: 'deep-zoom',
            width: 5,
            height: 5
        });
    });

    test('rejects undecodable input instead of guessing from an extension', async () => {
        const file = join(directory, 'broken.jpg');
        await writeFile(file, 'not an image');
        await rejects(inspectNewImageUpload(file, policy));
    });
});

describe('Media access and tile responses', () => {
    const member = { user: { email: 'member@example.com', role: 'user' as const } };

    const device = { device: { id: 'wall-device', kind: 'wall' as const, wallId: 'wall-a' } };

    const fixture = (
        patch: {
            visibility?: string;
            published?: boolean;
            deleted?: boolean;
            boundProjectId?: string;
        } = {}
    ) => ({
        project: async () => ({
            visibility: patch.visibility ?? 'private',
            stages: [{ publishedCommitId: patch.published ? 'commit' : null }],
            deletedAt: patch.deleted ? 1 : undefined
        }),
        canView: async (actor: NonNullable<AuthContext['user']>) =>
            actor.email === member.user.email,
        wall: async () => ({ boundProjectId: patch.boundProjectId ?? 'project-a' })
    });

    test('private media permits project members/admins and a device only for its current wall binding', async () => {
        const asset = { projectId: 'project-a' };
        expect(await evaluateAssetReadAccess(asset, {}, fixture())).toMatchObject({
            allowed: false
        });
        expect(await evaluateAssetReadAccess(asset, member, fixture())).toMatchObject({
            allowed: true,
            public: false
        });
        expect(
            await evaluateAssetReadAccess(
                asset,
                { user: { email: 'other@example.com', role: 'user' } },
                fixture()
            )
        ).toMatchObject({ allowed: false });
        expect(
            await evaluateAssetReadAccess(
                asset,
                { user: { email: 'admin@example.com', role: 'admin' } },
                fixture()
            )
        ).toMatchObject({ allowed: true });
        expect(await evaluateAssetReadAccess(asset, device, fixture())).toMatchObject({
            allowed: true,
            public: false
        });
        expect(
            await evaluateAssetReadAccess(
                asset,
                device,
                fixture({ boundProjectId: 'other-project' })
            )
        ).toMatchObject({ allowed: false });
        expect(
            await evaluateAssetReadAccess(
                asset,
                { device: { id: 'wall-device', kind: 'wall' } },
                fixture()
            )
        ).toMatchObject({ allowed: false });
    });

    test('public media rules match original files; public but unpublished projects still require authorization', async () => {
        expect(
            await evaluateAssetReadAccess({ projectId: 'project-a', public: true }, {}, fixture())
        ).toMatchObject({ allowed: true, public: true });
        expect(
            await evaluateAssetReadAccess({ projectId: PUBLIC_ASSET_PROJECT_ID }, {}, fixture())
        ).toMatchObject({ allowed: true, public: true });
        expect(
            await evaluateAssetReadAccess(
                { projectId: 'project-a' },
                {},
                fixture({ visibility: 'public', published: true })
            )
        ).toMatchObject({ allowed: true, public: true });
        expect(
            await evaluateAssetReadAccess(
                { projectId: 'project-a' },
                {},
                fixture({ visibility: 'public' })
            )
        ).toMatchObject({ allowed: false });
        expect(
            await evaluateAssetReadAccess(
                { projectId: 'project-a' },
                member,
                fixture({ deleted: true })
            )
        ).toMatchObject({ allowed: false, missing: true });
    });

    test('original asset denials retain their diagnostics and wall audit context', async () => {
        const asset = { projectId: 'project-a' };
        const other = { user: { email: 'other@example.com', role: 'user' as const } };
        const cases = [
            [
                evaluateAssetReadAccess({}, member, fixture()),
                {
                    missing: true,
                    reason: 'ASSET_PROJECT_NOT_FOUND',
                    statusMessage: 'Project Not Found',
                    projectId: null
                }
            ],
            [
                evaluateAssetReadAccess(asset, member, fixture({ deleted: true })),
                {
                    missing: true,
                    reason: 'ASSET_PROJECT_NOT_FOUND',
                    statusMessage: 'Project Not Found',
                    projectId: 'project-a'
                }
            ],
            [
                evaluateAssetReadAccess(asset, {}, fixture()),
                { reason: 'UNAUTHORIZED_GUEST', statusMessage: 'Unauthorized Guest' }
            ],
            [
                evaluateAssetReadAccess(asset, other, fixture()),
                { reason: 'PROJECT_VIEW_FORBIDDEN', statusMessage: 'Unauthorized' }
            ],
            [
                evaluateAssetReadAccess(
                    asset,
                    { device: { id: 'wall-device', kind: 'wall' } },
                    fixture()
                ),
                { reason: 'DEVICE_WALL_ID_MISSING', statusMessage: 'Unauthorized Device' }
            ],
            [
                evaluateAssetReadAccess(asset, device, fixture({ boundProjectId: 'other' })),
                {
                    reason: 'DEVICE_WALL_NOT_BOUND_TO_PROJECT',
                    statusMessage: 'Unauthorized Wall',
                    details: { wallId: 'wall-a' }
                }
            ]
        ] as const;
        for (const [result, expected] of cases)
            expect(await result).toMatchObject({ allowed: false, ...expected });
    });

    test('a simultaneous user and device keeps the original wall binding requirement', async () => {
        const asset = { projectId: 'project-a' };
        for (const role of ['user', 'admin'] as const) {
            const auth = { ...device, user: { email: 'other@example.com', role } };
            expect(await evaluateAssetReadAccess(asset, auth, fixture())).toMatchObject({
                allowed: true,
                public: false
            });
            expect(
                await evaluateAssetReadAccess(asset, auth, fixture({ boundProjectId: 'other' }))
            ).toMatchObject({ allowed: false, reason: 'DEVICE_WALL_NOT_BOUND_TO_PROJECT' });
        }
    });

    const image: ImageDeepZoomAsset = {
        schemaVersion: 1,
        width: 1200,
        height: 650,
        status: 'ready',
        tiles: { tileSize: 512, maxZoom: 2, format: 'webp', sourceId: 'img_fixture_v1' }
    };

    test('tile paths bind the asset to a source version and validate the image pyramid, not the square map grid', () => {
        const prefix = '507f1f77bcf86cd799439011/img_fixture_v1';
        const valid = parseImageTilePath(`${prefix}/2/2/1`)!;
        expect(isImageTileInBounds(image, valid)).toBe(true);
        for (const suffix of ['2/2/2', '2/3/1', '3/0/0', '0/1/0'])
            expect(isImageTileInBounds(image, parseImageTilePath(`${prefix}/${suffix}`)!)).toBe(
                false
            );
        expect(isImageTileInBounds(image, { ...valid, sourceId: 'other_v1' })).toBe(false);
        expect(
            isImageTileInBounds(
                { schemaVersion: 1, width: 1200, height: 650, status: 'processing' },
                valid
            )
        ).toBe(false);
        for (const suffix of [
            '../0/0',
            '-1/0/0',
            '2/NaN/0',
            '2/0/0?url=http://example.com',
            '02/0/0',
            '2/1e3/0'
        ])
            expect(parseImageTilePath(`${prefix}/${suffix}`)).toBeNull();
    });

    test('tile proxy accepts bounded WebP data and rejects redirects, wrong formats and oversized bodies', async () => {
        const webp = new TextEncoder().encode('RIFF0000WEBPfixture');
        const url = new URL('http://martin/source/0/0/0');
        const signal = new AbortController().signal;
        const fetcher = (body: BodyInit, status = 200, type = 'image/webp') =>
            (async (_input, init) => {
                expect(init?.redirect).toBe('manual');
                return new Response(body, { status, headers: { 'content-type': type } });
            }) as typeof fetch;
        expect(await fetchImageTile(url, signal, fetcher(webp))).toEqual(webp);
        await rejects(fetchImageTile(url, signal, fetcher('redirect', 302)));
        await rejects(fetchImageTile(url, signal, fetcher('<html/>', 200, 'text/html')));
        await rejects(fetchImageTile(url, signal, fetcher('bad webp')));
        await rejects(fetchImageTile(url, signal, fetcher(new Uint8Array(2 * 1024 * 1024 + 1))));
    });
});

describe('Image processing lifecycle audits', () => {
    const projectId = 'a'.repeat(24);
    const assetId = 'b'.repeat(24);
    const createdBy = 'uploader@example.test';
    const audits: AuditLogInput[] = [];
    const order: string[] = [];
    let job: JobDocument;
    let abortCommit = false;
    let transactionAttempts = 1;
    let directory: string;
    let repo: typeof import('../../src/lib/jobs/repo');
    const matched = { matchedCount: 1 };
    const store = {
        db: {
            client: {
                withSession: async (operation: (session: unknown) => Promise<unknown>) =>
                    operation({
                        withTransaction: async (transaction: () => Promise<unknown>) => {
                            let result: unknown;
                            for (let attempt = 0; attempt < transactionAttempts; attempt++)
                                result = await transaction();
                            if (abortCommit) throw new Error('Commit failed');
                            order.push('committed');
                            return result;
                        }
                    })
            }
        },
        dbCol: {
            assets: {
                findDeepZoomUpload: mock(async () => ({ projectId, createdBy })),
                updateDeepZoomJob: mock(async () => true)
            },
            audits: {
                insertLog: mock(async (event: AuditLogInput) => {
                    order.push('audited');
                    audits.push(event);
                })
            }
        },
        collections: {
            jobs: {
                updateOne: mock(async (..._args: unknown[]) => matched),
                find: mock((_filter: unknown) => ({
                    async *[Symbol.asyncIterator]() {
                        yield job;
                    }
                }))
            }
        }
    };

    beforeAll(async () => {
        // Bundle an isolated copy with fake DB boundaries; retain the real audit writer
        // without replacing shared modules for the rest of the unit suite.
        directory = await mkdtemp(join(tmpdir(), 'vizzy-image-audit-'));
        const key = Symbol.for(directory);
        const build = await Bun.build({
            entrypoints: [resolve(import.meta.dir, '../../src/lib/jobs/repo.ts')],
            outdir: directory,
            naming: 'repo.mjs',
            target: 'bun',
            format: 'esm',
            tsconfig: resolve(import.meta.dir, '../../tsconfig.json'),
            plugins: [
                {
                    name: 'image-audit-test-store',
                    setup(builder) {
                        builder.onResolve(
                            { filter: /^(?:@repo\/db|~\/server\/collections)$/ },
                            () => ({ path: 'store', namespace: 'image-audit-test' })
                        );
                        builder.onLoad({ filter: /.*/, namespace: 'image-audit-test' }, () => ({
                            contents: `export const { db, dbCol, collections } = globalThis[Symbol.for(${JSON.stringify(directory)})];`,
                            loader: 'js'
                        }));
                    }
                }
            ]
        });
        if (!build.success) throw new AggregateError(build.logs, 'Audit test bundle failed');
        Reflect.set(globalThis, key, store);
        try {
            repo = await import(join(directory, 'repo.mjs'));
        } finally {
            Reflect.deleteProperty(globalThis, key);
        }
    });

    afterAll(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    beforeEach(() => {
        audits.length = 0;
        order.length = 0;
        abortCommit = false;
        transactionAttempts = 1;
        store.collections.jobs.updateOne.mockReset();
        store.collections.jobs.updateOne.mockResolvedValue(matched);
        store.dbCol.assets.findDeepZoomUpload.mockReset();
        store.dbCol.assets.findDeepZoomUpload.mockResolvedValue({ projectId, createdBy });
        job = {
            _id: new ObjectId(assetId),
            nodeId: 'shared-volume',
            type: 'process_image_tiles',
            status: 'running',
            payload: {
                assetId,
                projectId,
                createdBy,
                sourceId: `img_${assetId}_v1`,
                sourceFilename: 'original.tiff',
                width: 12000,
                height: 8000,
                maxPixels: 100_000_000
            },
            attempts: 1,
            maxAttempts: 3,
            leaseOwner: 'worker-attempt',
            startedAt: new Date(Date.now() - 2000),
            runAfter: new Date(0),
            createdAt: new Date(0),
            updatedAt: new Date(0)
        };
    });

    const ready = {
        schemaVersion: 1,
        width: 12000,
        height: 8000,
        status: 'ready',
        tiles: { sourceId: `img_${assetId}_v1`, tileSize: 512, maxZoom: 5, format: 'webp' }
    } as const;
    const result = {
        sourceId: ready.tiles.sourceId,
        previewFilename: `${ready.tiles.sourceId}.webp`,
        reused: true
    };

    test('start and completion link the uploader, job and asset, with attempt duration and result', async () => {
        await repo.startImageTileJob(job, 'worker-attempt');
        expect(audits[0]).toMatchObject({
            action: 'IMAGE_TILE_PROCESSING_STARTED',
            actorId: 'system:image-worker',
            projectId,
            resourceType: 'asset',
            resourceId: assetId,
            outcome: 'success',
            changes: { status: 'running', width: 12000, height: 8000, durationMs: 0 },
            executionContext: {
                surface: 'job',
                operation: 'process_image_tiles',
                details: {
                    jobId: assetId,
                    nodeId: job.nodeId,
                    workerId: job.leaseOwner,
                    createdBy,
                    attempt: 1,
                    maxAttempts: 3
                }
            }
        });
        await repo.completeImageTileJob(job, 'worker-attempt', ready, result);
        expect(audits).toHaveLength(2);
        expect(audits[1]).toMatchObject({
            action: 'IMAGE_TILE_PROCESSING_COMPLETED',
            outcome: 'success',
            error: null,
            changes: { status: 'completed', result: { ...result, ...ready.tiles } }
        });
        expect(Number(audits[1].changes?.durationMs)).toBeGreaterThanOrEqual(2000);
        expect(order).toEqual(['committed', 'audited', 'committed', 'audited']);
        expect(store.dbCol.assets.findDeepZoomUpload).not.toHaveBeenCalled();
    });

    test.each([1, 3])(
        'attempt %i records either scheduled retry or terminal failure',
        async (attempt) => {
            job.attempts = attempt;
            await repo.failImageTileJob(job, 'worker-attempt', 'Image tile worker timed out.');
            expect(audits).toHaveLength(1);
            expect(audits[0]).toMatchObject({
                action:
                    attempt < 3
                        ? 'IMAGE_TILE_PROCESSING_RETRY_SCHEDULED'
                        : 'IMAGE_TILE_PROCESSING_FAILED',
                outcome: 'failure',
                reasonCode: 'IMAGE_PROCESSING_FAILED',
                error: 'Image tile worker timed out.'
            });
            expect(Number(audits[0].changes?.durationMs)).toBeGreaterThanOrEqual(2000);
            const update = store.collections.jobs.updateOne.mock.calls.at(-1)?.[1] as {
                $set: { status: string; runAfter: Date };
            };
            expect(update.$set.status).toBe(attempt < 3 ? 'queued' : 'failed');
            expect(audits[0].changes?.nextRetryAt).toBe(
                attempt < 3 ? update.$set.runAfter.getTime() : undefined
            );
        }
    );

    test('shutdown at the retry limit schedules a retry and records the preserved budget', async () => {
        job.attempts = job.maxAttempts;
        await repo.failImageTileJob(job, 'worker-attempt', 'Image tile worker cancelled.', true);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
            action: 'IMAGE_TILE_PROCESSING_RETRY_SCHEDULED',
            reasonCode: 'WORKER_SHUTDOWN',
            changes: { status: 'queued', retryBudgetPreserved: true }
        });
        expect(store.collections.jobs.updateOne.mock.calls.at(-1)?.[1]).toMatchObject({
            $inc: { attempts: -1 }
        });
    });

    test.each([1, 3])(
        'heartbeat recovery audits the winning transition for attempt %i',
        async (attempt) => {
            job.attempts = attempt;
            await repo.markStalledRunningJobs(120_000, { types: ['process_image_tiles'] });
            expect(audits).toHaveLength(1);
            expect(audits[0]).toMatchObject({
                action:
                    attempt < 3
                        ? 'IMAGE_TILE_PROCESSING_RETRY_SCHEDULED'
                        : 'IMAGE_TILE_PROCESSING_FAILED',
                reasonCode: 'WORKER_HEARTBEAT_STALLED',
                error: 'Job heartbeat stalled'
            });
            // Another consumer already renewed or recovered the job: no duplicate audit.
            store.collections.jobs.updateOne.mockResolvedValue({ matchedCount: 0 });
            await repo.markStalledRunningJobs(120_000);
            expect(audits).toHaveLength(1);
        }
    );

    test('transaction retries audit once, while commit failures and lost leases audit nothing', async () => {
        transactionAttempts = 2;
        await repo.completeImageTileJob(job, 'worker-attempt', ready, result);
        expect(audits).toHaveLength(1);
        expect(order).toEqual(['committed', 'audited']);
        audits.length = 0;
        abortCommit = true;
        await rejects(
            repo.completeImageTileJob(job, 'worker-attempt', ready, result),
            /Commit failed/
        );
        expect(audits).toHaveLength(0);
        abortCommit = false;
        store.collections.jobs.updateOne.mockResolvedValue({ matchedCount: 0 });
        await rejects(repo.startImageTileJob(job, 'stale-owner'), /lease was lost/);
        await rejects(repo.failImageTileJob(job, 'stale-owner', 'cancelled'), /lease was lost/);
        expect(audits).toHaveLength(0);
    });

    test('older queued jobs recover project and uploader attribution from the asset', async () => {
        const payload = job.payload as ProcessImageTilesPayload;
        delete payload.projectId;
        delete payload.createdBy;
        await repo.startImageTileJob(job, 'worker-attempt');
        expect(store.dbCol.assets.findDeepZoomUpload).toHaveBeenCalledWith(assetId);
        expect(audits[0]).toMatchObject({
            projectId,
            resourceId: assetId,
            executionContext: { details: { createdBy } }
        });
    });

    test('audit write and context lookup failures do not turn completed work into a failure', async () => {
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        try {
            store.dbCol.audits.insertLog.mockRejectedValueOnce(
                new Error('Audit storage unavailable')
            );
            await repo.completeImageTileJob(job, 'worker-attempt', ready, result);
            expect(audits).toHaveLength(0);
            delete (job.payload as ProcessImageTilesPayload).projectId;
            store.dbCol.assets.findDeepZoomUpload.mockRejectedValueOnce(
                new Error('Asset lookup unavailable')
            );
            await repo.completeImageTileJob(job, 'worker-attempt', ready, result);
            expect(audits).toHaveLength(0);
            expect(errors).toHaveBeenCalledTimes(2);
        } finally {
            errors.mockRestore();
        }
    });

    test('preview updates, heartbeats and ordinary media recovery do not emit lifecycle audits', async () => {
        await repo.updateImageTileAsset(
            job,
            'worker-attempt',
            {
                schemaVersion: 1,
                width: 12000,
                height: 8000,
                status: 'processing'
            },
            { previewUrl: result.previewFilename }
        );
        await repo.heartbeatJob(job._id, 'worker-attempt');
        job.type = 'process_image_asset';
        await repo.markStalledRunningJobs(120_000);
        expect(audits).toHaveLength(0);
    });
});

describe('Worker lifetime and queue admission', () => {
    const configuration = {
        IMAGE_DEEP_ZOOM_NODE_ID: 'persistent-volume',
        IMAGE_TILE_WORKER_NODE: process.execPath,
        IMAGE_TILE_WORKER_PATH: '/tmp/worker.mjs',
        IMAGE_MARTIN_URL: 'http://martin:3000/'
    };

    test('web can accept tiled uploads without an installed slicing runtime', () => {
        expect(
            readImageTileUploadSettings({
                IMAGE_DEEP_ZOOM_NODE_ID: 'shared-volume',
                IMAGE_MARTIN_URL: 'http://martin-images:3000/'
            })
        ).toEqual({ nodeId: 'shared-volume', martinUrl: 'http://martin-images:3000' });
        expect(() =>
            readImageTileUploadSettings({
                IMAGE_MARTIN_URL: 'http://martin-images:3000'
            })
        ).toThrow();
    });

    test('shutdown waits for an in-flight claim and never claims another job', async () => {
        let finishClaim!: (job: number | null) => void;
        let finishJob!: () => void;
        let claims = 0;
        let processed = false;
        let stopped = false;
        const drain = createConcurrentJobDrain({
            concurrency: 1,
            claim: () => {
                claims++;
                return new Promise<number | null>((resolve) => {
                    finishClaim = resolve;
                });
            },
            process: async () => {
                processed = true;
                await new Promise<void>((resolve) => {
                    finishJob = resolve;
                });
            },
            onError: (error) => {
                throw error;
            }
        });
        drain.wake();
        const stopping = drain.stop().then(() => {
            stopped = true;
        });
        drain.wake();
        finishClaim(1);
        await sleep(0);
        expect(processed).toBe(true);
        expect(stopped).toBe(false);
        finishJob();
        await stopping;
        drain.wake();
        expect(claims).toBe(1);
        expect(stopped).toBe(true);
    });

    test('an idle queue can stop before its first wake', async () => {
        let claims = 0;
        const drain = createConcurrentJobDrain({
            concurrency: 2,
            claim: async () => {
                claims++;
                return null;
            },
            process: async () => {},
            onError: () => {}
        });
        await drain.stop();
        drain.wake();
        expect(claims).toBe(0);
    });

    test('server settings distinguish job concurrency from threads and require a stable node', () => {
        expect(readImageTileSettings(configuration)).toMatchObject({
            workers: 1,
            threads: 2,
            nodeId: 'persistent-volume',
            martinUrl: 'http://martin:3000'
        });
        expect(
            readImageTileSettings({
                ...configuration,
                IMAGE_DEEP_ZOOM_WORKERS: '2',
                IMAGE_DEEP_ZOOM_THREADS: '3'
            })
        ).toMatchObject({ workers: 2, threads: 3 });
        for (const value of ['0', '-1', '1.5', '99', 'bad'])
            expect(() =>
                readImageTileSettings({ ...configuration, IMAGE_DEEP_ZOOM_WORKERS: value })
            ).toThrow();
        expect(() =>
            readImageTileSettings({ ...configuration, IMAGE_DEEP_ZOOM_NODE_ID: '' })
        ).toThrow();
        expect(() =>
            readImageTileSettings({ ...configuration, IMAGE_TILE_WORKER_NODE: 'bun' })
        ).toThrow();
    });

    test('repeated queue notifications cannot exceed the configured admission limit', async () => {
        const queued = [1, 2, 3, 4, 5];
        let active = 0,
            peak = 0,
            completed = 0;
        const failures: unknown[] = [];
        const drain = createConcurrentJobDrain({
            concurrency: 2,
            claim: async () => {
                await sleep(1);
                return queued.shift() ?? null;
            },
            process: async () => {
                active++;
                peak = Math.max(peak, active);
                await sleep(5);
                active--;
                completed++;
            },
            onError: (error) => {
                failures.push(error);
            }
        });
        for (let i = 0; i < 50; i++) drain.wake();
        for (let i = 0; i < 100 && completed < 5; i++) await sleep(2);
        expect(completed).toBe(5);
        expect(peak).toBe(2);
        expect(failures).toEqual([]);
    });

    test('a failed task releases its slot for the next job', async () => {
        const jobs = [1, 2];
        let completed = false;
        const failures: unknown[] = [];
        createConcurrentJobDrain({
            concurrency: 1,
            claim: async () => jobs.shift() ?? null,
            process: async (job) => {
                if (job === 1) throw new Error('failed');
                completed = true;
            },
            onError: (error) => {
                failures.push(error);
            }
        }).wake();
        await sleep(5);
        expect(completed).toBe(true);
        expect(failures).toHaveLength(1);
    });

    let directory: string;

    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'vizzy-tile-runner-'));
    });

    afterAll(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    async function workerInput(script: string) {
        const workerPath = join(directory, 'fixture.mjs');
        await writeFile(workerPath, script);
        return {
            payload: {
                assetId: 'fixture',
                sourceId: 'img_fixture_v1',
                sourceFilename: 'fixture.png',
                width: 10,
                height: 10,
                maxPixels: 100
            },
            dataDir: directory,
            assetDir: directory,
            settings: { ...readImageTileSettings(configuration), workerPath, timeoutMs: 1000 },
            signal: new AbortController().signal,
            onPreview: async () => {}
        };
    }

    test('worker timeout waits for exit and cleans its own scratch directory', async () => {
        const input = await workerInput('setInterval(() => {}, 10000);');
        await rejects(
            runImageTileWorker({ ...input, settings: { ...input.settings, timeoutMs: 50 } }),
            /timed out/
        );
        expect(await readdir(join(directory, 'image-tile-work'))).toEqual([]);
    });

    test('lease cancellation kills processing and removes its scratch directory', async () => {
        const input = await workerInput('setInterval(() => {}, 10000);');
        const controller = new AbortController();
        const running = runImageTileWorker({ ...input, signal: controller.signal });
        const timer = setTimeout(() => controller.abort(), 50);
        try {
            await rejects(running, /cancelled/);
        } finally {
            clearTimeout(timer);
        }
        expect(await readdir(join(directory, 'image-tile-work'))).toEqual([]);
    });

    test('malformed worker output fails without leaving a child or temporary files', async () => {
        const input = await workerInput(
            'console.log("invalid json"); setInterval(() => {}, 10000);'
        );
        await rejects(runImageTileWorker(input));
        expect(await readdir(join(directory, 'image-tile-work'))).toEqual([]);
    });

    test('restart cleanup preserves active, recent, unknown and symlinked files', async () => {
        const dataDir = await mkdtemp(join(directory, 'cleanup-'));
        const root = join(dataDir, 'image-tile-work');
        await mkdir(root);
        const id = 'a'.repeat(24);
        const activeId = 'b'.repeat(24);
        const stale = `img_${id}_v1-stale1`;
        const recent = `img_${id}_v1-newone`;
        const active = `img_${activeId}_v1-active`;
        const linked = `img_${id}_v1-linked`;
        for (const name of [stale, recent, active, 'unrecognized']) {
            const path = join(root, name);
            await mkdir(path);
            await writeFile(join(path, 'keep'), 'fixture');
            if (name !== recent) await utimes(path, new Date(0), new Date(0));
        }
        await symlink(join(root, 'unrecognized'), join(root, linked));
        const checked: string[] = [];
        await cleanImageTileScratch({
            dataDir,
            timeoutMs: 1000,
            canRemove: async (candidate) => {
                checked.push(candidate);
                return candidate === id;
            }
        });
        expect((await readdir(root)).sort()).toEqual(
            [recent, active, linked, 'unrecognized'].sort()
        );
        expect(checked.sort()).toEqual([id, activeId].sort());
    });
});
