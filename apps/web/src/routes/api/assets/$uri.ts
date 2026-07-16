import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { basename, join, extname } from 'path';

import type { PublicDoc } from '@repo/db/collections';
import type { AssetDocument, JsonValue } from '@repo/db/documents';
import { createFileRoute } from '@tanstack/react-router';
import { createServerOnlyFn } from '@tanstack/react-start';

import { ASSET_MIME_TYPES } from '~/lib/assetMime';
import { PUBLIC_ASSET_PROJECT_ID } from '~/lib/constants';
import { ASSET_DIR } from '~/lib/serverVariables';
import { logAuditDenied, logAuditFailure } from '~/server/audit';
import { dbCol } from '~/server/collections';
import { canViewProject } from '~/server/projectAuthz';
import type { AuthContext } from '~/server/requestAuthContext';
import { resolveWallMediaCookieAuthContext } from '~/server/wallMediaCookie';

const isDev = process.env.NODE_ENV === 'development';
async function logAssetDenied(input: {
    request: Request;
    authContext: AuthContext;
    reasonCode: string;
    projectId?: string | null;
    resourceId?: string | null;
    details?: Record<string, JsonValue>;
    statusMessage?: string;
}) {
    await logAuditDenied({
        action: 'ASSET_READ_DENIED',
        projectId: input.projectId ?? null,
        resourceType: 'asset',
        resourceId: input.resourceId ?? null,
        reasonCode: input.reasonCode,
        statusMessage: input.statusMessage,
        authContext: input.authContext,
        ...(input.details ? { changes: input.details } : {}),
        executionContext: {
            surface: 'http',
            operation: 'GET /api/assets/$uri',
            request: input.request
        }
    });
}

async function logAssetNotFound(input: {
    request: Request;
    authContext: AuthContext;
    reasonCode: string;
    projectId?: string | null;
    resourceId?: string | null;
    details?: Record<string, JsonValue>;
    statusMessage?: string;
}) {
    await logAuditFailure({
        action: 'ASSET_READ_NOT_FOUND',
        projectId: input.projectId ?? null,
        resourceType: 'asset',
        resourceId: input.resourceId ?? null,
        reasonCode: input.reasonCode,
        statusMessage: input.statusMessage,
        authContext: input.authContext,
        ...(input.details ? { changes: input.details } : {}),
        executionContext: {
            surface: 'http',
            operation: 'GET /api/assets/$uri',
            request: input.request
        }
    });
}

