import { parseServePath, SERVE_SESSION_ID_PATTERN, SERVE_SESSION_QUERY_PARAM } from './serveUrls';

const STATIC_DESTINATIONS = new Set(['script', 'style', 'font', 'image']);
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

function isStaticSubresource(request: Request): boolean {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    const rest = parseServePath(new URL(request.url).pathname)?.rest;
    return (
        !!rest &&
        (rest.startsWith('/assets/') || rest.startsWith('/_next/static/')) &&
        STATIC_DESTINATIONS.has(request.headers.get('sec-fetch-dest') ?? '')
    );
}

/** Opaque-origin demo fetches need a selector; static tags can use any live grant. */
export function isAllowedServeRequest(request: Request, appOrigin: string): boolean {
    const origin = request.headers.get('origin');
    if (origin && origin !== 'null' && origin !== appOrigin) return false;
    if (origin === 'null' || request.headers.get('sec-fetch-site') === 'cross-site') {
        return hasSessionSelector(request) || isStaticSubresource(request);
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
        !hasSessionSelector(request) ||
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
    if (!hasSessionSelector(request) && !isStaticSubresource(request)) return;
    headers.set('Access-Control-Allow-Origin', 'null');
    headers.set('Access-Control-Allow-Credentials', 'true');
    if (parseServePath(new URL(request.url).pathname)?.rest.startsWith('/api/uploads/')) {
        headers.set('Access-Control-Expose-Headers', TUS_EXPOSED_HEADERS);
    }
    headers.append('Vary', 'Origin');
}
