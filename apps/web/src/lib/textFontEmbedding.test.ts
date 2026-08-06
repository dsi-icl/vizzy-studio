import { describe, expect, test } from 'bun:test';

import { BUNDLED_FONTS } from './bundledFonts.generated';
import {
    parseUnicodeRange,
    referencedFamilies,
    requiredSubsets,
    visibleTextOf
} from './textFontEmbedding';

const inter = BUNDLED_FONTS.find((font) => font.family === 'Inter');

describe('unicode-range parsing', () => {
    test('reads single codepoints and spans', () => {
        expect(parseUnicodeRange('U+0041,U+0100-017F')).toEqual([
            { start: 0x41, end: 0x41 },
            { start: 0x100, end: 0x17f }
        ]);
    });

    test('tolerates spacing and casing', () => {
        expect(parseUnicodeRange(' u+0041 , U+0042 ')).toEqual([
            { start: 0x41, end: 0x41 },
            { start: 0x42, end: 0x42 }
        ]);
    });

    test('skips malformed entries rather than throwing', () => {
        expect(parseUnicodeRange('U+,nonsense,U+0041')).toEqual([{ start: 0x41, end: 0x41 }]);
    });
});

describe('extracting the rendered text', () => {
    test('drops tags and embedded style blocks', () => {
        expect(visibleTextOf('<style>p{color:red}</style><p>Hello</p>').trim()).toBe('Hello');
    });

    test('keeps text content across nested markup', () => {
        expect(visibleTextOf('<p><span style="color:red">Ab</span><b>Cd</b></p>')).toContain(
            'AbCd'
        );
    });
});

describe('finding referenced families', () => {
    test('reads every family in a declaration list', () => {
        expect(
            referencedFamilies(`<span style="font-family: 'Inter', sans-serif">x</span>`)
        ).toEqual(['Inter', 'sans-serif']);
    });

    test('deduplicates across multiple spans', () => {
        const html = `<span style="font-family:Inter">a</span><span style="font-family:Inter">b</span>`;
        expect(referencedFamilies(html)).toEqual(['Inter']);
    });

    test('returns nothing when no family is declared', () => {
        expect(referencedFamilies('<p>plain</p>')).toEqual([]);
    });
});

describe('selecting subsets for the text', () => {
    test('latin text pulls only the latin subset', () => {
        if (!inter) throw new Error('Inter missing from the bundled manifest');
        const subsets = requiredSubsets(inter, 'Hello world');
        expect(subsets.map((s) => s.subset)).toEqual(['latin']);
    });

    test('cyrillic text pulls the cyrillic subset', () => {
        if (!inter) throw new Error('Inter missing from the bundled manifest');
        const subsets = requiredSubsets(inter, 'Привет');
        expect(subsets.map((s) => s.subset)).toContain('cyrillic');
    });

    test('greek text pulls the greek subset', () => {
        if (!inter) throw new Error('Inter missing from the bundled manifest');
        const subsets = requiredSubsets(inter, 'Γειά σου');
        expect(subsets.map((s) => s.subset)).toContain('greek');
    });

    test('mixed scripts pull each needed subset', () => {
        if (!inter) throw new Error('Inter missing from the bundled manifest');
        const subsets = requiredSubsets(inter, 'Hello Привет').map((s) => s.subset);
        expect(subsets).toContain('latin');
        expect(subsets).toContain('cyrillic');
    });

    test('empty text pulls nothing', () => {
        if (!inter) throw new Error('Inter missing from the bundled manifest');
        expect(requiredSubsets(inter, '')).toEqual([]);
    });

    test('never pulls every subset for ordinary text', () => {
        if (!inter) throw new Error('Inter missing from the bundled manifest');
        // The whole point of subsetting: a latin string must not drag in ~840KB.
        expect(requiredSubsets(inter, 'The quick brown fox').length).toBeLessThan(
            inter.subsets.length
        );
    });
});

describe('bundled manifest', () => {
    test('ships the six expected families', () => {
        expect(BUNDLED_FONTS.map((f) => f.family).sort()).toEqual([
            'IBM Plex Mono',
            'IBM Plex Sans',
            'IBM Plex Serif',
            'Inter',
            'JetBrains Mono',
            'Source Serif 4'
        ]);
    });

    test('every family covers latin and declares a generic fallback', () => {
        for (const font of BUNDLED_FONTS) {
            expect(font.subsets.some((s) => s.subset === 'latin')).toBe(true);
            expect(font.css).toMatch(/(sans-serif|serif|monospace)$/);
        }
    });

    test('every subset points at a served font file', () => {
        for (const font of BUNDLED_FONTS) {
            for (const subset of font.subsets) {
                expect(subset.url).toMatch(/^\/fonts\/.+\.woff2$/);
            }
        }
    });
});
