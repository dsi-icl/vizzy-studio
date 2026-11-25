import { expect, test } from 'bun:test';

import { coalesceInFlight } from './coalesceInFlight';

test('concurrent reads for one project share a lookup but later reads are fresh', async () => {
    let calls = 0;
    let finish!: (value: number) => void;
    const load = coalesceInFlight(() => {
        calls += 1;
        if (calls > 1) return Promise.resolve(43);
        return new Promise<number>((resolve) => {
            finish = resolve;
        });
    });

    const first = load('project');
    const second = load('project');
    expect(first).toBe(second);
    await Promise.resolve();
    expect(calls).toBe(1);
    finish(42);
    expect(await first).toBe(42);
    expect(await load('project')).toBe(43);
    expect(calls).toBe(2);
});

test('a failed lookup is cleared for a later attempt', async () => {
    let calls = 0;
    const load = coalesceInFlight(async () => {
        calls += 1;
        if (calls === 1) throw new Error('temporary');
        return 'ready';
    });

    const first = load('project');
    expect(load('project')).toBe(first);
    await expect(first).rejects.toThrow('temporary');
    expect(await load('project')).toBe('ready');
    expect(calls).toBe(2);
});
