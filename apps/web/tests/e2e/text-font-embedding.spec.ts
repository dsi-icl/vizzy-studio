import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from 'playwright/test';

/**
 * Decides how vendored fonts must reach the canvas renderer.
 *
 * `textToCanvas` builds an SVG, wraps it in a Blob and loads it into an
 * `Image`. That SVG document is independent of the page, so it is not obvious
 * whether fonts registered in `document.fonts` apply to it, or whether the
 * bytes have to be embedded in the SVG itself.
 *
 * Renders identical text three ways and compares the rasters:
 *   fallback  — family named but nowhere defined
 *   embedded  — @font-face with a base64 payload inside the SVG
 *   document  — registered via FontFace on the page, absent from the SVG
 *
 * Pixels are compared by screenshotting the <img>, not via getImageData:
 * drawing an SVG that contains a foreignObject taints the canvas, so readback
 * throws. Production only ever draws, never reads, so that limitation does not
 * affect the renderer itself.
 */

const PROBE_FAMILY = 'VizzyFontProbe';
const SAMPLE_TEXT = 'Hamburgefonstiv 123';
const WIDTH = 900;
const HEIGHT = 160;

function loadProbeFontBase64(): string {
    return readFileSync(
        resolve(
            process.cwd(),
            'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'
        )
    ).toString('base64');
}

function buildSvg(fontFace: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
        <foreignObject width="100%" height="100%">
            <div xmlns="http://www.w3.org/1999/xhtml"
                 style="width:${WIDTH}px;height:${HEIGHT}px;font-family:'${PROBE_FAMILY}';font-size:64px;color:black;background:white;">
                <style>${fontFace}</style>
                ${SAMPLE_TEXT}
            </div>
        </foreignObject>
    </svg>`;
}

/** Mount an SVG as an <img> and screenshot it once decoded. */
async function renderVariant(page: Page, id: string, svg: string): Promise<Buffer> {
    await page.evaluate(
        async ({ elementId, markup }) => {
            const blob = new Blob([markup], { type: 'image/svg+xml;charset=utf-8' });
            const img = document.createElement('img');
            img.id = elementId;
            img.src = URL.createObjectURL(blob);
            document.body.appendChild(img);
            await img.decode();
        },
        { elementId: id, markup: svg }
    );
    return page.locator(`#${id}`).screenshot();
}

test('determines whether vendored fonts must be embedded in the SVG @cross-browser', async ({
    page
}) => {
    // A real same-origin blank page: blob URLs do not load from about:blank,
    // and any app route would navigate out from under the measurement.
    await page.route('**/__font_probe', (route) =>
        route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><html><body style="margin:0"></body></html>'
        })
    );
    await page.goto('/__font_probe');

    const base64 = loadProbeFontBase64();
    const embeddedFace = `@font-face{font-family:'${PROBE_FAMILY}';src:url(data:font/woff2;base64,${base64}) format('woff2');}`;

    const fallback = await renderVariant(page, 'probe-fallback', buildSvg(''));
    const embedded = await renderVariant(page, 'probe-embedded', buildSvg(embeddedFace));

    // Register on the page only, deliberately not inside the SVG.
    await page.evaluate(
        async ({ family, payload }) => {
            const face = new FontFace(family, `url(data:font/woff2;base64,${payload})`);
            await face.load();
            document.fonts.add(face);
            await document.fonts.ready;
        },
        { family: PROBE_FAMILY, payload: base64 }
    );
    const fromDocument = await renderVariant(page, 'probe-document', buildSvg(''));

    const embeddingWorks = !embedded.equals(fallback);
    const documentFontsReachSvg = !fromDocument.equals(fallback);

    console.log(`  embedding changes the raster        : ${embeddingWorks}`);
    console.log(`  document fonts reach the SVG        : ${documentFontsReachSvg}`);
    console.log(
        `  bytes fallback/embedded/document    : ${fallback.length}/${embedded.length}/${fromDocument.length}`
    );

    // Embedding is the mechanism the renderer will rely on, so it must work.
    expect(embeddingWorks).toBe(true);
});
