export function getCorsHeaders(request: Request) {
    const origin = request.headers.get('origin');
    return {
        'Access-Control-Allow-Origin': origin ?? '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin'
    } as const;
}

export function json(request: Request, status: number, payload: unknown) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...getCorsHeaders(request)
        }
    });
}

export function getBearerToken(request: Request): string | null {
    const auth = request.headers.get('authorization');
    if (auth && auth.toLowerCase().startsWith('bearer ')) {
        return auth.slice(7).trim();
    }
    const url = new URL(request.url);
    const fallback = url.searchParams.get('_gem_t') ?? url.searchParams.get('_viz_t');
    return fallback && fallback.trim().length > 0 ? fallback.trim() : null;
}
