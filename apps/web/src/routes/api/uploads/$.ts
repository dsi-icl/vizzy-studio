import { copyFile, open, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { extname, join } from 'node:path';

import { createFileRoute } from '@tanstack/react-router';
import { FileStore } from '@tus/file-store';
import { Server } from '@tus/server';

import {
    ASSET_MIME_TYPES,
    SUPPORTED_FONT_EXTS,
    SUPPORTED_IMAGE_EXTS,
    SUPPORTED_VIDEO_EXTS
} from '~/lib/assetMime';
import { PUBLIC_ASSET_PROJECT_ID } from '~/lib/constants';
import { enqueueJob } from '~/lib/jobs/repo';
import { jobSignalBus } from '~/lib/jobs/signalBus';
import { UPLOAD_DIR, TMP_DIR, ASSET_DIR } from '~/lib/serverVariables';
import { validateUploadToken } from '~/lib/uploadTokens';
import { logAuditDenied, logAuditFailure, logAuditSuccess } from '~/server/audit';
import { dbCol } from '~/server/collections';
import {
    buildRateLimitSubjectKey,
    checkRateLimit,
    getClientIpFromHeaders
} from '~/server/rateLimit';

const STRICT_BLOCKING = !['0', 'false', 'off', 'no'].includes(
    (process.env.STRICT_BLOCKING || 'true').toLowerCase()
);
const LOCAL_NODE_ID = hostname();

type DetectedType = 'image' | 'video' | 'woff2' | null;

function detectMediaType(bytes: Uint8Array): DetectedType {
    const len = bytes.length;

    // JPEG: FF D8 FF
    if (len >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image';
    // PNG: 89 50 4E 47
    if (
        len >= 4 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
    )
        return 'image';
    // GIF: 47 49 46
    if (len >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image';
    // WebP: RIFF????WEBP
    if (
        len >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    )
        return 'image';
    // BMP: 42 4D
    if (len >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image';
    // MP4/MOV: 'ftyp' box at offset 4
    if (
        len >= 8 &&
        bytes[4] === 0x66 &&
        bytes[5] === 0x74 &&
        bytes[6] === 0x79 &&
        bytes[7] === 0x70
    )
        return 'video';
    // WebM: 1A 45 DF A3
    if (
        len >= 4 &&
        bytes[0] === 0x1a &&
        bytes[1] === 0x45 &&
        bytes[2] === 0xdf &&
        bytes[3] === 0xa3
    )
        return 'video';
    // WOFF2: 77 4F 46 32 ('wOF2')
    if (
        len >= 4 &&
        bytes[0] === 0x77 &&
        bytes[1] === 0x4f &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x32
    )
        return 'woff2';
    return null;
}

async function readHeaderBytes(filePath: string, size = 12): Promise<Uint8Array> {
    const file = await open(filePath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(size);
        const { bytesRead } = await file.read(buffer, 0, size, 0);
        return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
    } finally {
        await file.close();
    }
}

const MAX_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

const tusServer = new Server({
    path: '/api/uploads',
    maxSize: MAX_UPLOAD_SIZE,
    // Reverse proxies may terminate TLS before reaching the app process.
    // Emit same-origin relative upload URLs to avoid mixed-content redirects
    // (https page following an http Location header).
    respectForwardedHeaders: true,
    generateUrl: (_req, { path, id }) => `${path}/${id}`,
    datastore: new FileStore({ directory: UPLOAD_DIR }),
    async onUploadCreate(_req, upload) {
        const uploadToken = upload.metadata?.uploadToken;
        if (!uploadToken) {
            throw { status_code: 401, body: 'Missing upload token' };
        }
        const tokenData = validateUploadToken(uploadToken);
        if (!tokenData) {
            throw { status_code: 401, body: 'Invalid or expired upload token' };
        }
        return { metadata: upload.metadata };
    },
    async onUploadFinish(req, upload) {
        const tusFilePath = join(UPLOAD_DIR, upload.id);
        const uploaderIp = getClientIpFromHeaders(req.headers);

        const auditExecutionContext = {
            surface: 'http' as const,
            operation: 'tus.onUploadFinish',
            method: 'POST',
            path: '/api/uploads/$',
            ip: uploaderIp
        };

        try {
            const originalName = upload.metadata?.filename ?? upload.id;
            const ext = extname(originalName).toLowerCase();
            const numericId = parseInt(upload.metadata?.numericId ?? '0') || 0;
            const duration = parseFloat(upload.metadata?.duration ?? '0') || 0;

            // Resolve project identity from the upload token only.
            const uploadToken = upload.metadata?.uploadToken;
            if (!uploadToken) {
                await logAuditDenied({
                    action: 'UPLOAD_FINALIZE_DENIED',
                    resourceType: 'upload_token',
                    resourceId: upload.id,
                    reasonCode: 'MISSING_UPLOAD_TOKEN',
                    authContext: { guest: true },
                    executionContext: auditExecutionContext
                });
                console.warn('[Tus] Upload rejected: missing upload token');
                throw new Error('Missing upload token');
            }
            const tokenData = validateUploadToken(uploadToken);
            if (!tokenData) {
                await logAuditDenied({
                    action: 'UPLOAD_FINALIZE_DENIED',
                    resourceType: 'upload_token',
                    resourceId: upload.id,
                    reasonCode: 'INVALID_UPLOAD_TOKEN',
                    authContext: { guest: true },
                    executionContext: auditExecutionContext
                });
                console.warn('[Tus] Upload rejected: invalid or expired token');
                throw new Error('Invalid or expired upload token');
            }
            const projectId = tokenData.projectId;
            const userEmail = tokenData.userEmail;

            const uploadFinalizeRate = checkRateLimit({
                subjectKey: buildRateLimitSubjectKey({
                    actorId: userEmail,
                    ip: uploaderIp
                })
            });
            if (!uploadFinalizeRate.allowed) {
                await logAuditDenied({
                    action: 'UPLOAD_FINALIZE_DENIED',
                    actorId: userEmail,
                    projectId,
                    resourceType: 'upload_token',
                    resourceId: upload.id,
                    reasonCode: 'RATE_LIMITED',
                    authContext: { user: { email: userEmail, role: 'user' } },
                    executionContext: auditExecutionContext,
                    changes: { retryAfterMs: uploadFinalizeRate.retryAfterMs }
                });
                throw new Error('Upload finalize rate limit exceeded');
            }

            // Detect type via magic bytes
            const headerBytes = await readHeaderBytes(tusFilePath, 48);
            const detectedType = detectMediaType(headerBytes);

            const isImage =
                detectedType === 'image' ||
                (detectedType === null &&
                    SUPPORTED_IMAGE_EXTS.has(ext) &&
                    !SUPPORTED_VIDEO_EXTS.has(ext));
            const isVideo =
                detectedType === 'video' ||
                (detectedType === null &&
                    SUPPORTED_VIDEO_EXTS.has(ext) &&
                    !SUPPORTED_IMAGE_EXTS.has(ext));
            const isFontWoff2 =
                detectedType === 'woff2' || (detectedType === null && SUPPORTED_FONT_EXTS.has(ext));

            let assetFilename: string | null = null;
            let previewFilename: string | null = null;
            let blurhash: string | null = null;
            let mimeType: string | null = null;
            let sizes: number[] = [];

            if (isImage) {
                // ── Image: copy with upload.id-based name ──
                assetFilename = `${upload.id}${ext}`;
                const finalPath = join(ASSET_DIR, assetFilename);
                await copyFile(tusFilePath, finalPath);

                mimeType = ASSET_MIME_TYPES[ext] ?? `image/${ext.slice(1)}`;
                const imageJobId = await enqueueJob({
                    nodeId: LOCAL_NODE_ID,
                    type: 'process_image_asset',
                    payload: {
                        uploadId: upload.id,
                        sourceExt: ext,
                        sourceFilename: assetFilename
                    }
                });
                if (STRICT_BLOCKING) {
                    const imageJob = await jobSignalBus.waitForTerminal(imageJobId);
                    if (imageJob.status !== 'completed') {
                        throw new Error(imageJob.error || 'Image processing job failed');
                    }
                    const result = imageJob.result as
                        { blurhash?: string; sizes?: number[] } | undefined;
                    blurhash = result?.blurhash ?? null;
                    sizes = result?.sizes ?? [];
                }
            } else if (isVideo) {
                // ── Video: transcode + generate preview ──
                assetFilename = `${upload.id}.mp4`;
                const rawPath = join(TMP_DIR, `${upload.id}_raw${ext}`);
                previewFilename = `${upload.id}.jpg`;

                await copyFile(tusFilePath, rawPath);

                const videoJobId = await enqueueJob({
                    nodeId: LOCAL_NODE_ID,
                    type: 'process_video_asset',
                    payload: {
                        uploadId: upload.id,
                        sourceFilename: `${upload.id}_raw${ext}`,
                        sourceExt: ext,
                        duration,
                        numericId
                    }
                });
                if (STRICT_BLOCKING) {
                    const videoJob = await jobSignalBus.waitForTerminal(videoJobId);
                    if (videoJob.status !== 'completed') {
                        throw new Error(videoJob.error || 'Video processing job failed');
                    }
                    const result = videoJob.result as
                        | { blurhash?: string; sizes?: number[]; previewFilename?: string }
                        | undefined;
                    blurhash = result?.blurhash ?? null;
                    sizes = result?.sizes ?? [];
                    previewFilename = result?.previewFilename ?? previewFilename;
                }

                mimeType = ASSET_MIME_TYPES['.mp4'];
            } else if (isFontWoff2) {
                assetFilename = `${upload.id}.woff2`;
                const finalPath = join(ASSET_DIR, assetFilename);
                await copyFile(tusFilePath, finalPath);
                mimeType = ASSET_MIME_TYPES['.woff2'];
            } else {
                throw new Error(
                    `Unsupported upload type: name=${originalName}, ext=${ext}, uploadId=${upload.id}`
                );
            }

            // ── Create asset record in DB ──
            if (assetFilename) {
                const fileSize =
                    (await stat(join(ASSET_DIR, assetFilename)).catch(() => null))?.size ??
                    upload.size ??
                    0;

                const isPublicAsset = projectId === PUBLIC_ASSET_PROJECT_ID;
                const created = await dbCol.assets.insert({
                    projectId,
                    name: originalName,
                    url: assetFilename,
                    size: fileSize,
                    mimeType,
                    blurhash,
                    previewUrl: previewFilename ?? undefined,
                    sizes: sizes.length > 0 ? sizes : undefined,
                    public: isPublicAsset,
                    createdBy: userEmail
                });
                await logAuditSuccess({
                    action: 'UPLOAD_FINALIZED',
                    actorId: userEmail,
                    projectId,
                    resourceType: 'asset',
                    resourceId: created.id,
                    changes: {
                        name: originalName,
                        url: assetFilename,
                        mimeType,
                        public: isPublicAsset
                    }
                });

                // Broadcast to all editors on this project via bus bridge
                console.log(
                    `[Tus] Broadcasting asset_added: bridge=${!!process.__BROADCAST_ASSET_ADDED__}, projectId=${projectId}`
                );
                if (process.__BROADCAST_ASSET_ADDED__) {
                    process.__BROADCAST_ASSET_ADDED__(projectId, {
                        id: created.id,
                        name: originalName,
                        url: assetFilename,
                        size: fileSize,
                        mimeType: mimeType ?? undefined,
                        blurhash: blurhash ?? undefined,
                        previewUrl: previewFilename ?? undefined,
                        sizes: sizes.length > 0 ? sizes : undefined,
                        createdAt: String(Date.now()),
                        createdBy: userEmail
                    });
                }

                console.log(
                    `[Tus] Asset created: ${assetFilename} (blurhash: ${blurhash ? 'yes' : 'no'}, sizes: [${sizes.join(', ')}])`
                );
            }

            return {};
        } catch (err) {
            await logAuditFailure({
                action: 'UPLOAD_FINALIZE_FAILED',
                resourceType: 'asset',
                resourceId: upload.id,
                error: err instanceof Error ? err.message : String(err),
                authContext: { guest: true },
                executionContext: auditExecutionContext
            });
            console.error('[Tus] onUploadFinish error:', err);
            throw err instanceof Error ? err : new Error(String(err));
        } finally {
            // Clean up the raw tus upload (keep .json metadata for reference)
            await unlink(tusFilePath).catch(() => {});
        }
    }
});

function handleTus({ request }: { request: Request }) {
    return tusServer.handleWeb(request);
}

export const Route = createFileRoute('/api/uploads/$')({
    server: {
        handlers: {
            ANY: handleTus
        }
    }
});
