export type ExplicitCommitKey = 'Enter' | 'Tab';

export function isExplicitCommitKey(key: string): key is ExplicitCommitKey {
    return key === 'Enter' || key === 'Tab';
}

export function normalizeHexColor(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('#')) return null;

    const hex = trimmed.slice(1);
    if (![3, 4, 6, 8].includes(hex.length)) return null;
    if (!/^[0-9a-fA-F]+$/.test(hex)) return null;

    return `#${hex.toLowerCase()}`;
}

export function parseBoundedNumber(raw: string, min: number, max: number): number | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const value = Number(trimmed);
    if (!Number.isFinite(value) || value < min || value > max) return null;

    return value;
}
