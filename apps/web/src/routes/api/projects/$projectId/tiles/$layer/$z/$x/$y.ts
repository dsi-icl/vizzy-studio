import { env } from '@repo/env';
import { createFileRoute } from '@tanstack/react-router';

import { logAuditDenied, logAuditFailure } from '~/server/audit';
import { dbCol } from '~/server/collections';
import { actorFromAuthContext, canViewProject } from '~/server/projectAuthz';
import type { AuthContext } from '~/server/requestAuthContext';
import { hasAuthenticatedActor } from '~/server/requestAuthContext';
import { resolveWallMediaCookieAuthContext } from '~/server/wallMediaCookie';

const isDev = process.env.NODE_ENV === 'development';
const LAYER_PATTERN = /^[a-z0-9_-]{1,80}$/;
const TILE_COORDINATE_MAX_ZOOM = 24;

function parseTileCoord(value: unknown, max: number): number | null {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) return null;
    return parsed;
}

function makeStatusHeaders(message: string): HeadersInit | undefined {
    return isDev ? { 'X-Dev-Status-Message': message } : undefined;
}

function getMartinBaseUrl(): string | null {
    const raw = env.MARTIN_BASE_URL.trim();
    if (!raw) return null;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return null;
    }
}

async function canReadProjectTiles(authContext: AuthContext, projectId: string) {
    const actor = actorFromAuthContext(authContext);
    if (actor) return canViewProject(actor, projectId);

    const wallId = authContext.device?.kind === 'wall' ? authContext.device.wallId : null;
    if (!wallId) return false;

    const wall = await dbCol.walls.findByWallId(wallId);
    return wall?.boundProjectId === projectId;
}

async function logTileDenied(input: {
    request: Request;
    authContext: AuthContext;
    projectId?: string;
    layer?: string;
    reasonCode: string;
    statusMessage?: string;
}) {
    await logAuditDenied({
        action: 'TILE_GATEWAY_DENIED',
        resourceType: 'project',
        resourceId: input.projectId ?? null,
        projectId: input.projectId,
        reasonCode: input.reasonCode,
        statusMessage: input.statusMessage,
        authContext: input.authContext,
        executionContext: {
            surface: 'http',
            operation: 'GET /api/projects/$projectId/tiles/$layer/$z/$x/$y',
            details: input.layer ? { layer: input.layer } : undefined,
            request: input.request
        }
    });
}

async function logTileFailure(input: {
    request: Request;
    authContext: AuthContext;
    projectId: string;
    layer: string;
    reasonCode: string;
    statusMessage?: string;
}) {
    await logAuditFailure({
        action: 'TILE_GATEWAY_FAILED',
        resourceType: 'project',
        resourceId: input.projectId,
        projectId: input.projectId,
        reasonCode: input.reasonCode,
        statusMessage: input.statusMessage,
        authContext: input.authContext,
        executionContext: {
            surface: 'http',
            operation: 'GET /api/projects/$projectId/tiles/$layer/$z/$x/$y',
            details: { layer: input.layer },
            request: input.request
        }
    });
}

export const Route = createFileRoute('/api/projects/$projectId/tiles/$layer/$z/$x/$y')({
    server: {
        handlers: {
            GET: async ({ request, params, context }) => {
                let authContext: AuthContext = ((context ?? {}) as { authContext?: AuthContext })
                    .authContext ?? { guest: true };

                if (!hasAuthenticatedActor(authContext)) {
                    const mediaCookieDevice = await resolveWallMediaCookieAuthContext(request);
                    if (mediaCookieDevice) {
                        authContext = {
                            guest: undefined,
                            device: mediaCookieDevice
                        };
                    }
                }

                if (!hasAuthenticatedActor(authContext)) {
                    await logTileDenied({
                        request,
                        authContext,
                        projectId: params.projectId,
                        reasonCode: 'AUTH_REQUIRED',
                        statusMessage: 'Unauthorized'
                    });
                    return new Response('Not Found', {
                        status: 404,
                        headers: makeStatusHeaders('Unauthorized')
                    });
                }

                const { projectId, layer } = params;
                const z = parseTileCoord(params.z, TILE_COORDINATE_MAX_ZOOM);
                if (!projectId || !LAYER_PATTERN.test(layer) || z === null) {
                    await logTileDenied({
                        request,
                        authContext,
                        projectId,
                        layer,
                        reasonCode: 'INVALID_TILE_REQUEST',
                        statusMessage: 'Invalid Tile Request'
                    });
                    return new Response('Not Found', {
                        status: 404,
                        headers: makeStatusHeaders('Invalid Tile Request')
                    });
                }

                const allowed = await canReadProjectTiles(authContext, projectId);
                if (!allowed) {
                    await logTileDenied({
                        request,
                        authContext,
                        projectId,
                        layer,
                        reasonCode: 'PROJECT_VIEW_FORBIDDEN',
                        statusMessage: 'Unauthorized'
                    });
                    return new Response('Not Found', {
                        status: 404,
                        headers: makeStatusHeaders('Unauthorized')
                    });
                }

                const tileLimit = 2 ** z - 1;
                const x = parseTileCoord(params.x, tileLimit);
                const y = parseTileCoord(params.y, tileLimit);
                if (x === null || y === null) {
                    await logTileDenied({
                        request,
                        authContext,
                        projectId,
                        layer,
                        reasonCode: 'INVALID_TILE_COORDINATES',
                        statusMessage: 'Invalid Tile Coordinates'
                    });
                    return new Response('Not Found', {
                        status: 404,
                        headers: makeStatusHeaders('Invalid Tile Coordinates')
                    });
                }

                const martinBaseUrl = getMartinBaseUrl();
                if (!martinBaseUrl) {
                    await logTileFailure({
                        request,
                        authContext,
                        projectId,
                        layer,
                        reasonCode: 'MARTIN_BASE_URL_MISSING',
                        statusMessage: 'Martin Base URL Missing'
                    });
                    return new Response('Tile service unavailable', {
                        status: 503,
                        headers: makeStatusHeaders('Martin Base URL Missing')
                    });
                }

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), env.MARTIN_TILE_TIMEOUT_MS);
                const upstreamUrl = `${martinBaseUrl}/${layer}/${z}/${x}/${y}`;

                try {
                    const upstream = await fetch(upstreamUrl, {
                        signal: controller.signal,
                        headers: {
                            accept: request.headers.get('accept') ?? '*/*',
                            'user-agent': 'vizzy-tile-gateway/1.0'
                        }
                    });

                    const headers = new Headers({
                        'Cache-Control': 'private, max-age=3600, stale-while-revalidate=86400',
                        'X-Content-Type-Options': 'nosniff'
                    });
                    const contentType = upstream.headers.get('content-type');
                    const etag = upstream.headers.get('etag');
                    const lastModified = upstream.headers.get('last-modified');
                    if (contentType) headers.set('Content-Type', contentType);
                    if (etag) headers.set('ETag', etag);
                    if (lastModified) headers.set('Last-Modified', lastModified);

                    return new Response(upstream.body, {
                        status: upstream.status,
                        statusText: upstream.statusText,
                        headers
                    });
                } catch (err) {
                    await logTileFailure({
                        request,
                        authContext,
                        projectId,
                        layer,
                        reasonCode: 'UPSTREAM_FETCH_FAILED',
                        statusMessage: err instanceof Error ? err.message : 'Upstream Fetch Failed'
                    });
                    return new Response('Tile service unavailable', {
                        status: 503,
                        headers: makeStatusHeaders('Upstream Fetch Failed')
                    });
                } finally {
                    clearTimeout(timeout);
                }
            }
        }
    }
});
