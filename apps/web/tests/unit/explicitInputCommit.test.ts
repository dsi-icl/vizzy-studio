import { describe, expect, test } from 'bun:test';

import {
    isExplicitCommitKey,
    normalizeHexColor,
    parseBoundedNumber
} from '../../src/lib/explicitInputCommit';

describe('explicit toolbar input commits', () => {
    test('accepts Enter and Tab as explicit commit keys', () => {
        expect(isExplicitCommitKey('Enter')).toBe(true);
        expect(isExplicitCommitKey('Tab')).toBe(true);
        expect(isExplicitCommitKey('Escape')).toBe(false);
        expect(isExplicitCommitKey('a')).toBe(false);
    });

    test('normalizes complete supported hex colours', () => {
        expect(normalizeHexColor('#ABC')).toBe('#abc');
        expect(normalizeHexColor(' #AbCd ')).toBe('#abcd');
        expect(normalizeHexColor('#A1B2C3')).toBe('#a1b2c3');
        expect(normalizeHexColor('#A1B2C3D4')).toBe('#a1b2c3d4');
    });

    test('rejects incomplete and malformed hex colours', () => {
        expect(normalizeHexColor('#ab')).toBeNull();
        expect(normalizeHexColor('#abcde')).toBeNull();
        expect(normalizeHexColor('#ggg')).toBeNull();
        expect(normalizeHexColor('abcdef')).toBeNull();
    });

    test('parses only complete finite numbers within the requested bounds', () => {
        expect(parseBoundedNumber('10', 10, 1000)).toBe(10);
        expect(parseBoundedNumber(' 24.5 ', 10, 1000)).toBe(24.5);
        expect(parseBoundedNumber('1000', 10, 1000)).toBe(1000);
        expect(parseBoundedNumber('', 10, 1000)).toBeNull();
        expect(parseBoundedNumber('12px', 10, 1000)).toBeNull();
        expect(parseBoundedNumber('9', 10, 1000)).toBeNull();
        expect(parseBoundedNumber('1001', 10, 1000)).toBeNull();
        expect(parseBoundedNumber('Infinity', 10, 1000)).toBeNull();
    });
});
