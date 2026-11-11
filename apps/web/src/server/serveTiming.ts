import { createHash } from 'node:crypto';

type ServeStage = 'bind' | 'authorize' | 'proxy-setup' | 'proxy-upstream' | 'iframe-load';
type TimingFields = Record<string, string | number | boolean | null | undefined>;

const WINDOW_SIZE = 1_024;
const MAX_SERIES = 256;
const samples = new Map<string, number[]>();
const counts = new Map<string, number>();
const EVENT_LOOP_SAMPLE_MS = 250;
const EVENT_LOOP_WARN_MS = 500;

// A slow upstream fetch can also mean the Web process did not get CPU time to
// observe a ready response. Log large scheduler gaps so those cases are visible.
if (process.env.NODE_ENV !== 'test') {
    let lastTickAt = performance.now();
    const timer = setInterval(() => {
        const now = performance.now();
        const lagMs = now - lastTickAt - EVENT_LOOP_SAMPLE_MS;
        lastTickAt = now;
        if (lagMs >= EVENT_LOOP_WARN_MS) {
            console.warn(
                '[ServeRuntime]',
                JSON.stringify({ event: 'event-loop-lag', durationMs: Math.round(lagMs) })
            );
        }
    }, EVENT_LOOP_SAMPLE_MS);
    timer.unref?.();
}

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
    const outcome =
        stage === 'proxy-upstream' && typeof fields.status === 'number'
            ? fields.status === 499
                ? 'canceled'
                : fields.status >= 500
                  ? 'failed'
                  : 'completed'
            : null;
    const projectId =
        stage === 'proxy-upstream' &&
        fields.requestKind === 'screen' &&
        typeof fields.projectId === 'string'
            ? fields.projectId
            : null;
    const series =
        stage.startsWith('proxy-') && typeof fields.requestKind === 'string'
            ? `${stage}:${fields.requestKind}${projectId ? `:${projectId}` : ''}${outcome ? `:${outcome}` : ''}`
            : stage;
    if (!samples.has(series) && samples.size >= MAX_SERIES) {
        const oldest = samples.keys().next().value;
        if (oldest) {
            samples.delete(oldest);
            counts.delete(oldest);
        }
    }
    const window = samples.get(series) ?? [];
    window.push(durationMs);
    if (window.length > WINDOW_SIZE) window.shift();
    samples.delete(series);
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
            projectId,
            outcome,
            count,
            window: sorted.length,
            p50Ms: percentile(sorted, 50),
            p95Ms: percentile(sorted, 95),
            p99Ms: percentile(sorted, 99)
        })
    );
}
