export type DemoGatewayKind = 'controller' | 'screen';

export const SHARED_DEMO_PATHS = new Set([
    'api',
    'ws',
    'bus',
    'control',
    'screen',
    'pages',
    'network',
    'data',
    'maps',
    'tiles',
    'do-image',
    'btc-globe',
    'nightingale-model'
]);

const PROJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const DEMO_SLUG_PATTERN = /^[a-z\d][a-z\d_-]*$/i;

export interface DirectDemoUpstream {
    origin: URL;
    assetsFromRoot: boolean;
}

export function parseDirectDemoUpstreams(raw: string): Map<string, DirectDemoUpstream> | null {
    if (!raw.trim()) return new Map();
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const routes = new Map<string, DirectDemoUpstream>();
        for (const [slug, value] of Object.entries(parsed)) {
            if (!DEMO_SLUG_PATTERN.test(slug) || SHARED_DEMO_PATHS.has(slug) || slug === '_vizzy') {
                return null;
            }
            if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
            const config = value as Record<string, unknown>;
            if (typeof config.origin !== 'string' || typeof config.assetsFromRoot !== 'boolean') {
                return null;
            }
            const origin = new URL(config.origin);
            if (
                !['http:', 'https:'].includes(origin.protocol) ||
                origin.username ||
                origin.password ||
                origin.pathname !== '/' ||
                origin.search ||
                origin.hash
            ) {
                return null;
            }
            routes.set(slug, { origin, assetsFromRoot: config.assetsFromRoot });
        }
        return routes;
    } catch {
        return null;
    }
}

export function directDemoPath(pathname: string, slug: string, route: DirectDemoUpstream): string {
    if (!route.assetsFromRoot) return pathname;
    const assetPrefix = `/${slug}/assets`;
    if (pathname === assetPrefix || pathname.startsWith(`${assetPrefix}/`)) {
        return pathname.slice(slug.length + 1);
    }
    return pathname;
}

export function parseDemoSource(
    rawUrl: string,
    publicOrigin: string
): { entry: URL; slug: string } | null {
    try {
        const entry = new URL(rawUrl);
        const source = new URL(publicOrigin);
        if (entry.origin !== source.origin || !['http:', 'https:'].includes(entry.protocol)) {
            return null;
        }
        if (entry.username || entry.password || entry.hash) return null;
        const slug = entry.pathname.split('/')[1] ?? '';
        if (!DEMO_SLUG_PATTERN.test(slug) || SHARED_DEMO_PATHS.has(slug) || slug === '_vizzy') {
            return null;
        }
        return { entry, slug };
    } catch {
        return null;
    }
}

export function parseDemoLaunchPath(pathname: string): {
    projectId: string;
    kind: DemoGatewayKind;
} | null {
    const match = /^\/_vizzy\/demo-launch\/([^/]+)\/(controller|screen)$/.exec(pathname);
    if (!match || !PROJECT_ID_PATTERN.test(match[1] ?? '')) return null;
    return { projectId: match[1]!, kind: match[2] as DemoGatewayKind };
}

export function buildDemoLaunchUrl(
    publicOrigin: string,
    projectId: string,
    kind: DemoGatewayKind,
    ticket: string
): string {
    if (!PROJECT_ID_PATTERN.test(projectId) || !ticket) {
        throw new Error('A project ID and launch ticket are required');
    }
    const url = new URL(`/_vizzy/demo-launch/${projectId}/${kind}`, publicOrigin);
    url.searchParams.set('ticket', ticket);
    return url.toString();
}

export function isAllowedDemoPath(pathname: string, slug: string): boolean {
    if (!pathname.startsWith('/') || pathname.startsWith('//')) return false;
    if (pathname === `/${slug}` || pathname.startsWith(`/${slug}/`)) return true;
    const first = pathname.split('/')[1] ?? '';
    return SHARED_DEMO_PATHS.has(first);
}

export function safeDemoRedirect(
    location: string,
    upstreamRequestUrl: URL,
    upstreamOrigin: URL,
    publicOrigin: URL,
    slug: string,
    directRoute?: DirectDemoUpstream
): string | null {
    try {
        const resolved = new URL(location, upstreamRequestUrl);
        if (resolved.origin !== upstreamOrigin.origin && resolved.origin !== publicOrigin.origin) {
            return null;
        }
        if (
            directRoute?.assetsFromRoot &&
            (resolved.pathname === '/assets' || resolved.pathname.startsWith('/assets/'))
        ) {
            resolved.pathname = `/${slug}${resolved.pathname}`;
        }
        if (!isAllowedDemoPath(resolved.pathname, slug)) return null;
        return `${resolved.pathname}${resolved.search}${resolved.hash}`;
    } catch {
        return null;
    }
}
