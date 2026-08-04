type Point = { x: number; y: number };
type Interval = { start: number; end: number };
type Segment = { start: Point; end: Point };
type SegmentBuckets = Map<string, number[]>;

export const LINE_PATH_MAX_POINTS = 16_384;

const MIN_BUCKET_SIZE = 32;
const MAX_OUTPUT_PATHS = 512;
const MAX_OUTPUT_POINTS = LINE_PATH_MAX_POINTS + MAX_OUTPUT_PATHS * 2;
const MAX_BUCKET_STEPS_PER_SEGMENT = 4_096;
const MAX_BUCKET_REFERENCES = 1_000_000;
const MAX_INTERSECTION_CHECKS = 100_000;
const EPSILON = 1e-6;

function toPoints(values: number[]): Point[] {
    const points: Point[] = [];
    for (let i = 0; i < values.length; i += 2) {
        points.push({ x: values[i], y: values[i + 1] });
    }
    return points;
}

function fromPoints(points: Point[]): number[] {
    const values: number[] = [];

    for (const point of points) {
        const x = Math.round(point.x);
        const y = Math.round(point.y);
        if (values[values.length - 2] === x && values[values.length - 1] === y) continue;
        values.push(x, y);
    }

    return values;
}

function bucketKey(x: number, y: number): string {
    return `${x}:${y}`;
}

function getSegmentBucketKeys(start: Point, end: Point, bucketSize: number): Set<string> | null {
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.max(1, Math.ceil(distance / bucketSize));
    if (!Number.isSafeInteger(steps) || steps > MAX_BUCKET_STEPS_PER_SEGMENT) return null;

    const keys = new Set<string>();
    for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        const bucketX = Math.floor((start.x + (end.x - start.x) * t) / bucketSize);
        const bucketY = Math.floor((start.y + (end.y - start.y) * t) / bucketSize);
        for (let x = bucketX - 1; x <= bucketX + 1; x += 1) {
            for (let y = bucketY - 1; y <= bucketY + 1; y += 1) {
                keys.add(bucketKey(x, y));
            }
        }
    }

    return keys;
}

function buildSegmentBuckets(segments: Segment[], bucketSize: number): SegmentBuckets | null {
    const buckets: SegmentBuckets = new Map();
    let referenceCount = 0;

    for (let index = 0; index < segments.length; index += 1) {
        const keys = getSegmentBucketKeys(segments[index].start, segments[index].end, bucketSize);
        if (!keys) return null;

        for (const key of keys) {
            const bucket = buckets.get(key);
            if (bucket) bucket.push(index);
            else buckets.set(key, [index]);
            referenceCount += 1;
            if (referenceCount > MAX_BUCKET_REFERENCES) return null;
        }
    }

    return buckets;
}

function getNearbySegmentIndexes(
    start: Point,
    end: Point,
    bucketSize: number,
    buckets: SegmentBuckets
): Set<number> | null {
    const keys = getSegmentBucketKeys(start, end, bucketSize);
    if (!keys) return null;

    const indexes = new Set<number>();
    for (const key of keys) {
        const bucket = buckets.get(key);
        if (!bucket) continue;
        for (const index of bucket) indexes.add(index);
    }

    return indexes;
}

function getCircleCutInterval(
    start: Point,
    end: Point,
    centre: Point,
    radiusSquared: number
): Interval | null {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return null;

    const projection = ((centre.x - start.x) * dx + (centre.y - start.y) * dy) / lengthSquared;
    const closestX = start.x + projection * dx;
    const closestY = start.y + projection * dy;
    const closestDx = closestX - centre.x;
    const closestDy = closestY - centre.y;
    const distanceSquared = closestDx * closestDx + closestDy * closestDy;
    if (distanceSquared >= radiusSquared) return null;

    const offset = Math.sqrt((radiusSquared - distanceSquared) / lengthSquared);
    const cutStart = Math.max(0, projection - offset);
    const cutEnd = Math.min(1, projection + offset);

    return cutEnd - cutStart > EPSILON ? { start: cutStart, end: cutEnd } : null;
}