function parseVariantFilename(filename: string): { baseId: string; requested: number } | null {
    const m = filename.match(/^(.*)_([0-9]+)\.webp$/i);
    if (!m) return null;
    const requested = parseInt(m[2], 10);
    if (!Number.isFinite(requested) || requested <= 0) return null;
    return { baseId: m[1], requested };
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeProjectId(value: unknown): string | null {
    if (typeof value === 'string' && value.length > 0) return value;
    return null;
}

async function chooseVariantFallbackFilename(requestedFilename: string): Promise<string | null> {
    const parsed = parseVariantFilename(requestedFilename);
    if (!parsed) return null;

    const { baseId, requested } = parsed;
    const escapedBase = escapeRegex(baseId);

    const assetMeta = await dbCol.assets.findOne({
        $or: [
            { url: { $regex: `^${escapedBase}\\.[^.]+$`, $options: 'i' } },
            { previewUrl: { $regex: `^${escapedBase}\\.[^.]+$`, $options: 'i' } }
        ]
    });
    if (!assetMeta) return null;

    const sizes = Array.from(
        new Set(
            (Array.isArray(assetMeta.sizes) ? assetMeta.sizes : [])
                .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
                .map((n) => Math.round(n))
        )
    ).sort((a, b) => a - b);

    const smallerOrEqualDesc = sizes.filter((s) => s <= requested).sort((a, b) => b - a);
    const largerAsc = sizes.filter((s) => s > requested).sort((a, b) => a - b);
    const candidateSizes = [...smallerOrEqualDesc, ...largerAsc];

    for (const size of candidateSizes) {
        const candidate = `${baseId}_${size}.webp`;
        const candidatePath = join(ASSET_DIR, candidate);
        const exists = await stat(candidatePath)
            .then((s) => s.isFile())
            .catch(() => false);
        if (exists) return candidate;
    }

    const baseOriginal = assetMeta.previewUrl || assetMeta.url || null;
    if (!baseOriginal) return null;
    const basePath = join(ASSET_DIR, baseOriginal);
    const baseExists = await stat(basePath)
        .then((s) => s.isFile())
        .catch(() => false);
    return baseExists ? baseOriginal : null;
}

async function getAssetRecordForFilename(
    filename: string
): Promise<PublicDoc<AssetDocument> | null> {
    const exact = await dbCol.assets.findOne({
        $or: [{ url: filename }, { previewUrl: filename }]
    });
    if (exact) return exact;

    const parsed = parseVariantFilename(filename);
    if (!parsed) return null;
    const escapedBase = escapeRegex(parsed.baseId);
    return dbCol.assets.findOne({
        $or: [
            { url: { $regex: `^${escapedBase}\\.[^.]+$`, $options: 'i' } },
            { previewUrl: { $regex: `^${escapedBase}\\.[^.]+$`, $options: 'i' } }
        ]
    });
}

const getResponse = createServerOnlyFn(
    async ({
        uri,
        range,
        ifNoneMatch,
        request,
        authContext,
        projectId,
        resourceId,
        cacheControl
    }: {
        uri: string;
        range: string | null;
        ifNoneMatch: string | null;
        request: Request;
        authContext: AuthContext;
        projectId: string | null;
        resourceId: string | null;
        cacheControl: string;
    }) => {
        const requestedFilename = basename(decodeURIComponent(uri));
        let resolvedFilename = requestedFilename;
        let asset = join(ASSET_DIR, resolvedFilename);

        let stats: Awaited<ReturnType<typeof stat>> | null = null;
        try {
            stats = await stat(asset);
            if (!stats.isFile()) {
                await logAssetNotFound({
                    request,
                    authContext,
                    reasonCode: 'ASSET_FILE_NOT_FOUND',
                    projectId,
                    resourceId: resourceId ?? requestedFilename
                });
                return new Response('Not Found', { status: 404 });
            }
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                const fallback = await chooseVariantFallbackFilename(requestedFilename);
                if (!fallback) {
                    await logAssetNotFound({
                        request,
                        authContext,
                        reasonCode: 'ASSET_FILE_NOT_FOUND',
                        projectId,
                        resourceId: resourceId ?? requestedFilename
                    });
                    return new Response('Not Found', { status: 404 });
                }
                resolvedFilename = fallback;
                asset = join(ASSET_DIR, resolvedFilename);
                try {
                    stats = await stat(asset);
                    if (!stats.isFile()) {
                        await logAssetNotFound({
                            request,
                            authContext,
                            reasonCode: 'ASSET_FILE_NOT_FOUND',
                            projectId,
                            resourceId: resourceId ?? requestedFilename,
                            details: { resolvedFilename }
                        });
                        return new Response('Not Found', { status: 404 });
                    }
                } catch (fallbackError: any) {
                    if (fallbackError.code === 'ENOENT') {
                        await logAssetNotFound({
                            request,
                            authContext,
                            reasonCode: 'ASSET_FILE_NOT_FOUND',
                            projectId,
                            resourceId: resourceId ?? requestedFilename,
                            details: { resolvedFilename }
                        });
                        return new Response('Not Found', { status: 404 });
                    }
                    console.error('File system fallback error:', fallbackError);
                    return new Response('Internal Server Error', { status: 500 });
                }
            } else {
                console.error('File system error:', error);
                return new Response('Internal Server Error', { status: 500 });
            }
        }

        // The upload endpoint guarantees unique filename so we use it as ETag
        const etag = `"${resolvedFilename}"`;

        // If the browser already has this exact file, short circuit here
        if (ifNoneMatch === etag) {
            return new Response(null, {
                status: 304,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    ETag: etag,
                    'Cache-Control': cacheControl
                }
            });
        }

        if (!stats) return new Response('Internal Server Error', { status: 500 });

        const fileSize = stats.size;
        const ext = extname(asset).toLowerCase();
        const contentType = ASSET_MIME_TYPES[ext] || 'application/octet-stream';

        // Set long life for downloaded assets here
        const baseHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': contentType,
            ETag: etag,
            'Cache-Control': cacheControl,
            'Accept-Ranges': 'bytes'
        };

        // If the client asks only for a range we optimise here
        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            if (start >= fileSize || end >= fileSize) {
                return new Response('Requested range not satisfiable', {
                    status: 416,
                    headers: { 'Content-Range': `bytes */${fileSize}` }
                });
            }

            const chunkSize = end - start + 1;
            const nodeStream = createReadStream(asset, { start, end });
            const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

            return new Response(webStream, {
                status: 206,
                headers: {
                    ...baseHeaders,
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Content-Length': chunkSize.toString()
                }
            });
        }

        const nodeStream = createReadStream(asset);
        const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

        return new Response(webStream, {
            status: 200,
            headers: {
                ...baseHeaders,
                'Content-Length': fileSize.toString()
            }
        });
    }
);

