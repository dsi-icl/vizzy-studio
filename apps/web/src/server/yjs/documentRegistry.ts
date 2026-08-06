/**
 * Coordinates the three mutually exclusive states a shared document can be in.
 *
 * Publishing a document before it finishes hydrating lets a second peer pick up
 * an empty one, and tearing a document down while a reconnect resolves hands
 * back an object that is about to be destroyed. Both are avoided by making
 * "ready" the only observable state, and by holding new arrivals behind an
 * in-flight close.
 *
 * Kept free of Yjs and Lexical imports so it stays unit-testable.
 */
export class DocumentRegistry<T> {
    private readonly ready = new Map<string, T>();
    private readonly initializing = new Map<string, Promise<T>>();
    private readonly closing = new Map<string, Promise<void>>();

    /** Fully hydrated documents only. */
    get readyCount(): number {
        return this.ready.size;
    }

    /** Non-blocking lookup. Never returns a partially built document. */
    peek(name: string): T | undefined {
        return this.ready.get(name);
    }

    /**
     * Return the ready document, join an in-flight build, or start one. A build
     * that throws is not cached, so the next caller retries cleanly.
     */
    async acquire(name: string, create: () => Promise<T>): Promise<T> {
        // Let a teardown finish first: a reconnect must never resolve onto a
        // document that is being destroyed.
        const closing = this.closing.get(name);
        if (closing) await closing;

        const ready = this.ready.get(name);
        if (ready) return ready;

        const pending = this.initializing.get(name);
        if (pending) return pending;

        const building = create().then((value) => {
            this.ready.set(name, value);
            return value;
        });
        this.initializing.set(name, building);

        const forget = () => {
            if (this.initializing.get(name) === building) this.initializing.delete(name);
        };
        void building.then(forget, forget);

        return building;
    }

    /**
     * Retire a document, running `finalize` while new arrivals are held back.
     * A no-op if this document is no longer the registered one.
     */
    async release(name: string, value: T, finalize: () => Promise<void>): Promise<void> {
        const existing = this.closing.get(name);
        if (existing) return existing;
        if (this.ready.get(name) !== value) return;

        this.ready.delete(name);
        const closing = Promise.resolve().then(finalize);
        this.closing.set(name, closing);
        try {
            await closing;
        } finally {
            if (this.closing.get(name) === closing) this.closing.delete(name);
        }
    }
}