function restrictInterval(
    interval: Interval,
    valueAtStart: number,
    delta: number,
    min: number,
    max: number
): Interval | null {
    if (Math.abs(delta) <= EPSILON) {
        return valueAtStart >= min && valueAtStart <= max ? interval : null;
    }

    const first = (min - valueAtStart) / delta;
    const second = (max - valueAtStart) / delta;
    const start = Math.max(interval.start, Math.min(first, second));
    const end = Math.min(interval.end, Math.max(first, second));
    return end - start > EPSILON ? { start, end } : null;
}

function getCapsuleCutInterval(
    lineStart: Point,
    lineEnd: Point,
    eraserSegment: Segment,
    radius: number,
    radiusSquared: number
): Interval | null {
    const eraserDx = eraserSegment.end.x - eraserSegment.start.x;
    const eraserDy = eraserSegment.end.y - eraserSegment.start.y;
    const eraserLength = Math.hypot(eraserDx, eraserDy);
    if (eraserLength <= EPSILON) {
        return getCircleCutInterval(lineStart, lineEnd, eraserSegment.start, radiusSquared);
    }

    const lineDx = lineEnd.x - lineStart.x;
    const lineDy = lineEnd.y - lineStart.y;
    const unitX = eraserDx / eraserLength;
    const unitY = eraserDy / eraserLength;
    const normalX = -unitY;
    const normalY = unitX;
    const relativeX = lineStart.x - eraserSegment.start.x;
    const relativeY = lineStart.y - eraserSegment.start.y;

    let body: Interval | null = { start: 0, end: 1 };
    body = restrictInterval(
        body,
        relativeX * unitX + relativeY * unitY,
        lineDx * unitX + lineDy * unitY,
        0,
        eraserLength
    );
    if (body) {
        body = restrictInterval(
            body,
            relativeX * normalX + relativeY * normalY,
            lineDx * normalX + lineDy * normalY,
            -radius,
            radius
        );
    }

    const intervals = [
        body,
        getCircleCutInterval(lineStart, lineEnd, eraserSegment.start, radiusSquared),
        getCircleCutInterval(lineStart, lineEnd, eraserSegment.end, radiusSquared)
    ].filter((interval): interval is Interval => interval !== null);

    return mergeIntervals(intervals)[0] ?? null;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
    if (intervals.length < 2) return intervals;

    intervals.sort((a, b) => a.start - b.start);
    const merged: Interval[] = [{ ...intervals[0] }];

    for (let i = 1; i < intervals.length; i += 1) {
        const current = intervals[i];
        const previous = merged[merged.length - 1];
        if (current.start <= previous.end + EPSILON) {
            previous.end = Math.max(previous.end, current.end);
        } else {
            merged.push({ ...current });
        }
    }

    return merged;
}

function getVisibleIntervals(cuts: Interval[]): Interval[] {
    if (cuts.length === 0) return [{ start: 0, end: 1 }];

    const visible: Interval[] = [];
    let cursor = 0;

    for (const cut of cuts) {
        if (cut.start > cursor + EPSILON) visible.push({ start: cursor, end: cut.start });
        cursor = Math.max(cursor, cut.end);
        if (cursor >= 1 - EPSILON) return visible;
    }

    if (cursor < 1 - EPSILON) visible.push({ start: cursor, end: 1 });
    return visible;
}

function pointAt(start: Point, end: Point, t: number): Point {
    return {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t
    };
}

function appendPoint(points: Point[], point: Point): void {
    const previous = points[points.length - 1];
    if (
        previous &&
        Math.abs(previous.x - point.x) <= EPSILON &&
        Math.abs(previous.y - point.y) <= EPSILON
    ) {
        return;
    }
    points.push(point);
}

