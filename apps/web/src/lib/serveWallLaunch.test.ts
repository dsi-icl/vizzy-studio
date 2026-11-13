import { describe, expect, it } from 'bun:test';

import { serveWallLaunchDelayMs } from './serveWallLaunch';

describe('serveWallLaunchDelayMs', () => {
    it('spreads a 64-tile wall across eight launch batches', () => {
        const delays = Array.from({ length: 4 }, (_, row) =>
            Array.from({ length: 16 }, (_, col) => serveWallLaunchDelayMs(col, row, 16, 4))
        ).flat();

        expect(delays[0]).toBe(0);
        expect(delays[63]).toBe(2_100);
        for (let batch = 0; batch < 8; batch += 1) {
            expect(delays.filter((delay) => delay === batch * 300)).toHaveLength(8);
        }
    });

    it('does not delay an invalid tile coordinate', () => {
        expect(serveWallLaunchDelayMs(Number.NaN, 0, 16, 4)).toBe(0);
        expect(serveWallLaunchDelayMs(16, 0, 16, 4)).toBe(0);
    });
});
