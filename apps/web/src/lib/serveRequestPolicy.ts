import { parseServePath, SERVE_SESSION_ID_PATTERN, SERVE_SESSION_QUERY_PARAM } from './serveUrls';

const STATIC_DESTINATIONS = new Set(['script', 'style', 'font', 'image']);
const PREFLIGHT_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const PREFLIGHT_HEADERS = new Set(['accept', 'content-type']);

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
    const method = request.headers.get('access-control-request-method')?.toUpperCase() ?? '';
    const requestedHeaders = (request.headers.get('access-control-request-headers') ?? '')
        .split(',')
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean);
    if (
        !hasSessionSelector(request) ||
        !PREFLIGHT_METHODS.has(method) ||
        requestedHeaders.some((header) => !PREFLIGHT_HEADERS.has(header))
    ) {
        return new Response('Forbidden', { status: 403 });
    }
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': 'null',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Allow-Methods': [...PREFLIGHT_METHODS].join(', '),
            'Access-Control-Allow-Headers': [...PREFLIGHT_HEADERS].join(', '),
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
    headers.append('Vary', 'Origin');
}
