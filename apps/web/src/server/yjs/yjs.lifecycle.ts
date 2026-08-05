/**
 * Coordinates the three mutually-exclusive document states. In particular,
 * partially hydrated and closing documents are never observable as ready.
 */
export class ReadyDocumentRegistry<T> {
    readonly ready = new Map<string, T>();
    readonly initializing = new Map<string, Promise<T>>();
    readonly closing = new Map<string, Promise<void>>();

    async getOrCreate(name: string, create: () => Promise<T>): Promise<T> {
        const closing = this.closing.get(name);
        if (closing) await closing;

        const ready = this.ready.get(name);
        if (ready) return ready;

        let pending = this.initializing.get(name);
        if (!pending) {
            pending = (async () => {
                const value = await create();
                this.ready.set(name, value);
                return value;
            })();
            this.initializing.set(name, pending);
        }

        try {
            return await pending;
        } finally {
            if (this.initializing.get(name) === pending) this.initializing.delete(name);
        }
    }

    async close(name: string, value: T, finalize: () => Promise<void>): Promise<void> {
        const existing = this.closing.get(name);
        if (existing) {
            await existing;
            return;
        }

        if (this.ready.get(name) === value) this.ready.delete(name);
        const closing = Promise.resolve().then(finalize);
        this.closing.set(name, closing);
        try {
            await closing;
        } finally {
            if (this.closing.get(name) === closing) this.closing.delete(name);
        }
    }
}
