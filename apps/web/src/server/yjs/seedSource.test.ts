import { describe, expect, test } from 'bun:test';

import { chooseSeedSource } from './seedSource';

const SUPPORTED = 1;

function choose(overrides: Partial<Parameters<typeof chooseSeedSource>[0]>) {
    return chooseSeedSource({
        hasTextState: true,
        textFormat: SUPPORTED,
        supportedFormat: SUPPORTED,
        ...overrides
    });
}

describe('seed source selection', () => {
    test('prefers structured state when present and readable', () => {
        expect(choose({})).toBe('state');
    });

    test('falls back to HTML for a legacy layer with no state', () => {
        expect(choose({ hasTextState: false, textFormat: undefined })).toBe('html');
    });

    test('falls back to HTML when the format stamp is missing', () => {
        expect(choose({ textFormat: undefined })).toBe('html');
    });

    test('falls back to HTML when the format stamp is zero', () => {
        expect(choose({ textFormat: 0 })).toBe('html');
    });

    test('ignores a state written by a newer deploy rather than guessing', () => {
        expect(choose({ textFormat: SUPPORTED + 1 })).toBe('html');
    });

    test('still reads an older but supported format', () => {
        expect(choose({ textFormat: 1, supportedFormat: 3 })).toBe('state');
    });

    test('a present stamp with no state is not trusted', () => {
        expect(choose({ hasTextState: false })).toBe('html');
    });
});
