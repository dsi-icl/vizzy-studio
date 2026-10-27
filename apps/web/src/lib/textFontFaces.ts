export interface TextFontSource {
    family: string;
    url: string;
}

interface FontEntry {
    family: string;
    url: string;
    bytes?: Promise<string | null>;
    failedAt?: number;
}

const fonts = new Map<string, FontEntry>();

const FAILURE_RETRY_MS = 10_000;

const listeners = new Set<() => void>();
let revision = 0;

function normalizeFamily(value: string): string {
    return value.replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function registerTextFontSources(sources: readonly TextFontSource[]): void {
    let changed = false;
    for (const source of sources) {
        const key = normalizeFamily(source.family);
        if (!key) continue;
        if (fonts.get(key)?.url === source.url) continue;
        fonts.set(key, { family: source.family, url: source.url });
        changed = true;
    }
    if (!changed) return;
    revision += 1;
    for (const listener of listeners) listener();
}

export function getTextFontRevision(): number {
    return revision;
}

export function subscribeTextFonts(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function resetTextFontSources(): void {
    fonts.clear();
    revision = 0;
}

function toBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

function loadDataUri(key: string): Promise<string | null> {
    const entry = fonts.get(key);
    if (!entry) return Promise.resolve(null);
    if (entry.bytes) return entry.bytes;
    if (entry.failedAt !== undefined && Date.now() - entry.failedAt < FAILURE_RETRY_MS) {
        return Promise.resolve(null);
    }

    entry.bytes = fetch(entry.url, { credentials: 'same-origin' })
        .then((res) => {
            if (!res.ok) throw new Error(`Font fetch failed: ${res.status}`);
            return res.arrayBuffer();
        })
        .then((buffer) => {
            entry.failedAt = undefined;
            return `data:font/woff2;base64,${toBase64(buffer)}`;
        })
        .catch((error) => {
            console.warn(`Failed to inline font ${entry.family}:`, error);
            if (fonts.get(key) === entry) {
                entry.bytes = undefined;
                entry.failedAt = Date.now();
            }
            return null;
        });

    return entry.bytes;
}

const FONT_FAMILY_ITEM = `"[^"]*"|'[^']*'|[^;"',]+`;
const FONT_FAMILY_DECLARATION = new RegExp(
    `font-family\\s*:\\s*((?:${FONT_FAMILY_ITEM})(?:\\s*,\\s*(?:${FONT_FAMILY_ITEM}))*)`,
    'gi'
);

export function extractFontFamilies(html: string): string[] {
    if (!html.includes('font-family')) return [];

    const seen = new Set<string>();
    const out: string[] = [];

    const collect = (declaration: string) => {
        for (const part of declaration.split(',')) {
            const family = part.replace(/["']/g, '').trim();
            if (!family) continue;
            const key = normalizeFamily(family);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(family);
        }
    };

    const unescaped = html
        .replace(/&quot;/gi, '')
        .replace(/&apos;/gi, '')
        .replace(/&#0*39;/g, '')
        .replace(/&#0*34;/g, '');

    for (const match of unescaped.matchAll(FONT_FAMILY_DECLARATION)) {
        collect(match[1]);
    }

    return out;
}

function cssQuote(value: string): string {
    return `"${value.replace(/[\\"]/g, '\\$&').replace(/[\r\n]/g, '')}"`;
}

export async function fontFaceCssForHtml(html: string): Promise<string> {
    const wanted = extractFontFamilies(html)
        .map((family) => ({ family, key: normalizeFamily(family) }))
        .filter(({ key }) => fonts.has(key));
    if (wanted.length === 0) return '';

    const rules = await Promise.all(
        wanted.map(async ({ family, key }) => {
            const dataUri = await loadDataUri(key);
            if (!dataUri) return null;
            return `@font-face{font-family:${cssQuote(family)};src:url(${dataUri}) format("woff2");font-display:block;}`;
        })
    );

    return rules.filter((rule): rule is string => rule !== null).join('\n');
}
