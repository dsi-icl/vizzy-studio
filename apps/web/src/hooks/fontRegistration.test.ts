import { afterEach, describe, expect, test } from 'bun:test';

import { fontFaceCssForHtml, resetTextFontSources } from '~/lib/textFontFaces';

import { prepareFonts } from './fontRegistration';

const originalFetch = globalThis.fetch;
const originalFontFace = Object.getOwnPropertyDescriptor(globalThis, 'FontFace');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

afterEach(() => {
    globalThis.fetch = originalFetch;
    resetTextFontSources();
    if (originalFontFace) Object.defineProperty(globalThis, 'FontFace', originalFontFace);
    else Reflect.deleteProperty(globalThis, 'FontFace');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
});

describe('prepareFonts', () => {
    test('waits for both the document font and the canvas bytes before opening the editor', async () => {
        let finishFace!: () => void;
        let finishFetch!: (response: Response) => void;
        let fetches = 0;
        const added: FontFace[] = [];
        const loadedSources: string[] = [];

        class SlowFontFace {
            constructor(_family: string, source: string) {
                loadedSources.push(source);
            }

            load(): Promise<FontFace> {
                return new Promise((resolve) => {
                    finishFace = () => resolve(this as unknown as FontFace);
                });
            }
        }

        Object.defineProperty(globalThis, 'FontFace', {
            configurable: true,
            value: SlowFontFace
        });
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: { fonts: { add: (face: FontFace) => added.push(face) } }
        });
        globalThis.fetch = (() => {
            fetches++;
            return new Promise<Response>((resolve) => {
                finishFetch = resolve;
            });
        }) as unknown as typeof fetch;

        let ready = false;
        const loading = prepareFonts([{ family: 'Slow', url: '/api/assets/slow.woff2' }]).then(
            () => {
                ready = true;
            }
        );

        expect(loadedSources).toHaveLength(0);
        expect(ready).toBe(false);

        finishFetch(new Response(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(loadedSources).toHaveLength(1);
        expect(loadedSources[0]).toContain('data:font/woff2;base64,');
        expect(ready).toBe(false);

        finishFace();
        await loading;
        expect(added).toHaveLength(1);
        expect(ready).toBe(true);
        expect(await fontFaceCssForHtml('<p style="font-family: Slow">Hi</p>')).toContain(
            'data:font/woff2;base64,'
        );
        expect(fetches).toBe(1);
    });
});
