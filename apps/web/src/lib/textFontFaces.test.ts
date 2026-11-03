import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
    extractFontFamilies,
    fontFaceCssForHtml,
    registerTextFontSources,
    resetTextFontSources,
    getTextFontRevision,
    subscribeTextFonts
} from './textFontFaces';

const originalFetch = globalThis.fetch;

/** The shape Lexical's exporter actually produces: entity-escaped quotes. */
const escapedHtml = (family: string) =>
    `<p><span style="color: #fff; font-family: &quot;${family}&quot;, system-ui, sans-serif; white-space: pre-wrap;">Hi</span></p>`;

/** A `fetch` stub that ignores everything but the request URL. */
function fakeFetch(handler: (url: string) => Promise<Response>): typeof fetch {
    const impl = (input: RequestInfo | URL) => {
        const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return handler(url);
    };
    return impl as unknown as typeof fetch;
}

function stubFetch(bodies: Record<string, Uint8Array | 'error'>) {
    globalThis.fetch = fakeFetch(async (url) => {
        const body = bodies[url];
        if (!body || body === 'error') {
            return new Response(null, { status: 404 });
        }
        return new Response(body.slice().buffer as ArrayBuffer, { status: 200 });
    });
}

beforeEach(() => {
    resetTextFontSources();
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    resetTextFontSources();
});

describe('extractFontFamilies', () => {
    test('reads entity-escaped quoted families from the exported HTML', () => {
        expect(extractFontFamilies(escapedHtml('Imperial Sans'))).toEqual([
            'Imperial Sans',
            'system-ui',
            'sans-serif'
        ]);
    });

    test('reads unescaped and unquoted families', () => {
        expect(extractFontFamilies('<p style="font-family: Imperial Sans, serif">a</p>')).toEqual([
            'Imperial Sans',
            'serif'
        ]);
        expect(extractFontFamilies(`<p style='font-family: "Imperial Sans", serif'>a</p>`)).toEqual(
            ['Imperial Sans', 'serif']
        );
    });

    test('collects every run without duplicates', () => {
        const html = `${escapedHtml('Alpha')}${escapedHtml('Beta')}${escapedHtml('Alpha')}`;
        expect(extractFontFamilies(html)).toEqual(['Alpha', 'system-ui', 'sans-serif', 'Beta']);
    });

    test('ignores HTML with no font-family declaration', () => {
        expect(extractFontFamilies('<p style="color: #fff">a</p>')).toEqual([]);
        expect(extractFontFamilies('')).toEqual([]);
    });
});

