/**
 * Coordination primitives for scope persistence.
 *
 * Scope saves used to happen only on a 30s timer, so overlapping writes were
 * rare. Persisting immediately on layer creation makes them routine, which
 * exposes two hazards: concurrent writes for one scope interleaving, and a
 * mutation arriving mid-write being marked as saved when it was not.
 */

/** Serializes async work per key while letting unrelated keys run concurrently. */
export class KeyedSerialQueue<Key> {
    private readonly tails = new Map<Key, Promise<unknown>>();

    run<Result>(key: Key, task: () => Promise<Result>): Promise<Result> {
        const previous = this.tails.get(key) ?? Promise.resolve();
        // Swallow the predecessor's rejection so one failure cannot poison the
        // queue, while still returning this task's own result to its caller.
        const result = previous.then(
            () => task(),
            () => task()
        );
        const tail = result.then(
            () => undefined,
            () => undefined
        );
        this.tails.set(key, tail);
        void tail.then(() => {
            if (this.tails.get(key) === tail) this.tails.delete(key);
        });
        return result;
    }

    /** Number of keys with work outstanding. Exposed for assertions. */
    get pendingKeys(): number {
        return this.tails.size;
    }
}

/** The subset of a scope this module needs. */
export type DirtyTracked = {
    dirty: boolean;
    mutationRevision?: number;
};

/** Record a mutation and return the revision it produced. */
export function markScopeDirty(scope: DirtyTracked): number {
    const next = (scope.mutationRevision ?? 0) + 1;
    scope.mutationRevision = next;
    scope.dirty = true;
    return next;
}

/** Snapshot the revision being persisted, to be passed back to markScopePersisted. */
export function captureScopeRevision(scope: DirtyTracked): number {
    return scope.mutationRevision ?? 0;
}

/**
 * Clear `dirty` only if no newer mutation landed while the write was in flight.
 * Returns whether the scope was actually marked clean.
 */
export function markScopePersisted(scope: DirtyTracked, persistedRevision: number): boolean {
    if ((scope.mutationRevision ?? 0) !== persistedRevision) return false;
    scope.dirty = false;
    return true;
}
