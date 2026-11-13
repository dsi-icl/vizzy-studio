import assert from 'node:assert/strict';
import { test } from 'node:test';

import { percentile, recordServeTiming, serveTraceId } from './serveTiming';

test('correlates the same binding without exposing its identifier', () => {
    const bindingId = 'AAAAAAAAAAAAAAAAAAAAAA';
    const traceId = serveTraceId(bindingId);
    assert.match(traceId, /^[0-9a-f]{16}$/);
    assert.equal(serveTraceId(bindingId), traceId);
    assert.notEqual(serveTraceId('BBBBBBBBBBBBBBBBBBBBBB'), traceId);
});

test('reports nearest-rank p50, p95 and p99 from a sorted timing window', () => {
    const timings = Array.from({ length: 100 }, (_, index) => index + 1);
    assert.equal(percentile(timings, 50), 50);
    assert.equal(percentile(timings, 95), 95);
    assert.equal(percentile(timings, 99), 99);
});

test('keeps canceled proxy requests out of completed latency percentiles', () => {
    const summaries: Array<{ outcome: string; p95Ms: number }> = [];
    const originalInfo = console.info;
    console.info = (label: string, payload: string) => {
        if (label === '[ServeTimingSummary]') {
            const { outcome, p95Ms } = JSON.parse(payload);
            summaries.push({ outcome, p95Ms });
        }
    };
    try {
        for (let index = 0; index < 64; index++) {
            recordServeTiming(
                'proxy-upstream',
                100,
                { requestKind: 'screen-outcome-test', status: 200 },
                false
            );
            recordServeTiming(
                'proxy-upstream',
                10_000,
                { requestKind: 'screen-outcome-test', status: 499 },
                false
            );
        }
    } finally {
        console.info = originalInfo;
    }
    assert.deepEqual(summaries, [
        { outcome: 'completed', p95Ms: 100 },
        { outcome: 'canceled', p95Ms: 10_000 }
    ]);
});

test('keeps screen latency percentiles separate for each demo project', () => {
    const summaries: Array<{ projectId: string; p95Ms: number }> = [];
    const originalInfo = console.info;
    console.info = (label: string, payload: string) => {
        if (label === '[ServeTimingSummary]') {
            const { projectId, p95Ms } = JSON.parse(payload);
            summaries.push({ projectId, p95Ms });
        }
    };
    try {
        for (let index = 0; index < 64; index++) {
            recordServeTiming(
                'proxy-upstream',
                100,
                { requestKind: 'screen', projectId: 'fast-demo-test', status: 200 },
                false
            );
            recordServeTiming(
                'proxy-upstream',
                8_000,
                { requestKind: 'screen', projectId: 'slow-demo-test', status: 200 },
                false
            );
        }
    } finally {
        console.info = originalInfo;
    }
    assert.deepEqual(summaries, [
        { projectId: 'fast-demo-test', p95Ms: 100 },
        { projectId: 'slow-demo-test', p95Ms: 8_000 }
    ]);
});
