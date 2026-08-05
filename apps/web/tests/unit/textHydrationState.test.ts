import { describe, expect, test } from 'bun:test';

import { transitionTextHydrationState } from '../../src/components/editor/textHydrationState';

describe('text hydration presentation state', () => {
    test('keeps transient connection failures in the loading state', () => {
        expect(transitionTextHydrationState('connecting', 'interrupted')).toBe('connecting');
        expect(transitionTextHydrationState('synced', 'interrupted')).toBe('connecting');
    });

    test('shows an error only when a loading attempt times out', () => {
        expect(transitionTextHydrationState('connecting', 'timeout')).toBe('error');
        expect(transitionTextHydrationState('synced', 'timeout')).toBe('synced');
    });

    test('keeps a timed-out attempt stable until it succeeds or is retried', () => {
        expect(transitionTextHydrationState('error', 'interrupted')).toBe('error');
        expect(transitionTextHydrationState('error', 'synced')).toBe('synced');
        expect(transitionTextHydrationState('error', 'attempt')).toBe('connecting');
    });
});
