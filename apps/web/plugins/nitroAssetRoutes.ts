import type { Plugin } from 'vite';

const ASSET_API_PREFIX = '/api/assets/';
const NITRO_DOCUMENT_DESTINATIONS = new Set(['document', 'iframe', 'frame', 'empty']);

export function shouldNormalizeAssetFetchDestination(
    url: string | undefined,
    fetchDestination: string | string[] | undefined
): boolean {
    if (!url) return false;

    const pathname = url.split(/[?#]/, 1)[0];
    if (!pathname.startsWith(ASSET_API_PREFIX)) return false;

    return (
        typeof fetchDestination !== 'string' || !NITRO_DOCUMENT_DESTINATIONS.has(fetchDestination)
    );
}

/**
 * Nitro's Vite middleware only handles document-like requests in development.
 * Dynamic assets arrive with destinations such as `image`, `video`, and `font`,
 * so normalize only this API route before Nitro decides whether to handle it.
 */
export function nitroAssetRoutesPlugin(): Plugin {
    return {
        name: 'nitro-dynamic-asset-routes',
        enforce: 'pre',
        configureServer(server) {
            server.middlewares.use((request, _response, next) => {
                const fetchDestination = request.headers['sec-fetch-dest'];
                if (shouldNormalizeAssetFetchDestination(request.url, fetchDestination)) {
                    request.headers['sec-fetch-dest'] = 'empty';
                }
                next();
            });
        }
    };
}
