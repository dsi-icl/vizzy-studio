type MaybeHeaders = Headers | Record<string, unknown> | undefined | null;

type StoredEntry = {
    timestamps: number[];
    head: number;
};

export type RateLimitScope = 'shared' | 'read' | 'image-tile';

const DEFAULT_LIMIT_PER_MINUTE = 1000;
const RATE_LIMIT_PER_MINUTE = Math.max(
    1,
    Number(process.env.RATE_LIMIT_PER_MINUTE ?? DEFAULT_LIMIT_PER_MINUTE)
);
const TRUST_FORWARDED_HEADERS = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.TRUST_FORWARDED_HEADERS ?? '').toLowerCase()
);
const WINDOW_MS = 60_000;

const store = (process as any).__RATE_LIMIT_STORE__ ?? new Map<string, StoredEntry>();
(process as any).__RATE_LIMIT_STORE__ = store;

function pickHeader(headers: MaybeHeaders, key: string): string | null {
    if (!headers) return null;

    if (headers instanceof Headers) {
        return headers.get(key);
    }

    const raw = (headers as Record<string, unknown>)[key.toLowerCase()];
    if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : null;
    return typeof raw === 'string' ? raw : null;
}

function sanitizeIp(value: string | null): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function getClientIpFromHeaders(headers: MaybeHeaders): string {
    if (!TRUST_FORWARDED_HEADERS) return 'unknown';

    const cf = sanitizeIp(pickHeader(headers, 'cf-connecting-ip'));
    if (cf) return cf;

    const realIp = sanitizeIp(pickHeader(headers, 'x-real-ip'));
    if (realIp) return realIp;

    const forwarded = pickHeader(headers, 'forwarded');
    if (forwarded) {
        const match = forwarded.match(/for="?([^;,\s"]+)"?/i);
        const parsed = sanitizeIp(match?.[1] ?? null);
        if (parsed) return parsed;
    }

    const xff = pickHeader(headers, 'x-forwarded-for');
    if (xff) {
        const parts = xff
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        const candidate = sanitizeIp(parts[parts.length - 1] ?? null);
        if (candidate) return candidate;
    }

    return 'unknown';
}

const MAX_STORE_ENTRIES = 50_000;
const PRUNE_INTERVAL_MS = 60_000;
let lastPruneTime = Date.now();

function pruneStaleEntries(now: number) {
    const cutoff = now - WINDOW_MS;
    for (const [key, entry] of store.entries()) {
        expireTimestamps(entry, cutoff);
        if (entry.head === entry.timestamps.length) {
            store.delete(key);
        }
    }
    if (store.size > MAX_STORE_ENTRIES) {
        const excess = store.size - MAX_STORE_ENTRIES;
        let count = 0;
        for (const key of store.keys()) {
            store.delete(key);
            count++;
            if (count >= excess) break;
        }
    }
}

function expireTimestamps(entry: StoredEntry, cutoff: number) {
    entry.head ??= 0;
    while (entry.head < entry.timestamps.length && entry.timestamps[entry.head]! < cutoff) {
        entry.head++;
    }
    // Keep the sliding window exact without copying its entire array per request.
    if (
        entry.head > 0 &&
        (entry.head === entry.timestamps.length ||
            (entry.head >= 1024 && entry.head * 2 >= entry.timestamps.length))
    ) {
        entry.timestamps = entry.timestamps.slice(entry.head);
        entry.head = 0;
    }
}

export function buildRateLimitSubjectKey(input: {
    actorId?: string | null;
    ip?: string | null;
    peerId?: string | null;
}): string {
    if (input.actorId) return `actor:${input.actorId}`;
    if (input.ip && input.ip !== 'unknown') return `ip:${input.ip}`;
    if (input.peerId) return `peer:${input.peerId}`;
    return 'anonymous';
}

export function checkRateLimit(input: { subjectKey: string; scope?: RateLimitScope }): {
    allowed: boolean;
    retryAfterMs: number;
    remaining: number;
    limitPerMinute: number;
} {
    const now = Date.now();
    if (now - lastPruneTime > PRUNE_INTERVAL_MS) {
        lastPruneTime = now;
        pruneStaleEntries(now);
    }

    const cutoff = now - WINDOW_MS;
    const scope = input.scope ?? 'shared';
    const key = `${scope}:${input.subjectKey}`;
    const baseLimit =
        input.subjectKey === 'anonymous' ? RATE_LIMIT_PER_MINUTE * 10 : RATE_LIMIT_PER_MINUTE;
    const limit = scope === 'image-tile' ? baseLimit * 5 : baseLimit;
    const entry = store.get(key) ?? { timestamps: [], head: 0 };

    expireTimestamps(entry, cutoff);
    if (entry.timestamps.length - entry.head >= limit) {
        const oldest = entry.timestamps[entry.head] ?? now;
        const retryAfterMs = Math.max(1_000, WINDOW_MS - (now - oldest));
        store.set(key, entry);
        return {
            allowed: false,
            retryAfterMs,
            remaining: 0,
            limitPerMinute: limit
        };
    }

    entry.timestamps.push(now);
    store.set(key, entry);

    return {
        allowed: true,
        retryAfterMs: 0,
        remaining: Math.max(0, limit - (entry.timestamps.length - entry.head)),
        limitPerMinute: limit
    };
}
