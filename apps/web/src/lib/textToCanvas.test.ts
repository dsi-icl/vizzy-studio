import { afterEach, describe, expect, test } from 'bun:test';

import { registerTextFontSources, resetTextFontSources } from './textFontFaces';
import { textHtmlToImage } from './textToCanvas';

const originalFetch = globalThis.fetch;
const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

afterEach(() => {
    globalThis.fetch = originalFetch;
    resetTextFontSources();
    if (originalImage) {
        Object.defineProperty(globalThis, 'Image', originalImage);
    } else {
        Reflect.deleteProperty(globalThis, 'Image');
    }
    if (originalCreateObjectURL) {
        Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
    } else {
        Reflect.deleteProperty(URL, 'createObjectURL');
    }
    if (originalRevokeObjectURL) {
        Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
    } else {
        Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
});

class TestImage {
    crossOrigin = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    renderedSvg = '';

    static blobs = new Map<string, Blob>();

    set src(url: string) {
        const blob = TestImage.blobs.get(url);
        if (!blob) {
            this.onerror?.();
            return;
        }
        void blob.text().then((svg) => {
            this.renderedSvg = svg;
            this.onload?.();
        });
    }
}

/** Installs an Image/objectURL pair that captures the SVG handed to the browser. */
function stubSvgRendering() {
    let nextUrl = 0;
    TestImage.blobs.clear();
    Object.defineProperty(globalThis, 'Image', { configurable: true, value: TestImage });
    URL.createObjectURL = (blob: Blob | MediaSource) => {
        const url = `blob:test-${nextUrl++}`;
        TestImage.blobs.set(url, blob as Blob);
        return url;
    };
    URL.revokeObjectURL = (url: string) => {
        TestImage.blobs.delete(url);
    };
}

/** A `fetch` stub. The cast is needed because `typeof fetch` carries extra properties. */
function fakeFetch(handler: () => Promise<Response>): typeof fetch {
    return handler as unknown as typeof fetch;
}

const renderedSvgOf = (image: HTMLImageElement) => (image as unknown as TestImage).renderedSvg;

describe('text canvas rendering', () => {
    test('renders simultaneous text layers with their own rich HTML', async () => {
        stubSvgRendering();

        const rendered = await Promise.all([
            textHtmlToImage('<p style="color:#ef4444;font-size:2em">Red</p>', 100, 50),
            textHtmlToImage('<p style="color:#22c55e;font-size:3em">Green</p>', 200, 60),
            textHtmlToImage('<p style="color:#3b82f6;font-size:4em">Blue</p>', 300, 70)
        ]);
        const svgs = rendered.map(renderedSvgOf);

        expect(svgs[0]).toContain('color:#ef4444;font-size:2em');
        expect(svgs[0]).toContain('width="100" height="50"');
        expect(svgs[1]).toContain('color:#22c55e;font-size:3em');
        expect(svgs[1]).toContain('width="200" height="60"');
        expect(svgs[2]).toContain('color:#3b82f6;font-size:4em');
        expect(svgs[2]).toContain('width="300" height="70"');
    });
});

describe('custom fonts in the rasterised SVG', () => {
    const html =
        '<p><span style="font-family: &quot;Imperial Sans&quot;, system-ui, sans-serif;">Hi</span></p>';

    test('embeds the font bytes, because the SVG document cannot fetch them', async () => {
        stubSvgRendering();
        globalThis.fetch = fakeFetch(
            async () =>
                new Response(new Uint8Array([1, 2, 3]).slice().buffer as ArrayBuffer, {
                    status: 200
                })
        );
        registerTextFontSources([{ family: 'Imperial Sans', url: '/api/assets/imperial.woff2' }]);

        const svg = renderedSvgOf(await textHtmlToImage(html, 100, 50));

        expect(svg).toContain('@font-face');
        expect(svg).toContain('font-family:"Imperial Sans"');
        expect(svg).toContain('data:font/woff2;base64,');
        // A plain asset URL would silently fail inside the isolated document.
        expect(svg).not.toContain('url(/api/assets/imperial.woff2)');
    });

    test('still renders when the project has no custom fonts', async () => {
        stubSvgRendering();
        const svg = renderedSvgOf(await textHtmlToImage(html, 100, 50));

        expect(svg).not.toContain('@font-face');
        expect(svg).toContain('Imperial Sans');
    });
});
