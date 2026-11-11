import { createHash } from 'node:crypto';

type ServeStage = 'bind' | 'authorize' | 'proxy-setup' | 'proxy-upstream' | 'iframe-load';
type TimingFields = Record<string, string | number | boolean | null | undefined>;

const WINDOW_SIZE = 1_024;
const samples = new Map<string, number[]>();
const counts = new Map<string, number>();

/** A binding has one correlation ID across its wall peers, launch and proxy requests. */
export function serveTraceId(bindingId: string): string {
    return createHash('sha256').update(bindingId).digest('hex').slice(0, 16);
}

export function percentile(sorted: number[], percentileValue: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.min(
        sorted.length - 1,
        Math.ceil((percentileValue / 100) * sorted.length) - 1
    );
    return sorted[Math.max(0, index)]!;
}

/** Emit one-line samples and rolling percentiles without logging URLs or credentials. */
export function recordServeTiming(
    stage: ServeStage,
    elapsedMs: number,
    fields: TimingFields,
    logSample = true
): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    const durationMs = Math.round(elapsedMs);
    const series =
        stage.startsWith('proxy-') && typeof fields.requestKind === 'string'
            ? `${stage}:${fields.requestKind}`
            : stage;
    const window = samples.get(series) ?? [];
    window.push(durationMs);
    if (window.length > WINDOW_SIZE) window.shift();
    samples.set(series, window);
    const count = (counts.get(series) ?? 0) + 1;
    counts.set(series, count);

    if (logSample) console.info('[ServeTiming]', JSON.stringify({ stage, durationMs, ...fields }));
    if (stage !== 'bind' && count % 64 !== 0) return;

    const sorted = [...window].sort((a, b) => a - b);
    console.info(
        '[ServeTimingSummary]',
        JSON.stringify({
            stage,
            requestKind: fields.requestKind ?? null,
            count,
            window: sorted.length,
            p50Ms: percentile(sorted, 50),
            p95Ms: percentile(sorted, 95),
            p99Ms: percentile(sorted, 99)
        })
    );
}
