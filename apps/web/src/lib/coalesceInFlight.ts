/** Share concurrent work for a key without caching its result. */
export function coalesceInFlight<T>(load: (key: string) => Promise<T>) {
    const pending = new Map<string, Promise<T>>();
    return (key: string): Promise<T> => {
        const current = pending.get(key);
        if (current) return current;

        const promise = Promise.resolve().then(() => load(key));
        pending.set(key, promise);
        const clear = () => {
            if (pending.get(key) === promise) pending.delete(key);
        };
        void promise.then(clear, clear);
        return promise;
    };
}
