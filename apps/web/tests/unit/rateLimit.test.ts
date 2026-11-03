import { describe, expect, spyOn, test } from 'bun:test';

import { checkRateLimit } from '../../src/server/rateLimit';

describe('HTTP rate limit scopes', () => {
    test('image tiles have a separate, larger budget than ordinary reads', () => {
        const subjectKey = `ip:test-${Math.random()}`;
        const read = checkRateLimit({ subjectKey, scope: 'read' });
        const tile = checkRateLimit({ subjectKey, scope: 'image-tile' });
        const mutation = checkRateLimit({ subjectKey });

        expect(read.remaining).toBe(read.limitPerMinute - 1);
        expect(tile.limitPerMinute).toBe(read.limitPerMinute * 5);
        expect(tile.remaining).toBe(tile.limitPerMinute - 1);
        expect(mutation.remaining).toBe(mutation.limitPerMinute - 1);

        checkRateLimit({ subjectKey, scope: 'image-tile' });
        expect(checkRateLimit({ subjectKey, scope: 'read' }).remaining).toBe(
            read.limitPerMinute - 2
        );
        for (let i = 2; i < read.limitPerMinute; i++) {
            checkRateLimit({ subjectKey, scope: 'read' });
        }
        expect(checkRateLimit({ subjectKey, scope: 'read' }).allowed).toBe(false);
        expect(checkRateLimit({ subjectKey, scope: 'image-tile' }).allowed).toBe(true);
    });

    test('anonymous requests keep their higher limit in each scope', () => {
        const known = checkRateLimit({ subjectKey: `ip:known-${Math.random()}`, scope: 'read' });
        const read = checkRateLimit({ subjectKey: 'anonymous', scope: 'read' });
        const tile = checkRateLimit({ subjectKey: 'anonymous', scope: 'image-tile' });
        expect(read.limitPerMinute).toBe(known.limitPerMinute * 10);
        expect(tile.limitPerMinute).toBe(read.limitPerMinute * 5);
    });

    test('expired requests leave the sliding window', () => {
        const now = Date.now();
        const clock = spyOn(Date, 'now').mockReturnValue(now);
        const subjectKey = `ip:expiry-${Math.random()}`;
        try {
            const first = checkRateLimit({ subjectKey, scope: 'read' });
            clock.mockReturnValue(now + 60_001);
            const next = checkRateLimit({ subjectKey, scope: 'read' });
            expect(next.remaining).toBe(first.remaining);
        } finally {
            clock.mockRestore();
        }
    });
});
