import { getLineBounds } from '~/lib/stageGeometry';

type Point = { x: number; y: number };
type Interval = { start: number; end: number };
type BoundedSegment = {
    start: Point;
    end: Point;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
};
type SegmentBuckets = Map<string, number[]>;
type WorkBudget = { remaining: number };
type LinePathOutput = { paths: number[][]; pointCount: number };

export const LINE_PATH_MAX_POINTS = 16_384;
export const ERASER_BATCH_MAX_POINTS = 1_024;

const MIN_BUCKET_SIZE = 32;
const MAX_OUTPUT_PATHS = 512;
// A cut can add up to two boundary points to the original path data.
const MAX_OUTPUT_POINTS = LINE_PATH_MAX_POINTS + MAX_OUTPUT_PATHS * 2;
// Spatial sampling and candidate checks share one bounded workload.
const MAX_ERASER_WORK = 250_000;
const EPSILON = 1e-6;

export function appendEraserPoint(path: number[], x: number, y: number): number[] | null {
    if (path[path.length - 2] === x && path[path.length - 1] === y) return null;

    path.push(x, y);
    if (path.length / 2 < ERASER_BATCH_MAX_POINTS) return null;

    const batch = path.slice();
    path.length = 2;
    path[0] = x;
    path[1] = y;
    return batch;
}

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

function consumeWork(budget: WorkBudget): boolean {
    if (budget.remaining === 0) return false;
    budget.remaining -= 1;
    return true;
}

function createBoundedSegment(start: Point, end: Point): BoundedSegment {
    return {
        start,
        end,
        minX: Math.min(start.x, end.x),
        maxX: Math.max(start.x, end.x),
        minY: Math.min(start.y, end.y),
        maxY: Math.max(start.y, end.y)
    };
}

