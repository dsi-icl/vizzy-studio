/**
 * Deterministic per-identity cursor colours, shared by the Lexical text editor
 * and the editor stage peer cursors so one person reads the same in both.
 */
export function getDeterministicCursorColor(seed: string): string {
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
        hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    }
    const color = hash & 0xffffff;
    return `#${color.toString(16).padStart(6, '0')}`;
}

/** Pick black or white text for a label sitting on a cursor colour. */
export function getReadableTextColor(hex: string): string {
    const value = Number.parseInt(hex.replace('#', ''), 16);
    const r = (value >> 16) & 0xff;
    const g = (value >> 8) & 0xff;
    const b = value & 0xff;
    // Rec. 601 luma is close enough to pick a side of the contrast fence.
    const luma = (r * 299 + g * 587 + b * 114) / 1000;
    return luma > 140 ? '#000000' : '#ffffff';
}
