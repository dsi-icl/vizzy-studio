export type TextLayerLookupFailure =
    | 'commit_invalid'
    | 'slide_missing'
    | 'layer_missing'
    | 'layer_not_text';

export class TextLayerLookupError extends Error {
    readonly retryable: boolean;

    constructor(
        message: string,
        readonly reason: TextLayerLookupFailure
    ) {
        super(message);
        this.name = 'TextLayerLookupError';
        this.retryable = reason === 'slide_missing' || reason === 'layer_missing';
    }
}

const DEFAULT_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1_000, 1_000] as const;

type RetryOptions = {
    delaysMs?: readonly number[];
    sleep?: (delayMs: number) => Promise<void>;
    beforeRetry?: (error: TextLayerLookupError, attempt: number) => void | Promise<void>;
};

const defaultSleep = (delayMs: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
    });

/**
 * Retry only the database visibility failures that a just-created slide/layer
 * can legitimately produce. Invalid commits and numeric-ID type collisions are
 * deterministic and must fail immediately.
 */
export async function retryTextLayerLookup<Result>(
    lookup: () => Promise<Result>,
    options: RetryOptions = {}
): Promise<Result> {
    const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const sleep = options.sleep ?? defaultSleep;

    for (let attempt = 0; ; attempt += 1) {
        try {
            return await lookup();
        } catch (error) {
            if (
                !(error instanceof TextLayerLookupError) ||
                !error.retryable ||
                attempt >= delays.length
            ) {
                throw error;
            }
            await options.beforeRetry?.(error, attempt + 1);
            await sleep(delays[attempt]);
        }
    }
}
