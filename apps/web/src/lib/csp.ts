export type CspDirectives = Record<string, string[]>;

export function buildBaseCsp(opts: {
    nonce: string;
    isDev: boolean;
    pathname: string;
    reportUrl: string;
}): CspDirectives {
    const { nonce, isDev, pathname, reportUrl } = opts;
    const needsScannerCompatEval = /^\/admin\/walls\/[^/]+\/devices\/?$/.test(pathname);
    const styleSrcElem = ["'self'", "'unsafe-inline'"];

    return {
        'upgrade-insecure-requests': [],
        'default-src': ["'none'"],
        'base-uri': ["'self'"],
        'object-src': ["'none'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'self'"],
        'connect-src': ["'self'", 'ws:', 'wss:', 'https:', ...(isDev ? ['http:'] : [])],
        'manifest-src': ["'self'"],
        'frame-src': ["'self'", 'https:', ...(isDev ? ['http:'] : [])],
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'media-src': ["'self'", 'data:', 'blob:', 'https:', ...(isDev ? ['http:'] : [])],
        'font-src': ["'self'", 'data:', 'https:', ...(isDev ? ['http:'] : [])],
        'worker-src': ["'self'", 'blob:'],
        'script-src': [
            "'strict-dynamic'",
            `'nonce-${nonce}'`,
            // Required by modern engines for WebAssembly compilation without opening
            // JS eval permissions.
            "'wasm-unsafe-eval'",
            // Compatibility fallback for engines that still gate WASM compile behind
            // 'unsafe-eval' (kept narrowly scoped to scanner route in production).
            ...(isDev || needsScannerCompatEval ? ["'unsafe-eval'"] : [])
        ],
        'style-src': styleSrcElem,
        'style-src-elem': styleSrcElem,
        'style-src-attr': ["'unsafe-inline'"],
        'report-uri': [reportUrl],
        'report-to': ['csp-endpoint']
    };
}

export function modifyCsp(base: CspDirectives, overrides: CspDirectives): CspDirectives {
    return { ...base, ...overrides };
}

export function serializeCsp(directives: CspDirectives): string {
    return Object.entries(directives)
        .map(([name, values]) => (values.length ? `${name} ${values.join(' ')}` : name))
        .join('; ');
}
