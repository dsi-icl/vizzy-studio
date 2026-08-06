import { describe, expect, test } from 'bun:test';

import {
    captureScopeRevision,
    KeyedSerialQueue,
    markScopeDirty,
    markScopePersisted,
    type DirtyTracked
} from './scopePersistence';

/** Flush pending microtasks so queued work has a chance to start. */
function settle() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('KeyedSerialQueue', () => {
    test('serializes work sharing a key', async () => {
        const queue = new KeyedSerialQueue<string>();
        const order: string[] = [];
        const first = deferred();

        const a = queue.run('scope', async () => {
            order.push('a:start');
            await first.promise;
            order.push('a:end');
        });
        const b = queue.run('scope', async () => {
            order.push('b:start');
        });

        await settle();
        // The second task must not have started while the first is blocked.
        expect(order).toEqual(['a:start']);
        first.resolve();
        await Promise.all([a, b]);
        expect(order).toEqual(['a:start', 'a:end', 'b:start']);
    });

    test('lets unrelated keys proceed concurrently', async () => {
        const queue = new KeyedSerialQueue<string>();
        const order: string[] = [];
        const blocked = deferred();

        const a = queue.run('one', async () => {
            order.push('one:start');
            await blocked.promise;
        });
        const b = queue.run('two', async () => {
            order.push('two:done');
        });

        await b;
        await settle();
        expect(order).toEqual(['one:start', 'two:done']);
        blocked.resolve();
        await a;
    });

    test('continues the queue after a task rejects', async () => {
        const queue = new KeyedSerialQueue<string>();
        const failing = queue
            .run('scope', async () => {
                throw new Error('boom');
            })
            .catch((error: Error) => error.message);
        expect(await failing).toBe('boom');

        const after = await queue.run('scope', async () => 'ok');
        expect(after).toBe('ok');
    });

    test('propagates a rejection to its own caller only', async () => {
        const queue = new KeyedSerialQueue<string>();
        const bad = queue
            .run('scope', async () => {
                throw new Error('first');
            })
            .catch((error: Error) => error.message);
        const good = queue.run('scope', async () => 'second');

        expect(await bad).toBe('first');
        expect(await good).toBe('second');
    });

    test('releases keys once drained', async () => {
        const queue = new KeyedSerialQueue<string>();
        await queue.run('scope', async () => 'done');
        await Promise.resolve();
        expect(queue.pendingKeys).toBe(0);
    });
});

describe('revision-guarded dirty flag', () => {
    test('a persist that covers every mutation marks the scope clean', () => {
        const scope: DirtyTracked = { dirty: false };
        markScopeDirty(scope);
        const revision = captureScopeRevision(scope);
        expect(markScopePersisted(scope, revision)).toBe(true);
        expect(scope.dirty).toBe(false);
    });

    test('a mutation arriving mid-write keeps the scope dirty', () => {
        const scope: DirtyTracked = { dirty: false };
        markScopeDirty(scope);
        const inFlight = captureScopeRevision(scope);

        markScopeDirty(scope); // lands while the write is still running

        expect(markScopePersisted(scope, inFlight)).toBe(false);
        expect(scope.dirty).toBe(true);
    });

    test('the following persist then clears it', () => {
        const scope: DirtyTracked = { dirty: false };
        markScopeDirty(scope);
        const stale = captureScopeRevision(scope);
        markScopeDirty(scope);
        markScopePersisted(scope, stale);

        const current = captureScopeRevision(scope);
        expect(markScopePersisted(scope, current)).toBe(true);
        expect(scope.dirty).toBe(false);
    });

    test('tolerates a scope that predates revision tracking', () => {
        const scope: DirtyTracked = { dirty: true };
        expect(captureScopeRevision(scope)).toBe(0);
        expect(markScopeDirty(scope)).toBe(1);
    });
});