describe('fontFaceCssForHtml', () => {
    test('inlines the font bytes for a referenced project font', async () => {
        stubFetch({ '/api/assets/imperial.woff2': new Uint8Array([1, 2, 3, 4]) });
        registerTextFontSources([{ family: 'Imperial Sans', url: '/api/assets/imperial.woff2' }]);

        const css = await fontFaceCssForHtml(escapedHtml('Imperial Sans'));

        expect(css).toContain('@font-face');
        expect(css).toContain('font-family:"Imperial Sans"');
        expect(css).toContain(`src:url(data:font/woff2;base64,${btoa('\x01\x02\x03\x04')})`);
        expect(css).toContain('format("woff2")');
    });

    test('skips project fonts the HTML does not reference', async () => {
        let fetches = 0;
        globalThis.fetch = fakeFetch(async () => {
            fetches++;
            return new Response(new Uint8Array([1]).slice().buffer as ArrayBuffer, {
                status: 200
            });
        });
        registerTextFontSources([
            { family: 'Used', url: '/api/assets/used.woff2' },
            { family: 'Unused', url: '/api/assets/unused.woff2' }
        ]);

        const css = await fontFaceCssForHtml(escapedHtml('Used'));

        expect(css).toContain('font-family:"Used"');
        expect(css).not.toContain('Unused');
        expect(fetches).toBe(1);
    });

    test('returns nothing for an unregistered family', async () => {
        stubFetch({});
        expect(await fontFaceCssForHtml(escapedHtml('Never Uploaded'))).toBe('');
    });

    test('fetches each font once across repeated renders', async () => {
        let fetches = 0;
        globalThis.fetch = fakeFetch(async () => {
            fetches++;
            return new Response(new Uint8Array([9]).slice().buffer as ArrayBuffer, {
                status: 200
            });
        });
        registerTextFontSources([{ family: 'Cached', url: '/api/assets/cached.woff2' }]);

        const html = escapedHtml('Cached');
        await Promise.all([fontFaceCssForHtml(html), fontFaceCssForHtml(html)]);
        await fontFaceCssForHtml(html);

        expect(fetches).toBe(1);
    });

    test('degrades to no rule when the font cannot be fetched', async () => {
        stubFetch({ '/api/assets/flaky.woff2': 'error' });
        registerTextFontSources([{ family: 'Flaky', url: '/api/assets/flaky.woff2' }]);

        expect(await fontFaceCssForHtml(escapedHtml('Flaky'))).toBe('');
    });

    test('backs off after a failure, then retries once the window passes', async () => {
        const realNow = Date.now;
        let now = 1_000_000;
        Date.now = () => now;
        try {
            let fetches = 0;
            globalThis.fetch = fakeFetch(async () => {
                fetches++;
                return new Response(null, { status: 503 });
            });
            registerTextFontSources([{ family: 'Flaky', url: '/api/assets/flaky.woff2' }]);

            const html = escapedHtml('Flaky');
            expect(await fontFaceCssForHtml(html)).toBe('');
            expect(fetches).toBe(1);

            // Re-rasterising while typing must not hammer a failing asset.
            await fontFaceCssForHtml(html);
            await fontFaceCssForHtml(html);
            expect(fetches).toBe(1);

            now += 10_001;
            globalThis.fetch = fakeFetch(async () => {
                fetches++;
                return new Response(new Uint8Array([7]).slice().buffer as ArrayBuffer, {
                    status: 200
                });
            });

            expect(await fontFaceCssForHtml(html)).toContain('font-family:"Flaky"');
            expect(fetches).toBe(2);
        } finally {
            Date.now = realNow;
        }
    });

    test('escapes a family name that would otherwise inject CSS', async () => {
        stubFetch({ '/api/assets/evil.woff2': new Uint8Array([1]) });
        registerTextFontSources([{ family: 'ev"il', url: '/api/assets/evil.woff2' }]);

        const css = await fontFaceCssForHtml(
            '<p style="font-family: ev&quot;il">a</p>'.replace('ev&quot;il', 'ev\\"il')
        );
        // Whatever reaches the rule, the quoted literal stays closed.
        expect(css.split('@font-face').length - 1).toBeLessThanOrEqual(1);
        if (css) expect(css).toContain('ev\\"il');
    });
});

describe('font revision', () => {
    test('bumps and notifies only when the registered set changes', () => {
        let notifications = 0;
        const unsubscribe = subscribeTextFonts(() => {
            notifications++;
        });

        const fonts = [{ family: 'Alpha', url: '/api/assets/alpha.woff2' }];
        registerTextFontSources(fonts);
        const afterFirst = getTextFontRevision();
        expect(afterFirst).toBeGreaterThan(0);
        expect(notifications).toBe(1);

        registerTextFontSources(fonts);
        expect(getTextFontRevision()).toBe(afterFirst);
        expect(notifications).toBe(1);

        registerTextFontSources([{ family: 'Alpha', url: '/api/assets/alpha-v2.woff2' }]);
        expect(getTextFontRevision()).toBeGreaterThan(afterFirst);
        expect(notifications).toBe(2);

        unsubscribe();
    });

    test('re-pointing a family refetches instead of serving stale bytes', async () => {
        stubFetch({
            '/api/assets/v1.woff2': new Uint8Array([1]),
            '/api/assets/v2.woff2': new Uint8Array([2])
        });

        registerTextFontSources([{ family: 'Rolling', url: '/api/assets/v1.woff2' }]);
        const first = await fontFaceCssForHtml(escapedHtml('Rolling'));
        expect(first).toContain(btoa('\x01'));

        registerTextFontSources([{ family: 'Rolling', url: '/api/assets/v2.woff2' }]);
        const second = await fontFaceCssForHtml(escapedHtml('Rolling'));
        expect(second).toContain(btoa('\x02'));
    });
});
