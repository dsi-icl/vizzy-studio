import { afterEach, describe, expect, test } from 'bun:test';

import { textHtmlToImage } from './textToCanvas';

const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

afterEach(() => {
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

describe('text canvas rendering', () => {
    test('renders simultaneous text layers with their own rich HTML', async () => {
        const blobs = new Map<string, Blob>();
        let nextUrl = 0;

        class TestImage {
            crossOrigin = '';
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            renderedSvg = '';

            set src(url: string) {
                const blob = blobs.get(url);
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

        Object.defineProperty(globalThis, 'Image', {
            configurable: true,
            value: TestImage
        });
        URL.createObjectURL = (blob: Blob | MediaSource) => {
            const url = `blob:test-${nextUrl++}`;
            blobs.set(url, blob as Blob);
            return url;
        };
        URL.revokeObjectURL = (url: string) => {
            blobs.delete(url);
        };

        const rendered = await Promise.all([
            textHtmlToImage('<p style="color:#ef4444;font-size:2em">Red</p>', 100, 50),
            textHtmlToImage('<p style="color:#22c55e;font-size:3em">Green</p>', 200, 60),
            textHtmlToImage('<p style="color:#3b82f6;font-size:4em">Blue</p>', 300, 70)
        ]);
        const svgs = rendered.map((image) => (image as unknown as TestImage).renderedSvg);

        expect(svgs[0]).toContain('color:#ef4444;font-size:2em');
        expect(svgs[0]).toContain('width="100" height="50"');
        expect(svgs[1]).toContain('color:#22c55e;font-size:3em');
        expect(svgs[1]).toContain('width="200" height="60"');
        expect(svgs[2]).toContain('color:#3b82f6;font-size:4em');
        expect(svgs[2]).toContain('width="300" height="70"');
    });
});
