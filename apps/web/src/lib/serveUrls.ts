/**
 * A custom project's demo is built with `BASE_PATH=/serve/<projectId>/`, so the path the
 * browser requests and the path the demo expects are the same string.
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
    basePath: string
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
    return `${pathname}${resolved.search}${resolved.hash}`;
}