function getSegmentBucketKeys(
    start: Point,
    end: Point,
    bucketSize: number,
    budget: WorkBudget
): Set<string> | null {
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.max(1, Math.ceil(distance / bucketSize));
    if (!Number.isSafeInteger(steps)) return null;

    const keys = new Set<string>();
    for (let step = 0; step <= steps; step += 1) {
        if (!consumeWork(budget)) return null;
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

function buildSegmentBuckets(
    segments: BoundedSegment[],
    bucketSize: number,
    budget: WorkBudget
): SegmentBuckets | null {
    const buckets: SegmentBuckets = new Map();

    for (let index = 0; index < segments.length; index += 1) {
        const keys = getSegmentBucketKeys(
            segments[index].start,
            segments[index].end,
            bucketSize,
            budget
        );
        if (!keys) return null;

        for (const key of keys) {
            const bucket = buckets.get(key);
            if (bucket) bucket.push(index);
            else buckets.set(key, [index]);
        }
    }

    return buckets;
}

function visitNearbySegmentIndexes(
    start: Point,
    end: Point,
    bucketSize: number,
    buckets: SegmentBuckets,
    budget: WorkBudget,
    visit: (index: number) => boolean
): boolean {
    const keys = getSegmentBucketKeys(start, end, bucketSize, budget);
    if (!keys) return false;

    const visited = new Set<number>();
    for (const key of keys) {
        const bucket = buckets.get(key);
        if (!bucket) continue;
        for (const index of bucket) {
            if (!consumeWork(budget)) return false;
            if (visited.has(index)) continue;
            visited.add(index);
            if (!visit(index)) return true;
        }
    }

    return true;
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
    eraserSegment: BoundedSegment,
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

function flushRun(output: LinePathOutput, points: Point[]): boolean {
    const values = fromPoints(points);
    points.length = 0;

    if (values.length < 4) return true;

    const pointCount = values.length / 2;
    if (
        output.paths.length >= MAX_OUTPUT_PATHS ||
        output.pointCount + pointCount > MAX_OUTPUT_POINTS
    ) {
        return false;
    }

    output.paths.push(values);
    output.pointCount += pointCount;
    return true;
}

function measureLinePaths(paths: number[][]) {
    if (paths.length > MAX_OUTPUT_PATHS) return null;

    let pointCount = 0;
    for (const path of paths) {
        if (path.length % 2 !== 0) return null;
        pointCount += path.length / 2;
        if (pointCount > MAX_OUTPUT_POINTS || !path.every(Number.isFinite)) return null;
    }

    return getLineBounds(paths);
}

export function eraseLinePaths(
    paths: number[][],
    eraserPath: number[],
    effectiveRadius: number
): number[][] {
    if (!Number.isFinite(effectiveRadius) || effectiveRadius <= 0 || eraserPath.length % 2 !== 0) {
        return paths;
    }

    const eraserPointCount = eraserPath.length / 2;
    if (eraserPointCount === 0 || eraserPointCount > ERASER_BATCH_MAX_POINTS) return paths;
    if (!eraserPath.every(Number.isFinite)) return paths;

    const lineBounds = measureLinePaths(paths);
    if (!lineBounds) return paths;

    const eraserPoints = toPoints(eraserPath);
    const eraserSegments: BoundedSegment[] = [];
    if (eraserPoints.length === 1) {
        eraserSegments.push(createBoundedSegment(eraserPoints[0], eraserPoints[0]));
    } else {
        for (let i = 0; i < eraserPoints.length - 1; i += 1) {
            eraserSegments.push(createBoundedSegment(eraserPoints[i], eraserPoints[i + 1]));
        }
    }

    const nearbyEraserSegments = eraserSegments.filter(
        (segment) =>
            segment.maxX + effectiveRadius >= lineBounds.minX &&
            segment.minX - effectiveRadius <= lineBounds.maxX &&
            segment.maxY + effectiveRadius >= lineBounds.minY &&
            segment.minY - effectiveRadius <= lineBounds.maxY
    );
    if (nearbyEraserSegments.length === 0) return paths;

    const workBudget = { remaining: MAX_ERASER_WORK };
    const bucketSize = Math.max(MIN_BUCKET_SIZE, effectiveRadius);
    const buckets = buildSegmentBuckets(nearbyEraserSegments, bucketSize, workBudget);
    if (!buckets) return paths;

    const radiusSquared = effectiveRadius * effectiveRadius;
    const output: LinePathOutput = { paths: [], pointCount: 0 };
    let didErase = false;

    for (const path of paths) {
        const points = toPoints(path);
        let currentRun: Point[] = [];

        for (let i = 0; i < points.length - 1; i += 1) {
            const start = points[i];
            const end = points[i + 1];
            const edgeMinX = Math.min(start.x, end.x);
            const edgeMaxX = Math.max(start.x, end.x);
            const edgeMinY = Math.min(start.y, end.y);
            const edgeMaxY = Math.max(start.y, end.y);
            const cuts: Interval[] = [];
            const completedWithinBudget = visitNearbySegmentIndexes(
                start,
                end,
                bucketSize,
                buckets,
                workBudget,
                (index) => {
                    const eraserSegment = nearbyEraserSegments[index];
                    if (
                        edgeMaxX < eraserSegment.minX - effectiveRadius ||
                        edgeMinX > eraserSegment.maxX + effectiveRadius ||
                        edgeMaxY < eraserSegment.minY - effectiveRadius ||
                        edgeMinY > eraserSegment.maxY + effectiveRadius
                    ) {
                        return true;
                    }

                    const cut = getCapsuleCutInterval(
                        start,
                        end,
                        eraserSegment,
                        effectiveRadius,
                        radiusSquared
                    );
                    if (!cut) return true;

                    cuts.push(cut);
                    return cut.start > EPSILON || cut.end < 1 - EPSILON;
                }
            );
            if (!completedWithinBudget) return paths;

            const mergedCuts = mergeIntervals(cuts);
            if (mergedCuts.length > 0) didErase = true;

            const visibleIntervals = getVisibleIntervals(mergedCuts);
            if (visibleIntervals.length === 0) {
                if (!flushRun(output, currentRun)) return paths;
                continue;
            }

            for (const visible of visibleIntervals) {
                const visibleStart = pointAt(start, end, visible.start);
                const visibleEnd = pointAt(start, end, visible.end);
                const continuesPreviousRun = visible.start <= EPSILON && currentRun.length > 0;

                if (!continuesPreviousRun) {
                    if (!flushRun(output, currentRun)) return paths;
                    appendPoint(currentRun, visibleStart);
                }
                appendPoint(currentRun, visibleEnd);

                if (visible.end < 1 - EPSILON && !flushRun(output, currentRun)) {
                    return paths;
                }
            }
        }

        if (!flushRun(output, currentRun)) return paths;
    }

    return didErase ? output.paths : paths;
}
