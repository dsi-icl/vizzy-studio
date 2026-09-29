import { env } from '@repo/env';
import { createFileRoute } from '@tanstack/react-router';

import { isImageTileInBounds, parseImageTilePath } from '~/lib/mediaUtils';
import { fetchImageTile } from '~/lib/serverAssetUtils';
import { dbCol } from '~/server/collections';
import { authorizeAssetRead, resolveAssetAuthContext } from '~/server/projectAuthz';

const notFound = () =>
    new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
const unavailable = () =>
    new Response('Tile temporarily unavailable', {
        status: 503,
        headers: { 'Cache-Control': 'no-store', 'Retry-After': '2' }
    });

export const Route = createFileRoute('/api/image-tiles/$')({
    server: {
        handlers: {
            GET: async ({ request, params, context }) => {
                const tile = parseImageTilePath(params._splat ?? '');
                if (!tile) return notFound();
                const asset = await dbCol.assets.findById(tile.assetId);
                if (!asset?.deepZoom || !isImageTileInBounds(asset.deepZoom, tile))
                    return notFound();
                const auth = await resolveAssetAuthContext(request, context);
                const access = await authorizeAssetRead(asset, auth);
                if (!access.allowed) return notFound();
                // Every validation passes authorization again, including 304s. A
                // public project can become private and walls can be rebound/revoked.
                const headers = {
                    'Content-Type': 'image/webp',
                    'X-Content-Type-Options': 'nosniff',
                    'Cache-Control': access.public
                        ? 'public, max-age=0, must-revalidate'
                        : 'private, no-cache',
                    Vary: 'Cookie, Authorization',
                    ETag: `"${tile.sourceId}-${tile.z}-${tile.x}-${tile.y}"`
                };
                if (request.headers.get('if-none-match') === headers.ETag)
                    return new Response(null, { status: 304, headers });
                if (!env.IMAGE_MARTIN_URL) return unavailable();
                try {
                    const base = new URL(env.IMAGE_MARTIN_URL);
                    if (!['http:', 'https:'].includes(base.protocol)) return unavailable();
                    base.pathname = `${base.pathname.replace(/\/$/, '')}/${tile.sourceId}/${tile.z}/${tile.x}/${tile.y}`;
                    base.search = '';
                    base.hash = '';
                    const bytes = await fetchImageTile(
                        base,
                        AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
                    );
                    return new Response(bytes, { headers });
                } catch {
                    return unavailable();
                }
            }
        }
    }
});