function flushRun(runs: number[][], points: Point[], outputPointCount: { value: number }): boolean {
    const values = fromPoints(points);
    points.length = 0;

    if (values.length < 4) return true;

    const pointCount = values.length / 2;
    if (
        runs.length >= MAX_OUTPUT_PATHS ||
        outputPointCount.value + pointCount > MAX_OUTPUT_POINTS
    ) {
        return false;
    }

    runs.push(values);
    outputPointCount.value += pointCount;
    return true;
}

export function eraseLineSegments(
    segments: number[][],
    eraserPath: number[],
    radius: number
): number[][] {
    if (!Number.isFinite(radius) || radius <= 0 || eraserPath.length % 2 !== 0) {
        return segments;
    }

    const eraserPointCount = eraserPath.length / 2;
    if (eraserPointCount === 0 || eraserPointCount > LINE_PATH_MAX_POINTS) return segments;
    if (!eraserPath.every(Number.isFinite)) return segments;

    if (segments.length > MAX_OUTPUT_PATHS) return segments;

    let linePointCount = 0;
    for (const segment of segments) {
        if (segment.length % 2 !== 0) return segments;
        linePointCount += segment.length / 2;
        if (linePointCount > MAX_OUTPUT_POINTS) return segments;
        if (!segment.every(Number.isFinite)) return segments;
    }

    const eraserPoints = toPoints(eraserPath);
    const eraserSegments: Segment[] = [];
    if (eraserPoints.length === 1) {
        eraserSegments.push({ start: eraserPoints[0], end: eraserPoints[0] });
    } else {
        for (let i = 0; i < eraserPoints.length - 1; i += 1) {
            eraserSegments.push({ start: eraserPoints[i], end: eraserPoints[i + 1] });
        }
    }

    const bucketSize = Math.max(MIN_BUCKET_SIZE, radius);
    const buckets = buildSegmentBuckets(eraserSegments, bucketSize);
    if (!buckets) return segments;

    const radiusSquared = radius * radius;
    const nextSegments: number[][] = [];
    const outputPointCount = { value: 0 };
    let intersectionChecks = 0;
    let didErase = false;

    for (const segment of segments) {
        const points = toPoints(segment);
        let currentRun: Point[] = [];

        for (let i = 0; i < points.length - 1; i += 1) {
            const start = points[i];
            const end = points[i + 1];
            const nearbySegmentIndexes = getNearbySegmentIndexes(start, end, bucketSize, buckets);
            if (!nearbySegmentIndexes) return segments;

            const cuts: Interval[] = [];
            for (const index of nearbySegmentIndexes) {
                intersectionChecks += 1;
                if (intersectionChecks > MAX_INTERSECTION_CHECKS) return segments;

                const cut = getCapsuleCutInterval(
                    start,
                    end,
                    eraserSegments[index],
                    radius,
                    radiusSquared
                );
                if (cut) cuts.push(cut);
            }

            const mergedCuts = mergeIntervals(cuts);
            if (mergedCuts.length > 0) didErase = true;

            const visibleIntervals = getVisibleIntervals(mergedCuts);
            if (visibleIntervals.length === 0) {
                if (!flushRun(nextSegments, currentRun, outputPointCount)) return segments;
                continue;
            }

            for (const visible of visibleIntervals) {
                const visibleStart = pointAt(start, end, visible.start);
                const visibleEnd = pointAt(start, end, visible.end);
                const continuesPreviousRun = visible.start <= EPSILON && currentRun.length > 0;

                if (!continuesPreviousRun) {
                    if (!flushRun(nextSegments, currentRun, outputPointCount)) return segments;
                    appendPoint(currentRun, visibleStart);
                }
                appendPoint(currentRun, visibleEnd);

                if (
                    visible.end < 1 - EPSILON &&
                    !flushRun(nextSegments, currentRun, outputPointCount)
                ) {
                    return segments;
                }
            }
        }

        if (!flushRun(nextSegments, currentRun, outputPointCount)) return segments;
    }

    return didErase ? nextSegments : segments;
}
