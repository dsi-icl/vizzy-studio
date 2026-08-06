/**
 * Copies the bundled text fonts out of node_modules into the web app's public
 * directory, and generates the @font-face stylesheet that goes with them.
 *
 * They are served as plain files rather than imported through the bundler
 * because the canvas renderer needs to fetch the bytes at runtime: an SVG
 * rasterised through an Image cannot see the page's fonts, so the woff2 has to
 * be inlined into the SVG itself. Fetching a stable URL works the same in dev,
 * production and the container.
 *
 * Run with: bun run fonts:vendor
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = resolve(root, 'apps/web/public/fonts');
const cssPath = resolve(root, 'apps/web/src/fonts.css');
const manifestPath = resolve(root, 'apps/web/src/lib/bundledFonts.generated.ts');

/** Subsets to ship. Ordered so the smaller, likelier ones are declared first. */
const SUBSETS = ['latin', 'latin-ext', 'vietnamese', 'greek', 'cyrillic', 'cyrillic-ext'];

/**
 * unicode-range per subset, taken from the fontsource stylesheets. Declaring
 * these lets the browser download only what a given string needs, and lets the
 * canvas renderer decide which subsets to inline.
 */
const UNICODE_RANGES = {
    latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
    'latin-ext':
        'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
    vietnamese:
        'U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB',
    greek: 'U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF',
    cyrillic: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116',
    'cyrillic-ext': 'U+0460-052F,U+1C80-1C88,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F'
};

/**
 * `pkg` is the node_modules package, `prefix` the filename stem fontsource uses,
 * and `weights` is null for variable fonts (one file covers every weight).
 */
const FAMILIES = [
    {
        family: 'Inter',
        pkg: '@fontsource-variable/inter',
        prefix: 'inter',
        variable: true,
        weights: null,
        generic: 'sans-serif'
    },
    {
        family: 'Source Serif 4',
        pkg: '@fontsource-variable/source-serif-4',
        prefix: 'source-serif-4',
        variable: true,
        weights: null,
        generic: 'serif'
    },
    {
        family: 'JetBrains Mono',
        pkg: '@fontsource-variable/jetbrains-mono',
        prefix: 'jetbrains-mono',
        variable: true,
        weights: null,
        generic: 'monospace'
    },
    {
        family: 'IBM Plex Sans',
        pkg: '@fontsource-variable/ibm-plex-sans',
        prefix: 'ibm-plex-sans',
        variable: true,
        weights: null,
        generic: 'sans-serif'
    },
    {
        family: 'IBM Plex Serif',
        pkg: '@fontsource/ibm-plex-serif',
        prefix: 'ibm-plex-serif',
        variable: false,
        weights: [400, 700],
        generic: 'serif'
    },
    {
        family: 'IBM Plex Mono',
        pkg: '@fontsource/ibm-plex-mono',
        prefix: 'ibm-plex-mono',
        variable: false,
        weights: [400, 700],
        generic: 'monospace'
    }
];

function sourceDir(pkg) {
    return resolve(root, 'node_modules', pkg, 'files');
}

/** Fontsource names variable files `<prefix>-<subset>-wght-normal.woff2`. */
function candidateNames(font, subset, weight) {
    if (font.variable) {
        return [`${font.prefix}-${subset}-wght-normal.woff2`];
    }
    return [`${font.prefix}-${subset}-${weight}-normal.woff2`];
}

function main() {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    const rules = [];
    const manifest = [];
    let totalBytes = 0;

    for (const font of FAMILIES) {
        const available = new Set(readdirSync(sourceDir(font.pkg)));
        const weights = font.weights ?? [null];
        const subsetsShipped = [];
        const files = [];

        for (const subset of SUBSETS) {
            for (const weight of weights) {
                const name = candidateNames(font, subset, weight).find((n) => available.has(n));
                if (!name) continue;

                copyFileSync(resolve(sourceDir(font.pkg), name), resolve(outDir, name));
                totalBytes += Bun.file(resolve(outDir, name)).size;
                if (!subsetsShipped.includes(subset)) subsetsShipped.push(subset);
                files.push({
                    subset,
                    url: `/fonts/${name}`,
                    weight,
                    unicodeRange: UNICODE_RANGES[subset]
                });

                rules.push(
                    [
                        '@font-face {',
                        `    font-family: '${font.family}';`,
                        `    font-style: normal;`,
                        font.variable ? `    font-weight: 100 900;` : `    font-weight: ${weight};`,
                        `    font-display: swap;`,
                        `    src: url('/fonts/${name}') format('woff2');`,
                        `    unicode-range: ${UNICODE_RANGES[subset]};`,
                        '}'
                    ].join('\n')
                );
            }
        }

        manifest.push({ ...font, subsets: subsetsShipped, files });
        console.log(
            `${font.family.padEnd(16)} ${font.variable ? 'variable' : 'static  '} ${subsetsShipped.join(', ')}`
        );
    }

    writeFileSync(
        cssPath,
        [
            '/* Generated by tooling/scripts/vendor-fonts.mjs — do not edit. */',
            '/* Run `bun run fonts:vendor` to regenerate. */',
            '',
            ...rules,
            ''
        ].join('\n')
    );

    writeFileSync(
        manifestPath,
        [
            '// Generated by tooling/scripts/vendor-fonts.mjs — do not edit.',
            '// Run `bun run fonts:vendor` to regenerate.',
            '',
            'export type BundledFontSubset = {',
            '    subset: string;',
            '    /** Served path, also fetched by the canvas renderer for inlining. */',
            '    url: string;',
            '    weight: number | null;',
            '    unicodeRange: string;',
            '};',
            '',
            'export type BundledFont = {',
            '    family: string;',
            '    /** Ready to assign to a CSS font-family declaration. */',
            '    css: string;',
            '    variable: boolean;',
            '    subsets: BundledFontSubset[];',
            '};',
            '',
            `export const BUNDLED_FONTS: BundledFont[] = ${JSON.stringify(
                manifest.map((font) => ({
                    family: font.family,
                    css: `'${font.family}', ${font.generic}`,
                    variable: font.variable,
                    subsets: font.files
                })),
                null,
                4
            )};`,
            ''
        ].join('\n')
    );

    console.log(`\n${rules.length} @font-face rules, ${(totalBytes / 1024).toFixed(0)} KB total`);
}

main();
