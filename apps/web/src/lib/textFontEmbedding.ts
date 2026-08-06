/**
 * Supplies fonts to the canvas renderer.
 *
 * `textToCanvas` rasterises an SVG through an `Image`, and that document cannot
 * see the page's fonts — neither the stylesheet's `@font-face` rules nor
 * anything registered via `document.fonts`. The bytes have to be inlined into
 * the SVG itself, which is why this exists rather than relying on `fonts.css`.
 *
 * Inlining everything would be prohibitive: the six bundled families total
 * ~840 KB across their subsets, and the SVG is rebuilt on every debounced
 * render. So only the families a fragment actually references, and only the
 * subsets its characters actually need, are embedded.
 */
import { BUNDLED_FONTS, type BundledFontSubset } from './bundledFonts.generated';

/** One parsed `U+xxxx` / `U+xxxx-yyyy` entry from a unicode-range. */
type CodepointRange = { start: number; end: number };

const rangeCache = new Map<string, CodepointRange[]>();
const base64Cache = new Map<string, Promise<string | null>>();

export function parseUnicodeRange(declaration: string): CodepointRange[] {
    const cached = rangeCache.get(declaration);
    if (cached) return cached;

    const ranges: CodepointRange[] = [];
    for (const raw of declaration.split(',')) {
        const entry = raw.trim().replace(/^u\+/i, '');
        if (!entry) continue;
        const [from, to] = entry.split('-');
        const start = Number.parseInt(from, 16);
        if (!Number.isFinite(start)) continue;
        const end = to ? Number.parseInt(to, 16) : start;
        ranges.push({ start, end: Number.isFinite(end) ? end : start });
    }
    rangeCache.set(declaration, ranges);
    return ranges;
}

function rangesCover(ranges: CodepointRange[], codepoint: number): boolean {
    return ranges.some((range) => codepoint >= range.start && codepoint <= range.end);
}

/** Strip tags so only rendered characters drive subset selection. */
export function visibleTextOf(html: string): string {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]*>/g, '')
        .replace(/&[a-z]+;|&#\d+;|&#x[\da-f]+;/gi, ' ');
}

/** Family names referenced by `font-family` declarations, in the order found. */
export function referencedFamilies(html: string): string[] {
    const found: string[] = [];
    // Stops at `;` or the closing `"` of the style attribute. Single quotes are
    // allowed through, since they delimit family names rather than the attribute.
    for (const match of html.matchAll(/font-family\s*:\s*([^;"]*)/gi)) {
        for (const part of match[1].split(',')) {
            const name = part.trim().replace(/^['"]|['"]$/g, '');
            if (name && !found.includes(name)) found.push(name);
        }
    }
    return found;
}

/** Subsets of `font` whose ranges cover at least one character of `text`. */
export function requiredSubsets(
    font: { subsets: BundledFontSubset[] },
    text: string
): BundledFontSubset[] {
    const codepoints = new Set<number>();
    for (const char of text) {
        const code = char.codePointAt(0);
        if (code !== undefined) codepoints.add(code);
    }
    if (codepoints.size === 0) return [];

    return font.subsets.filter((subset) => {
        const ranges = parseUnicodeRange(subset.unicodeRange);
        for (const code of codepoints) {
            if (rangesCover(ranges, code)) return true;
        }
        return false;
    });
}

function toBase64(bytes: ArrayBuffer): string {
    const view = new Uint8Array(bytes);
    let binary = '';
    // Chunked: spreading a large array into String.fromCharCode overflows the
    // call stack for font-sized payloads.
    const CHUNK = 0x8000;
    for (let i = 0; i < view.length; i += CHUNK) {
        binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/** Fetch a subset once and keep its base64 for the lifetime of the page. */
function loadSubsetBase64(url: string): Promise<string | null> {
    const cached = base64Cache.get(url);
    if (cached) return cached;

    const pending = fetch(url)
        .then((response) => (response.ok ? response.arrayBuffer() : null))
        .then((buffer) => (buffer ? toBase64(buffer) : null))
        .catch(() => null);

    base64Cache.set(url, pending);
    return pending;
}

/**
 * Build the `@font-face` rules an SVG needs to render `html` faithfully.
 * Returns an empty string when nothing bundled is referenced, so callers can
 * concatenate unconditionally.
 */
export async function buildEmbeddedFontFaces(html: string, baseFamily: string): Promise<string> {
    const families = [baseFamily, ...referencedFamilies(html)];
    const text = visibleTextOf(html);
    if (!text.trim()) return '';

    const wanted = BUNDLED_FONTS.filter((font) =>
        families.some((name) => name.toLowerCase() === font.family.toLowerCase())
    );
    if (wanted.length === 0) return '';

    const rules = await Promise.all(
        wanted.flatMap((font) =>
            requiredSubsets(font, text).map(async (subset) => {
                const base64 = await loadSubsetBase64(subset.url);
                if (!base64) return '';
                const weight = font.variable ? '100 900' : String(subset.weight ?? 400);
                return [
                    '@font-face{',
                    `font-family:'${font.family}';`,
                    'font-style:normal;',
                    `font-weight:${weight};`,
                    `src:url(data:font/woff2;base64,${base64}) format('woff2');`,
                    `unicode-range:${subset.unicodeRange};`,
                    '}'
                ].join('');
            })
        )
    );

    return rules.join('');
}

/** Warm the cache for a family so the first render does not wait on the network. */
export function preloadFontFamily(family: string): void {
    const font = BUNDLED_FONTS.find((f) => f.family.toLowerCase() === family.toLowerCase());
    if (!font) return;
    for (const subset of font.subsets) {
        if (subset.subset === 'latin') void loadSubsetBase64(subset.url);
    }
}
