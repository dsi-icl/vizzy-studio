import { describe, expect, test } from 'bun:test';

import {
    normaliseColour,
    RECENT_COLOUR_LIMIT,
    sanitiseRecentColours,
    withRecentColour
} from './recentColours';

describe('colour normalisation', () => {
    test('lowercases and keeps each supported hex length', () => {
        expect(normaliseColour('#ABC')).toBe('#abc');
        expect(normaliseColour('#AABBCC')).toBe('#aabbcc');
        expect(normaliseColour('#AABBCC80')).toBe('#aabbcc80');
    });

    test('folds a fully opaque value onto its shorter form', () => {
        // The picker emits 8-digit values, so without this the same swatch
        // picked twice would land twice.
        expect(normaliseColour('#AABBCCFF')).toBe('#aabbcc');
        expect(normaliseColour('#ABCF')).toBe('#abc');
    });

    test('trims surrounding whitespace', () => {
        expect(normaliseColour('  #abcdef  ')).toBe('#abcdef');
    });

    test('rejects anything that is not a hex colour', () => {
        expect(normaliseColour('rgb(1,2,3)')).toBeNull();
        expect(normaliseColour('abcdef')).toBeNull();
        expect(normaliseColour('#ab')).toBeNull();
        expect(normaliseColour('#abcde')).toBeNull();
        expect(normaliseColour('#gggggg')).toBeNull();
        expect(normaliseColour('')).toBeNull();
    });
});

describe('recording a colour', () => {
    test('puts a new colour at the front', () => {
        expect(withRecentColour(['#111111'], '#222222')).toEqual(['#222222', '#111111']);
    });

    test('leaves an existing colour where it is rather than promoting it', () => {
        // Reordering would move a swatch under the cursor, and in a shared
        // session someone else's pick could shift the square you were aiming at.
        const current = ['#111111', '#222222', '#333333'];
        expect(withRecentColour(current, '#333333')).toBe(current);
    });

    test('returns the same list when the colour already leads', () => {
        const current = ['#111111', '#222222'];
        expect(withRecentColour(current, '#111111')).toBe(current);
    });

    test('never reorders, whichever existing colour is picked', () => {
        const current = ['#111111', '#222222', '#333333'];
        for (const colour of current) {
            expect(withRecentColour(current, colour)).toEqual(current);
        }
    });

    test('treats an opaque 8-digit value as its 6-digit equivalent', () => {
        const current = ['#aabbcc'];
        expect(withRecentColour(current, '#AABBCCFF')).toBe(current);
    });

    test('caps the list, dropping the oldest', () => {
        const full = Array.from(
            { length: RECENT_COLOUR_LIMIT },
            (_, i) => `#${i.toString(16).repeat(6)}`
        );
        const next = withRecentColour(full, '#ffffff');
        expect(next).toHaveLength(RECENT_COLOUR_LIMIT);
        expect(next[0]).toBe('#ffffff');
        expect(next).not.toContain(full[full.length - 1]);
    });

    test('ignores an unusable colour without disturbing the list', () => {
        const current = ['#111111'];
        expect(withRecentColour(current, 'not-a-colour')).toBe(current);
    });
});

describe('reading a stored palette', () => {
    test('drops malformed and duplicate entries', () => {
        expect(sanitiseRecentColours(['#111111', 'nope', '#111111', '#222222'])).toEqual([
            '#111111',
            '#222222'
        ]);
    });

    test('caps an oversized stored list', () => {
        const oversized = Array.from(
            { length: 40 },
            (_, i) => `#${i.toString(16).padStart(6, '0')}`
        );
        expect(sanitiseRecentColours(oversized)).toHaveLength(RECENT_COLOUR_LIMIT);
    });

    test('tolerates a missing or wrongly typed field', () => {
        expect(sanitiseRecentColours(undefined)).toEqual([]);
        expect(sanitiseRecentColours('#111111')).toEqual([]);
        expect(sanitiseRecentColours(null)).toEqual([]);
    });
});
