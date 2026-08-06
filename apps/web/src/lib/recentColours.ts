/**
 * Rules for the per-project recent-colour palette.
 *
 * Kept free of bus and database imports so the ordering and normalisation are
 * testable on their own.
 */

/** How many colours a project remembers. */
export const RECENT_COLOUR_LIMIT = 10;

/** `#RGB`, `#RGBA`, `#RRGGBB` or `#RRGGBBAA`. */
const HEX_COLOUR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Normalise for storage and comparison. Returns null for anything that is not a
 * hex colour, so malformed input never reaches the palette.
 */
export function normaliseColour(raw: string): string | null {
    const trimmed = raw.trim().toLowerCase();
    if (!HEX_COLOUR.test(trimmed)) return null;
    // A fully opaque 8-digit value is the same colour as its 6-digit form; fold
    // them together so picking the same swatch twice does not create two entries.
    if (trimmed.length === 9 && trimmed.endsWith('ff')) return trimmed.slice(0, 7);
    if (trimmed.length === 5 && trimmed.endsWith('f')) return trimmed.slice(0, 4);
    return trimmed;
}

/**
 * Add `colour` to the front if it is not already present, and cap the list.
 *
 * Deliberately not most-recently-used: re-picking an existing colour leaves the
 * palette untouched. Reordering would shift swatches under the cursor, and in a
 * shared session another user's pick could move the square you were aiming for.
 *
 * Returns the original array when nothing changed, so callers can skip marking
 * anything dirty or broadcasting.
 */
export function withRecentColour(current: readonly string[], colour: string): string[] {
    const normalised = normaliseColour(colour);
    if (!normalised) return current as string[];
    if (current.includes(normalised)) return current as string[];

    return [normalised, ...current].slice(0, RECENT_COLOUR_LIMIT);
}

/** Drop anything malformed and duplicated, e.g. when reading a legacy record. */
export function sanitiseRecentColours(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        const normalised = normaliseColour(entry);
        if (!normalised || seen.has(normalised)) continue;
        seen.add(normalised);
        out.push(normalised);
        if (out.length >= RECENT_COLOUR_LIMIT) break;
    }
    return out;
}
