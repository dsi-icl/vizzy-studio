export const SERVE_WALL_ID_HEADER = 'x-vizzy-wall-id';
export const SERVE_SURFACE_HEADER = 'x-vizzy-surface';

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

export function buildForwardedHeaders(
    request: Request,
    actor: { wallId: string; surface: string }
): Headers {
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
    }

    const url = new URL(request.url);
    const forwardedFor = request.headers.get('x-forwarded-for');
    if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
    headers.set('x-forwarded-host', request.headers.get('host') ?? url.host);

    headers.set(SERVE_WALL_ID_HEADER, actor.wallId);
    headers.set(SERVE_SURFACE_HEADER, actor.surface);

    return headers;
}

export function buildRelayedHeaders(upstream: Response): Headers {
    const headers = new Headers();
    for (const name of RELAYED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) headers.set(name, value);
    }
    return headers;
}
