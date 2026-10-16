import { isAllowedDemoPath, parseDemoSource, type DemoGatewayKind } from './demoGatewayPaths';

const PROJECT_ID = /^[a-f\d]{24}$/i;
const ROUTE_ID = /^[A-Za-z\d_-]{22}$/;
const SLUG = /^[a-z\d][a-z\d_-]*$/i;
const ROOT_PATHS = new Set([
    'api',
    'ws',
    'bus',
    'pages',
    'network',
    'data',
    'maps',
    'tiles',
    'btc-globe',
    'nightingale-model',
    'observatory',
    'nightingale-wall',
    'nightingale-screen',
    'nightingale-control'
]);

export function parseDemoProjects(raw: string): Map<string, string> | null {
    if (!raw.trim()) return new Map();
    try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const projects = new Map<string, string>();
        for (const [projectId, config] of Object.entries(value)) {
            if (
                !PROJECT_ID.test(projectId) ||
                !config ||
                typeof config !== 'object' ||
                Array.isArray(config)
            )
                return null;
            const slug = (config as Record<string, unknown>).slug;
            if (
                typeof slug !== 'string' ||
                !SLUG.test(slug) ||
                !parseDemoSource(`http://demo.invalid/${slug}/`, 'http://demo.invalid')
            )
                return null;
            if (['assets', 'demos'].includes(slug)) return null;
            projects.set(projectId.toLowerCase(), slug);
        }
        return projects;
    } catch {
        return null;
    }
}

export function parseProjectDemoPath(
    pathname: string
): { projectId: string; resourcePath: string } | null {
    const match = /^\/demos\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!match || !PROJECT_ID.test(match[1] ?? '')) return null;
    return { projectId: match[1]!.toLowerCase(), resourcePath: match[2] ?? '/' };
}

export function parseRoutedProjectDemoPath(
    pathname: string
): { projectId: string; routeId: string; resourcePath: string } | null {
    const parsed = parseProjectDemoPath(pathname);
    if (!parsed) return null;
    const match = /^\/s\/([^/]+)(\/.*)?$/.exec(parsed.resourcePath);
    if (!match || !ROUTE_ID.test(match[1] ?? '')) return null;
    return { projectId: parsed.projectId, routeId: match[1]!, resourcePath: match[2] ?? '/' };
}

export function projectDemoSessionBase(projectId: string, routeId: string): string {
    if (!PROJECT_ID.test(projectId) || !ROUTE_ID.test(routeId)) {
        throw new Error('A project ID and session route are required');
    }
    return `/demos/${projectId}/s/${routeId}`;
}

export function parseProjectDemoLaunchPath(
    pathname: string
): { projectId: string; kind: DemoGatewayKind } | null {
    const parsed = parseProjectDemoPath(pathname);
    if (!parsed) return null;
    const match = /^\/_launch\/(controller|screen)$/.exec(parsed.resourcePath);
    return match ? { projectId: parsed.projectId, kind: match[1] as DemoGatewayKind } : null;
}

export function buildProjectDemoLaunchUrl(
    publicOrigin: string,
    projectId: string,
    kind: DemoGatewayKind,
    ticket: string
): string {
    if (!PROJECT_ID.test(projectId) || !ticket)
        throw new Error('A project ID and launch ticket are required');
    const url = new URL(`/demos/${projectId}/_launch/${kind}`, publicOrigin);
    url.searchParams.set('ticket', ticket);
    return url.toString();
}

export function upstreamDemoPath(resourcePath: string, slug: string): string | null {
    if (
        !resourcePath.startsWith('/') ||
        resourcePath.startsWith('//') ||
        resourcePath.startsWith('/_launch/')
    )
        return null;
    const first = resourcePath.split('/')[1] ?? '';
    const path = ROOT_PATHS.has(first) ? resourcePath : `/${slug}${resourcePath}`;
    return isAllowedDemoPath(path, slug) ? path : null;
}

export function publicDemoPath(
    projectId: string,
    upstreamPath: string,
    slug: string,
    routeId?: string
): string | null {
    if (!PROJECT_ID.test(projectId) || !isAllowedDemoPath(upstreamPath, slug)) return null;
    const prefix = `/${slug}`;
    const resourcePath =
        upstreamPath === prefix
            ? '/'
            : upstreamPath.startsWith(`${prefix}/`)
              ? upstreamPath.slice(prefix.length)
              : upstreamPath;
    return `${routeId ? projectDemoSessionBase(projectId, routeId) : `/demos/${projectId}`}${resourcePath}`;
}

export function resolveProjectDemoSource(
    rawUrl: string,
    projectId: string,
    publicOrigin: string,
    sourceOrigin: string,
    projects: Map<string, string>
): { slug: string; entryPath: string } | null {
    try {
        const url = new URL(rawUrl);
        if (url.username || url.password || url.hash) return null;
        const configuredSlug = projects.get(projectId.toLowerCase());
        if (url.origin === new URL(publicOrigin).origin) {
            const path = parseProjectDemoPath(url.pathname);
            if (!path || path.projectId !== projectId.toLowerCase() || !configuredSlug) return null;
            if (path.resourcePath.startsWith('/s/') || path.resourcePath.startsWith('/_launch/'))
                return null;
            const upstreamPath = upstreamDemoPath(path.resourcePath, configuredSlug);
            return upstreamPath
                ? { slug: configuredSlug, entryPath: `${upstreamPath}${url.search}` }
                : null;
        }
        const legacy = parseDemoSource(rawUrl, sourceOrigin);
        if (!legacy || (configuredSlug && configuredSlug !== legacy.slug)) return null;
        return { slug: legacy.slug, entryPath: `${legacy.entry.pathname}${legacy.entry.search}` };
    } catch {
        return null;
    }
}
