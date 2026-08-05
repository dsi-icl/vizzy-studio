import { describe, expect, test } from 'bun:test';

import { KeyedSerialTaskQueue } from '../../src/lib/keyedSerialTaskQueue';
import {
    captureScopeMutation,
    markScopeDirty,
    markScopePersisted
} from '../../src/lib/scopeDirtyState';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
        resolve = next;
    });
    return { promise, resolve };
}

describe('layer persistence coordination', () => {
    test('serializes writes across slides in one commit while another commit proceeds', async () => {
        const queue = new KeyedSerialTaskQueue<string>();
        const firstGate = deferred<void>();
        const events: string[] = [];

        const first = queue.run('commit-a', async () => {
            events.push('first:start');
            await firstGate.promise;
            events.push('first:end');
        });
        const second = queue.run('commit-a', async () => {
            events.push('second');
        });
        const independent = queue.run('commit-b', async () => {
            events.push('independent');
        });

        await independent;
        expect(events).toEqual(['first:start', 'independent']);

        firstGate.resolve();
        await Promise.all([first, second]);
        expect(events).toEqual(['first:start', 'independent', 'first:end', 'second']);
    });

    test('continues a scope queue after an earlier write rejects', async () => {
        const queue = new KeyedSerialTaskQueue<string>();
        const failed = queue.run('scope', async () => {
            throw new Error('database unavailable');
        });
        const recovered = queue.run('scope', async () => 'saved');

        expect(failed).rejects.toThrow('database unavailable');
        expect(await recovered).toBe('saved');
    });

    test('does not mark a scope clean when a mutation arrives during persistence', () => {
        const scope = { dirty: true, mutationRevision: 4 };
        const persistedRevision = captureScopeMutation(scope);

        markScopeDirty(scope);

        expect(markScopePersisted(scope, persistedRevision)).toBe(false);
        expect(scope).toEqual({ dirty: true, mutationRevision: 5 });

        expect(markScopePersisted(scope, captureScopeMutation(scope))).toBe(true);
        expect(scope.dirty).toBe(false);
    });
});
