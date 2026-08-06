import { describe, expect, test } from 'bun:test';

import { DocumentRegistry } from './documentRegistry';

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

type Doc = { id: string; hydrated: boolean; destroyed: boolean };

describe('document acquisition', () => {
    test('never publishes a document until its build finishes', async () => {
        const registry = new DocumentRegistry<Doc>();
        const gate = deferred();
        const doc: Doc = { id: 'a', hydrated: false, destroyed: false };

        const building = registry.acquire('a', async () => {
            await gate.promise;
            doc.hydrated = true;
            return doc;
        });

        await settle();
        // A concurrent peer must not be able to see the half-built document.
        expect(registry.peek('a')).toBeUndefined();
        expect(registry.readyCount).toBe(0);

        gate.resolve();
        expect(await building).toBe(doc);
        expect(registry.peek('a')?.hydrated).toBe(true);
    });

    test('concurrent acquisitions share one build', async () => {
        const registry = new DocumentRegistry<Doc>();
        let builds = 0;
        const gate = deferred();

        const create = async () => {
            builds += 1;
            await gate.promise;
            return { id: 'a', hydrated: true, destroyed: false };
        };

        const first = registry.acquire('a', create);
        const second = registry.acquire('a', create);
        await settle();
        gate.resolve();

        expect(await first).toBe(await second);
        expect(builds).toBe(1);
    });

    test('a failed build is not cached and the next caller retries', async () => {
        const registry = new DocumentRegistry<Doc>();
        let attempts = 0;

        const failing = registry
            .acquire('a', async () => {
                attempts += 1;
                throw new Error('hydration failed');
            })
            .catch((error: Error) => error.message);
        expect(await failing).toBe('hydration failed');

        const recovered = await registry.acquire('a', async () => {
            attempts += 1;
            return { id: 'a', hydrated: true, destroyed: false };
        });

        expect(attempts).toBe(2);
        expect(recovered.hydrated).toBe(true);
        expect(registry.readyCount).toBe(1);
    });

    test('unrelated names build independently', async () => {
        const registry = new DocumentRegistry<Doc>();
        const blocked = deferred();

        const slow = registry.acquire('slow', async () => {
            await blocked.promise;
            return { id: 'slow', hydrated: true, destroyed: false };
        });
        const fast = await registry.acquire('fast', async () => ({
            id: 'fast',
            hydrated: true,
            destroyed: false
        }));

        expect(fast.id).toBe('fast');
        blocked.resolve();
        await slow;
    });
});

describe('document release', () => {
    test('a reconnect waits for teardown and rebuilds rather than reusing', async () => {
        const registry = new DocumentRegistry<Doc>();
        const original: Doc = { id: 'a', hydrated: true, destroyed: false };
        await registry.acquire('a', async () => original);

        const teardown = deferred();
        const closing = registry.release('a', original, async () => {
            await teardown.promise;
            original.destroyed = true;
        });

        const replacement: Doc = { id: 'a2', hydrated: true, destroyed: false };
        const reconnect = registry.acquire('a', async () => replacement);

        await settle();
        teardown.resolve();
        await closing;

        const resolved = await reconnect;
        expect(resolved).toBe(replacement);
        expect(resolved.destroyed).toBe(false);
        expect(original.destroyed).toBe(true);
    });

    test('releasing clears the ready slot', async () => {
        const registry = new DocumentRegistry<Doc>();
        const doc: Doc = { id: 'a', hydrated: true, destroyed: false };
        await registry.acquire('a', async () => doc);
        expect(registry.readyCount).toBe(1);

        await registry.release('a', doc, async () => {
            doc.destroyed = true;
        });
        expect(registry.readyCount).toBe(0);
        expect(registry.peek('a')).toBeUndefined();
    });

    test('a stale release does not evict the current document', async () => {
        const registry = new DocumentRegistry<Doc>();
        const stale: Doc = { id: 'old', hydrated: true, destroyed: false };
        const current: Doc = { id: 'new', hydrated: true, destroyed: false };
        await registry.acquire('a', async () => current);

        let finalized = false;
        await registry.release('a', stale, async () => {
            finalized = true;
        });

        expect(finalized).toBe(false);
        expect(registry.peek('a')).toBe(current);
    });

    test('concurrent releases finalize once', async () => {
        const registry = new DocumentRegistry<Doc>();
        const doc: Doc = { id: 'a', hydrated: true, destroyed: false };
        await registry.acquire('a', async () => doc);

        let finalizations = 0;
        const finalize = async () => {
            finalizations += 1;
        };

        await Promise.all([
            registry.release('a', doc, finalize),
            registry.release('a', doc, finalize)
        ]);

        expect(finalizations).toBe(1);
    });
});
