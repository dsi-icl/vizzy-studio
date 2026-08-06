import { describe, expect, test } from 'bun:test';

import { transitionTextHydrationState, type TextHydrationState } from './textHydrationState';

function run(
    from: TextHydrationState,
    ...events: Parameters<typeof transitionTextHydrationState>[1][]
) {
    return events.reduce(transitionTextHydrationState, from);
}

describe('text hydration state machine', () => {
    test('starts connecting and reaches synced', () => {
        expect(run('connecting', 'attempt', 'synced')).toBe('synced');
    });

    test('a drop after syncing is a reconnect, not a failure', () => {
        expect(run('synced', 'interrupted')).toBe('connecting');
    });

    test('a timeout while still connecting is an error', () => {
        expect(run('connecting', 'timeout')).toBe('error');
    });

    test('a timeout after syncing is ignored', () => {
        expect(run('synced', 'timeout')).toBe('synced');
    });

    test('an error clears once something syncs', () => {
        expect(run('error', 'synced')).toBe('synced');
    });

    test('an error survives further interruptions', () => {
        expect(run('error', 'interrupted', 'interrupted')).toBe('error');
    });

    test('retrying after an error shows connecting again', () => {
        expect(run('error', 'attempt')).toBe('connecting');
    });

    test('a reconnect cycle returns to synced without flashing an error', () => {
        expect(run('synced', 'interrupted', 'attempt', 'synced')).toBe('synced');
    });
});
