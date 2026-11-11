import assert from 'node:assert/strict';
import { test } from 'node:test';

import { percentile, serveTraceId } from './serveTiming';

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
