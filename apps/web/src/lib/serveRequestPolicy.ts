import {
    isPublicServePath,
    parseServePath,
    SERVE_SESSION_ID_PATTERN,
    SERVE_SESSION_QUERY_PARAM
} from './serveUrls';

const STATIC_DESTINATIONS: Record<string, RegExp> = {
    script: /\.(?:js|mjs)$/i,
    style: /\.css$/i,
    font: /\.(?:woff2?|ttf|otf)$/i,
    image: /\.(?:svg|png|jpe?g|gif|webp|avif|ico)$/i,
    audio: /\.(?:m4a|mp3|ogg|wav)$/i,
    video: /\.(?:mp4|webm|ogg)$/i
};
const STATIC_PUBLIC_PATHS = [
    '/assets/',
    '/_next/static/',
    '/observatory/src/',
    '/observatory/assets/',
    '/rio-tinto/assets/',
    '/pages/'
];
const PREFLIGHT_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const PREFLIGHT_HEADERS = new Set(['accept', 'content-type']);
const TUS_HEADERS = new Set([
    'tus-resumable',
    'upload-length',
    'upload-metadata',
    'upload-offset',
    'upload-defer-length',
    'upload-checksum',
    'upload-concat'
]);
const TUS_EXPOSED_HEADERS =
    'Location, Tus-Resumable, Tus-Extension, Tus-Max-Size, Upload-Offset, Upload-Length, Upload-Metadata, Upload-Expires';

function allowedPreflightHeaders(request: Request): Set<string> {
    const rest = parseServePath(new URL(request.url).pathname)?.rest ?? '';
    const allowed = new Set(PREFLIGHT_HEADERS);
    if (rest.startsWith('/api/uploads/')) {
        for (const header of TUS_HEADERS) allowed.add(header);
    }
    if (rest.startsWith('/api/media/')) allowed.add('x-wall-control');
    return allowed;
}

function hasSessionSelector(request: Request): boolean {
    const selector = new URL(request.url).searchParams.get(SERVE_SESSION_QUERY_PARAM);
    return selector !== null && SERVE_SESSION_ID_PATTERN.test(selector);
}

function isPublicRequest(request: Request): boolean {
    return isPublicServePath(parseServePath(new URL(request.url).pathname));
}

function isStaticSubresource(request: Request): boolean {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    const rest = parseServePath(new URL(request.url).pathname)?.rest;
    if (!rest) return false;
    const destination = request.headers.get('sec-fetch-dest') ?? '';
    const extension = STATIC_DESTINATIONS[destination];
    // These demo public directories contain scripts, media and images. Keep
    // arbitrary routes and data files bound to the document's session selector.
    return (
        (STATIC_PUBLIC_PATHS.some((path) => rest.startsWith(path)) ||
            rest === '/rio-tinto/base-do-canvas.svg') &&
        (extension?.test(rest) ?? false)
    );
}

/** Opaque-origin private fetches need a selector; public paths do not. */
export function isAllowedServeRequest(request: Request, appOrigin: string): boolean {
    const origin = request.headers.get('origin');
    if (origin && origin !== 'null' && origin !== appOrigin) return false;
    if (origin === 'null' || request.headers.get('sec-fetch-site') === 'cross-site') {
        return (
            isPublicRequest(request) || hasSessionSelector(request) || isStaticSubresource(request)
        );
    }
    return true;
}

export function servePreflightResponse(request: Request): Response | null {
    if (request.method !== 'OPTIONS' || request.headers.get('origin') !== 'null') return null;
    if (!request.headers.has('access-control-request-method')) return null;
    const method = request.headers.get('access-control-request-method')?.toUpperCase() ?? '';
    const requestedHeaders = (request.headers.get('access-control-request-headers') ?? '')
        .split(',')
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean);
    const allowedHeaders = allowedPreflightHeaders(request);
    if (
        (!isPublicRequest(request) && !hasSessionSelector(request)) ||
        !PREFLIGHT_METHODS.has(method) ||
        requestedHeaders.some((header) => !allowedHeaders.has(header))
    ) {
        return new Response('Forbidden', { status: 403 });
    }
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': 'null',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Allow-Methods': [...PREFLIGHT_METHODS].join(', '),
            'Access-Control-Allow-Headers': [...allowedHeaders].join(', '),
            'Access-Control-Max-Age': '300',
            'Cache-Control': 'no-store',
            Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
        }
    });
}

export function addServeCorsHeaders(request: Request, headers: Headers): void {
    if (request.headers.get('origin') !== 'null') return;
    if (!isPublicRequest(request) && !hasSessionSelector(request) && !isStaticSubresource(request))
        return;
    headers.set('Access-Control-Allow-Origin', 'null');
    headers.set('Access-Control-Allow-Credentials', 'true');
    if (parseServePath(new URL(request.url).pathname)?.rest.startsWith('/api/uploads/')) {
        headers.set('Access-Control-Expose-Headers', TUS_EXPOSED_HEADERS);
    }
    headers.append('Vary', 'Origin');
}
