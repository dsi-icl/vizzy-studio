/** Third-party HTML re-served from our own origin. Must stay opaque. */
const UNTRUSTED_SAME_ORIGIN = 'allow-scripts allow-forms';

/** Our own error and placeholder pages. Trusted, and they need to hydrate. */
const TRUSTED_SAME_ORIGIN = 'allow-scripts allow-same-origin';

/** A genuinely remote document, isolated from us by the same-origin policy. */
const REMOTE_ORIGIN = 'allow-scripts allow-same-origin allow-forms';

/** Our own pages used as wall fallbacks, which are safe to let hydrate. */
const TRUSTED_PATH_PREFIXES = ['/web-nonet', '/web-corsissue', '/web-placeholder'];

/** The app's own origin, or an empty string during server rendering. */
function currentAppOrigin(): string {
    return typeof window === 'undefined' ? '' : window.location.origin;
}

export function resolveIframeSandbox(src: string, appOrigin: string = currentAppOrigin()): string {
    const path = toSameOriginPath(src, appOrigin);

    if (path === null) {
        // Not our origin
        return REMOTE_ORIGIN;
    }

    if (TRUSTED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
        return TRUSTED_SAME_ORIGIN;
    }

    // Anything else on our origin is treated as untrusted
    return UNTRUSTED_SAME_ORIGIN;
}

function toSameOriginPath(src: string, appOrigin: string): string | null {
    const trimmed = src.trim();
    if (trimmed.startsWith('//')) return null;
    if (trimmed.startsWith('/')) return trimmed;

    if (!appOrigin) return null;
    try {
        const resolved = new URL(trimmed, appOrigin);
        return resolved.origin === appOrigin ? `${resolved.pathname}${resolved.search}` : null;
    } catch {
        return null;
    }
}