export const Route = createFileRoute('/api/assets/$uri')({
    server: {
        handlers: {
            GET: async ({ request, params, context }) => {
                const { uri } = params ?? {};
                let authContext: AuthContext = ((context ?? {}) as { authContext?: AuthContext })
                    .authContext ?? { guest: true };
                if (!authContext.user && !authContext.device) {
                    const mediaCookieDevice = await resolveWallMediaCookieAuthContext(request);
                    if (mediaCookieDevice) {
                        authContext = {
                            ...authContext,
                            guest: undefined,
                            device: mediaCookieDevice
                        };
                    }
                }
                if (typeof uri !== 'string' || uri.length === 0) {
                    await logAssetNotFound({
                        request,
                        authContext,
                        reasonCode: 'INVALID_ASSET_URI'
                    });
                    return new Response('Not Found', { status: 404 });
                }
                const requestedFilename = basename(decodeURIComponent(uri));
                const user = authContext.user;
                const device = authContext.device;

                const assetRecord = await getAssetRecordForFilename(requestedFilename);
                if (!assetRecord) {
                    await logAssetNotFound({
                        request,
                        authContext,
                        reasonCode: 'ASSET_RECORD_NOT_FOUND',
                        resourceId: requestedFilename,
                        statusMessage: 'Asset Not Found'
                    });
                    return new Response('Not Found', {
                        status: 404,
                        headers: isDev ? { 'X-Dev-Status-Message': 'Asset Not Found' } : undefined
                    });
                }

                const projectId = normalizeProjectId(assetRecord.projectId);
                if (!projectId) {
                    await logAssetNotFound({
                        request,
                        authContext,
                        reasonCode: 'ASSET_PROJECT_NOT_FOUND',
                        resourceId: requestedFilename,
                        statusMessage: 'Project Not Found'
                    });
                    return new Response('Not Found', {
                        status: 404,
                        headers: isDev ? { 'X-Dev-Status-Message': 'Project Not Found' } : undefined
                    });
                }
                const isPublicAsset =
                    assetRecord.public === true || projectId === PUBLIC_ASSET_PROJECT_ID;
                let cacheControl = 'public, max-age=31536000, immutable';

                if (!isPublicAsset) {
                    const project = await dbCol.projects.findById(projectId);
                    if (!project || project.deletedAt) {
                        await logAssetNotFound({
                            request,
                            authContext,
                            reasonCode: 'ASSET_PROJECT_NOT_FOUND',
                            projectId,
                            resourceId: requestedFilename,
                            statusMessage: 'Project Not Found'
                        });
                        return new Response('Not Found', {
                            status: 404,
                            headers: isDev
                                ? { 'X-Dev-Status-Message': 'Project Not Found' }
                                : undefined
                        });
                    }

                    if (project.visibility !== 'public' || !project.publishedCommitId) {
                        cacheControl = 'private, max-age=31536000, immutable';
                        if (!user && !device) {
                            await logAssetDenied({
                                request,
                                authContext,
                                reasonCode: 'UNAUTHORIZED_GUEST',
                                projectId,
                                resourceId: requestedFilename,
                                statusMessage: 'Unauthorized Guest'
                            });
                            return new Response('Not Found', {
                                status: 404,
                                headers: isDev
                                    ? { 'X-Dev-Status-Message': 'Unauthorized Guest' }
                                    : undefined
                            });
                        }

                        if (user && user.role !== 'admin') {
                            const allowed = await canViewProject(
                                { email: user.email, role: user.role },
                                projectId
                            );
                            if (!allowed && !device) {
                                await logAssetDenied({
                                    request,
                                    authContext,
                                    reasonCode: 'PROJECT_VIEW_FORBIDDEN',
                                    projectId,
                                    resourceId: requestedFilename,
                                    statusMessage: 'Unauthorized'
                                });
                                return new Response('Not Found', {
                                    status: 404,
                                    headers: isDev
                                        ? { 'X-Dev-Status-Message': 'Unauthorized' }
                                        : undefined
                                });
                            }
                        }

                        if (device) {
                            const deviceWallId =
                                typeof device.wallId === 'string' && device.wallId.length > 0
                                    ? device.wallId
                                    : null;

                            if (!deviceWallId) {
                                await logAssetDenied({
                                    request,
                                    authContext,
                                    reasonCode: 'DEVICE_WALL_ID_MISSING',
                                    projectId,
                                    resourceId: requestedFilename,
                                    statusMessage: 'Unauthorized Device'
                                });
                                return new Response('Not Found', {
                                    status: 404,
                                    headers: isDev
                                        ? { 'X-Dev-Status-Message': 'Unauthorized Device' }
                                        : undefined
                                });
                            }

                            const wall = await dbCol.walls.findByWallId(deviceWallId);
                            if (!wall || wall.boundProjectId !== projectId) {
                                await logAssetDenied({
                                    request,
                                    authContext,
                                    reasonCode: 'DEVICE_WALL_NOT_BOUND_TO_PROJECT',
                                    projectId,
                                    resourceId: requestedFilename,
                                    details: { wallId: deviceWallId },
                                    statusMessage: 'Unauthorized Wall'
                                });
                                return new Response('Not Found', {
                                    status: 404,
                                    headers: isDev
                                        ? { 'X-Dev-Status-Message': 'Unauthorized Wall' }
                                        : undefined
                                });
                            }
                        }
                    }
                }

                const range = request.headers.get('range');
                const ifNoneMatch = request.headers.get('if-none-match');

                return getResponse({
                    uri,
                    range,
                    ifNoneMatch,
                    request,
                    authContext,
                    projectId,
                    resourceId: requestedFilename,
                    cacheControl
                });
            }
        }
    }
});
