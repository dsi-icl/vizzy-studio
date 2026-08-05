/** Serializes async work per key while allowing unrelated keys to run concurrently. */
export class KeyedSerialTaskQueue<Key> {
    private tails = new Map<Key, Promise<void>>();

    run<Result>(key: Key, task: () => Promise<Result>): Promise<Result> {
        const previous = this.tails.get(key) ?? Promise.resolve();
        const result = previous.catch(() => undefined).then(task);
        const tail = result.then(
            () => undefined,
            () => undefined
        );
        this.tails.set(key, tail);
        void tail.finally(() => {
            if (this.tails.get(key) === tail) this.tails.delete(key);
        });
        return result;
    }
}
