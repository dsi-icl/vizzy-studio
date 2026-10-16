/**
 * The gateway exposes a session-scoped public path and forwards it to the
 * project's `/serve/<projectId>/` upstream path.
 */

export const SERVE_PATH_PREFIX = '/serve';

/** Entry points, matching the route names every demo exposes. */
export function serveBasePath(projectId: string): string {
    return `${SERVE_PATH_PREFIX}/${projectId}`;
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

const ROUTE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function serveSessionBasePath(projectId: string, routeId: string): string {
    if (!PROJECT_ID_PATTERN.test(projectId) || !ROUTE_ID_PATTERN.test(routeId)) {
        throw new Error('Invalid serve session path');
    }
    return `${serveBasePath(projectId)}/s/${routeId}`;
}

export function parseServeSessionPath(
    pathname: string
): { projectId: string; routeId: string; rest: string } | null {
    const parsed = parseServePath(pathname);
    if (!parsed) return null;
    const match = /^\/s\/([^/]+)(\/.*)?$/.exec(parsed.rest);
    if (!match || !ROUTE_ID_PATTERN.test(match[1] ?? '')) return null;
    return { projectId: parsed.projectId, routeId: match[1]!, rest: match[2] ?? '/' };
}

/** A project id as minted by MongoDB — 24 hex characters. */
const PROJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

export interface ParsedServePath {
    projectId: string;
    /** The path below the project's base, leading slash included. `/` for the base itself. */
    rest: string;
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

    const pathname =
        resolved.pathname === basePath || resolved.pathname.startsWith(`${basePath}/`)
            ? resolved.pathname
            : `${basePath}${resolved.pathname}`;
    return `${publicBasePath}${pathname.slice(basePath.length)}${resolved.search}${resolved.hash}`;
}
