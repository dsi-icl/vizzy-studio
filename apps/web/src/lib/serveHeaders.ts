import { parseServePath } from './serveUrls';

export const SERVE_WALL_ID_HEADER = 'x-vizzy-wall-id';
export const SERVE_SURFACE_HEADER = 'x-vizzy-surface';
export const SERVE_PUBLIC_BASE_HEADER = 'x-vizzy-public-base';

const FORWARDED_REQUEST_HEADERS = [
    'accept',
    'accept-language',
    'content-type',
    'range',
    'if-none-match',
    'if-modified-since',
    'user-agent'
];

const RELAYED_RESPONSE_HEADERS = [
    'content-type',
    'cache-control',
    'etag',
    'last-modified',
    'content-range',
    'accept-ranges',
    'vary'
];

const TUS_REQUEST_HEADERS = [
    'tus-resumable',
    'upload-length',
    'upload-metadata',
    'upload-offset',
    'upload-defer-length',
    'upload-checksum',
    'upload-concat'
];

const TUS_RESPONSE_HEADERS = [
    'tus-resumable',
    'tus-extension',
    'tus-max-size',
    'upload-offset',
    'upload-length',
    'upload-metadata',
    'upload-expires'
];

function serveRest(request: Request): string {
    return parseServePath(new URL(request.url).pathname)?.rest ?? '';
}

export function buildForwardedHeaders(
    request: Request,
    actor: { wallId?: string; surface: string },
    publicBase?: string
): Headers {
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
    }
    const rest = serveRest(request);
    if (rest.startsWith('/api/uploads/')) {
        for (const name of TUS_REQUEST_HEADERS) {
            const value = request.headers.get(name);
            if (value !== null) headers.set(name, value);
        }
    }
    if (rest.startsWith('/api/media/')) {
        const wallControl = request.headers.get('x-wall-control');
        if (wallControl !== null) headers.set('x-wall-control', wallControl);
    }

    const url = new URL(request.url);
    const forwardedFor = request.headers.get('x-forwarded-for');
    if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
    headers.set('x-forwarded-host', request.headers.get('host') ?? url.host);

    if (actor.wallId) headers.set(SERVE_WALL_ID_HEADER, actor.wallId);
    headers.set(SERVE_SURFACE_HEADER, actor.surface);
    if (publicBase) headers.set(SERVE_PUBLIC_BASE_HEADER, publicBase);

    return headers;
}

export function buildRelayedHeaders(upstream: Response, request?: Request): Headers {
    const headers = new Headers();
    for (const name of RELAYED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) headers.set(name, value);
    }
    if (request && serveRest(request).startsWith('/api/uploads/')) {
        for (const name of TUS_RESPONSE_HEADERS) {
            const value = upstream.headers.get(name);
            if (value !== null) headers.set(name, value);
        }
    }
    return headers;
}
