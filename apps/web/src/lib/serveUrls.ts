/** Browser and upstream paths share the project's static `/serve/<projectId>/` base. */

export const SERVE_PATH_PREFIX = '/serve';
export const SERVE_SESSION_QUERY_PARAM = '__vizzySession';

/** Entry points, matching the route names every demo exposes. */
export function serveBasePath(projectId: string): string {
    return `${SERVE_PATH_PREFIX}/${projectId}`;
}

export function servePublicBasePath(projectId: string): string {
    return `${serveControlPath(projectId)}/public`;
}

export function serveWallPath(projectId: string): string {
    return `${serveBasePath(projectId)}/screen`;
}

export function serveControlPath(projectId: string): string {
    return `${serveBasePath(projectId)}/control`;
}

export function serveBusPath(projectId: string): string {
    return `${serveBasePath(projectId)}/bus`;
}

export function serveLaunchPath(projectId: string): string {
    return `${serveBasePath(projectId)}/_launch`;
}

export const SERVE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function serveKeepalivePath(projectId: string, routeId: string): string {
    if (!PROJECT_ID_PATTERN.test(projectId) || !SERVE_SESSION_ID_PATTERN.test(routeId)) {
        throw new Error('Invalid serve session');
    }
    return `${serveBasePath(projectId)}/_keepalive?${SERVE_SESSION_QUERY_PARAM}=${routeId}`;
}

/** A project id as minted by MongoDB — 24 hex characters. */
const PROJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

export interface ParsedServePath {
    projectId: string;
    /** The path below the project's base, leading slash included. `/` for the base itself. */
    rest: string;
}

/** Only the complete `/control/public` path segment is public. */
export function isPublicServePath(parsed: ParsedServePath | null): boolean {
    return (
        parsed?.rest === '/control/public' || parsed?.rest.startsWith('/control/public/') === true
    );
}

export function parseServePath(pathname: string): ParsedServePath | null {
    if (!pathname.startsWith(`${SERVE_PATH_PREFIX}/`)) return null;
    if (pathname.includes('..')) return null;

    const remainder = pathname.slice(SERVE_PATH_PREFIX.length + 1);
    const boundary = remainder.indexOf('/');
    const projectId = boundary === -1 ? remainder : remainder.slice(0, boundary);
    if (!PROJECT_ID_PATTERN.test(projectId)) return null;

    return {
        projectId,
        rest: boundary === -1 ? '/' : remainder.slice(boundary)
    };
}

export function buildServeUpstreamUrl(input: {
    host: string;
    port: number;
    pathname: string;
    search: string;
}): string {
    return `http://${input.host}:${input.port}${input.pathname}${input.search}`;
}

export function upstreamPathname(
    parsed: ParsedServePath,
    requestPathname: string,
    stripPrefix?: boolean
): string {
    return stripPrefix ? parsed.rest : requestPathname;
}

export function resolveDemoHost(allowed: string[], customHost?: string | null): string | null {
    if (!customHost) return null;
    return allowed.includes(customHost) ? customHost : null;
}

export function rewriteServeLocation(
    location: string,
    upstreamUrl: string,
    basePath: string,
    publicBasePath = basePath
): string | null {
    let resolved: URL;
    let upstreamOrigin: string;
    try {
        resolved = new URL(location, upstreamUrl);
        upstreamOrigin = new URL(upstreamUrl).origin;
    } catch {
        return null;
    }

    if (resolved.origin !== upstreamOrigin) return null;

    if (
        publicBasePath !== basePath &&
        (resolved.pathname === publicBasePath || resolved.pathname.startsWith(`${publicBasePath}/`))
    ) {
        return `${resolved.pathname}${resolved.search}${resolved.hash}`;
    }

    const publicRest = publicBasePath.startsWith(`${basePath}/`)
        ? publicBasePath.slice(basePath.length)
        : '';
    const upstreamPath =
        publicRest &&
        (resolved.pathname === publicRest || resolved.pathname.startsWith(`${publicRest}/`))
            ? resolved.pathname.slice(publicRest.length) || '/'
            : resolved.pathname;

    const pathname =
        upstreamPath === basePath || upstreamPath.startsWith(`${basePath}/`)
            ? upstreamPath
            : `${basePath}${upstreamPath}`;
    return `${publicBasePath}${pathname.slice(basePath.length)}${resolved.search}${resolved.hash}`;
}
