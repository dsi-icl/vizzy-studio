import '@tanstack/react-start/server-only';
import { env } from '@repo/env';

/** Demo URLs use Vizzy's public host; response sandboxing isolates demo scripts. */
export function getServeOrigin(): URL | null {
    try {
        const origin = new URL(env.VITE_BASE_URL);
        if (!['http:', 'https:'].includes(origin.protocol)) return null;
        if (env.NODE_ENV === 'production' && origin.protocol !== 'https:') return null;
        if (
            origin.username ||
            origin.password ||
            origin.pathname !== '/' ||
            origin.search ||
            origin.hash
        ) {
            return null;
        }
        return origin;
    } catch {
        return null;
    }
}

export function isServeOriginRequest(request: Request): boolean {
    const origin = getServeOrigin();
    if (!origin) return false;
    return (request.headers.get('host') ?? new URL(request.url).host) === origin.host;
}

export function servePublicUrl(path: string): string {
    const origin = getServeOrigin();
    if (!origin) throw new Error('Vizzy public origin is not configured');
    return new URL(path, origin).toString();
}
