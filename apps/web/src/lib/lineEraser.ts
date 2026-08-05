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
type LineBounds = NonNullable<ReturnType<typeof getLineBounds>>;
type LineEraseLimits = {
    maxEraserPoints: number;
    maxInputPaths: number;
    maxInputPoints: number;
    maxOutputPaths: number;
    maxOutputPoints: number;
    maxWork: number;
    useSpatialIndex: boolean;
};
type PendingEraseBatch = { path: number[]; useDirectScan: boolean };
type LineEraseYield = () => Promise<void>;

export type LineEraseEngineFailureReason =
    | 'invalid_radius'
    | 'invalid_eraser_path'
    | 'eraser_batch_limit_exceeded'
    | 'invalid_line_paths'
    | 'line_path_limit_exceeded'
    | 'line_point_limit_exceeded'
    | 'work_budget_exceeded'
    | 'output_path_limit_exceeded'
    | 'output_point_limit_exceeded';

export type LineEraseTerminalFailureReason =
    | 'invalid_radius'
    | 'invalid_eraser_path'
    | 'invalid_line_paths'
    | 'processing_failed';

export type LineEraseEngineResult =
    | { status: 'changed'; paths: number[][] }
    | { status: 'unchanged'; paths: number[][] }
    | { status: 'failed'; paths: number[][]; reason: LineEraseEngineFailureReason };

export type LineEraseTerminalResult =
    | { status: 'changed'; paths: number[][] }
    | { status: 'unchanged'; paths: number[][] }
    | { status: 'failed'; paths: number[][]; reason: LineEraseTerminalFailureReason };

export const LINE_PATH_MAX_POINTS = 16_384;
export const ERASER_BATCH_MAX_POINTS = 1_024;
export const LINE_ERASE_MAX_OUTPUT_PATHS = 512;
// A cut can add up to two boundary points to the original path data.
export const LINE_ERASE_MAX_OUTPUT_POINTS = LINE_PATH_MAX_POINTS + LINE_ERASE_MAX_OUTPUT_PATHS * 2;
export const LINE_ERASE_MAX_WORK = 250_000;

const MIN_BUCKET_SIZE = 32;
const DIRECT_SCAN_MAX_SEGMENTS = 16;
const EPSILON = 1e-6;
const DEFAULT_LIMITS: LineEraseLimits = {
    maxEraserPoints: ERASER_BATCH_MAX_POINTS,
    maxInputPaths: LINE_ERASE_MAX_OUTPUT_PATHS,
    maxInputPoints: LINE_ERASE_MAX_OUTPUT_POINTS,
    maxOutputPaths: LINE_ERASE_MAX_OUTPUT_PATHS,
    maxOutputPoints: LINE_ERASE_MAX_OUTPUT_POINTS,
    maxWork: LINE_ERASE_MAX_WORK,
    useSpatialIndex: true
};
const RELAXED_STRUCTURE_LIMITS: Pick<
    LineEraseLimits,
    'maxInputPaths' | 'maxInputPoints' | 'maxOutputPaths' | 'maxOutputPoints'
> = {
    maxInputPaths: Number.POSITIVE_INFINITY,
    maxInputPoints: Number.POSITIVE_INFINITY,
    maxOutputPaths: Number.POSITIVE_INFINITY,
    maxOutputPoints: Number.POSITIVE_INFINITY
};

const FAILURE_MESSAGES: Record<LineEraseTerminalFailureReason, string> = {
    invalid_radius: 'Eraser stopped because its size was invalid. No changes were saved.',
    invalid_eraser_path:
        'Eraser stopped because the gesture data was invalid. No changes were saved.',
    invalid_line_paths:
        'Eraser stopped because this line contains invalid geometry. No changes were saved.',
    processing_failed:
        'Eraser stopped because the gesture could not be processed safely. No changes were saved.'
};

export function getLineEraseFailureMessage(reason: LineEraseTerminalFailureReason): string {
    return FAILURE_MESSAGES[reason];
}

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

function deduplicateSegments(segments: BoundedSegment[]): BoundedSegment[] {
    const uniqueSegments: BoundedSegment[] = [];
    const keys = new Set<string>();

    for (const segment of segments) {
        const forward = `${segment.start.x}:${segment.start.y}:${segment.end.x}:${segment.end.y}`;
        const reverse = `${segment.end.x}:${segment.end.y}:${segment.start.x}:${segment.start.y}`;
        const key = forward < reverse ? forward : reverse;
        if (keys.has(key)) continue;
        keys.add(key);
        uniqueSegments.push(segment);
    }

    return uniqueSegments;
}

function countUniquePathSegments(path: number[]): number {
    const keys = new Set<string>();
    if (path.length === 2) return 1;

    for (let index = 0; index < path.length - 2; index += 2) {
        const forward = `${path[index]}:${path[index + 1]}:${path[index + 2]}:${path[index + 3]}`;
        const reverse = `${path[index + 2]}:${path[index + 3]}:${path[index]}:${path[index + 1]}`;
        keys.add(forward < reverse ? forward : reverse);
        if (keys.size > DIRECT_SCAN_MAX_SEGMENTS) return keys.size;
    }
    return keys.size;
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

function flushRun(
    output: LinePathOutput,
    points: Point[],
    limits: LineEraseLimits
): 'output_path_limit_exceeded' | 'output_point_limit_exceeded' | null {
    const values = fromPoints(points);
    points.length = 0;

    if (values.length < 4) return null;

    const pointCount = values.length / 2;
    if (output.paths.length >= limits.maxOutputPaths) {
        return 'output_path_limit_exceeded';
    }
    if (output.pointCount + pointCount > limits.maxOutputPoints) {
        return 'output_point_limit_exceeded';
    }

    output.paths.push(values);
    output.pointCount += pointCount;
    return null;
}

function measureLinePaths(
    paths: number[][],
    limits: LineEraseLimits
): { ok: true; bounds: LineBounds } | { ok: false; reason: LineEraseEngineFailureReason } {
    if (paths.length > limits.maxInputPaths) {
        return { ok: false, reason: 'line_path_limit_exceeded' };
    }

    let pointCount = 0;
    for (const path of paths) {
        if (path.length % 2 !== 0 || !path.every(Number.isFinite)) {
            return { ok: false, reason: 'invalid_line_paths' };
        }
        pointCount += path.length / 2;
        if (pointCount > limits.maxInputPoints) {
            return { ok: false, reason: 'line_point_limit_exceeded' };
        }
    }

    const bounds = getLineBounds(paths);
    return bounds ? { ok: true, bounds } : { ok: false, reason: 'invalid_line_paths' };
}

function failed(paths: number[][], reason: LineEraseEngineFailureReason): LineEraseEngineResult {
    return { status: 'failed', paths, reason };
}

function terminalFailed(
    paths: number[][],
    reason: LineEraseEngineFailureReason
): LineEraseTerminalResult {
    if (
        reason === 'invalid_radius' ||
        reason === 'invalid_eraser_path' ||
        reason === 'invalid_line_paths'
    ) {
        return { status: 'failed', paths, reason };
    }
    return { status: 'failed', paths, reason: 'processing_failed' };
}

function eraseLinePathsWithLimits(
    paths: number[][],
    eraserPath: number[],
    effectiveRadius: number,
    limits: LineEraseLimits
): LineEraseEngineResult {
    if (!Number.isFinite(effectiveRadius) || effectiveRadius <= 0) {
        return failed(paths, 'invalid_radius');
    }
    if (
        eraserPath.length === 0 ||
        eraserPath.length % 2 !== 0 ||
        !eraserPath.every(Number.isFinite)
    ) {
        return failed(paths, 'invalid_eraser_path');
    }

    const eraserPointCount = eraserPath.length / 2;
    if (eraserPointCount > limits.maxEraserPoints) {
        return failed(paths, 'eraser_batch_limit_exceeded');
    }
    // A prior batch may already have erased the entire layer. Later batches are valid no-ops.
    if (paths.length === 0) return { status: 'unchanged', paths };

    const measurement = measureLinePaths(paths, limits);
    if (!measurement.ok) return failed(paths, measurement.reason);
    const lineBounds = measurement.bounds;

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
    if (nearbyEraserSegments.length === 0) return { status: 'unchanged', paths };
    const scanEraserSegments = limits.useSpatialIndex
        ? nearbyEraserSegments
        : deduplicateSegments(nearbyEraserSegments);

    // Spatial sampling and candidate checks share one bounded workload.
    const workBudget = { remaining: limits.maxWork };
    const bucketSize = Math.max(MIN_BUCKET_SIZE, effectiveRadius);
    const buckets = limits.useSpatialIndex
        ? buildSegmentBuckets(scanEraserSegments, bucketSize, workBudget)
        : null;
    if (limits.useSpatialIndex && !buckets) return failed(paths, 'work_budget_exceeded');

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
            const visitEraserSegment = (index: number) => {
                const eraserSegment = scanEraserSegments[index];
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
            };
            let completedWithinBudget = true;

            if (limits.useSpatialIndex && buckets) {
                completedWithinBudget = visitNearbySegmentIndexes(
                    start,
                    end,
                    bucketSize,
                    buckets,
                    workBudget,
                    visitEraserSegment
                );
            } else {
                for (let index = 0; index < scanEraserSegments.length; index += 1) {
                    if (!consumeWork(workBudget)) {
                        completedWithinBudget = false;
                        break;
                    }
                    if (!visitEraserSegment(index)) break;
                }
            }
            if (!completedWithinBudget) return failed(paths, 'work_budget_exceeded');

            const mergedCuts = mergeIntervals(cuts);
            if (mergedCuts.length > 0) didErase = true;

            const visibleIntervals = getVisibleIntervals(mergedCuts);
            if (visibleIntervals.length === 0) {
                const failureReason = flushRun(output, currentRun, limits);
                if (failureReason) return failed(paths, failureReason);
                continue;
            }

            for (const visible of visibleIntervals) {
                const visibleStart = pointAt(start, end, visible.start);
                const visibleEnd = pointAt(start, end, visible.end);
                const continuesPreviousRun = visible.start <= EPSILON && currentRun.length > 0;

                if (!continuesPreviousRun) {
                    const failureReason = flushRun(output, currentRun, limits);
                    if (failureReason) return failed(paths, failureReason);
                    appendPoint(currentRun, visibleStart);
                }
                appendPoint(currentRun, visibleEnd);

                if (visible.end < 1 - EPSILON) {
                    const failureReason = flushRun(output, currentRun, limits);
                    if (failureReason) return failed(paths, failureReason);
                }
            }
        }

        const failureReason = flushRun(output, currentRun, limits);
        if (failureReason) return failed(paths, failureReason);
    }

    return didErase ? { status: 'changed', paths: output.paths } : { status: 'unchanged', paths };
}

export function eraseLinePathsWithinBudget(
    paths: number[][],
    eraserPath: number[],
    effectiveRadius: number
): LineEraseEngineResult {
    return eraseLinePathsWithLimits(paths, eraserPath, effectiveRadius, DEFAULT_LIMITS);
}

function splitEraserBatch(path: number[]): [number[], number[]] | null {
    const pointCount = path.length / 2;
    if (!Number.isInteger(pointCount) || pointCount < 3) return null;

    const middlePointIndex = Math.floor((pointCount - 1) / 2);
    return [path.slice(0, (middlePointIndex + 1) * 2), path.slice(middlePointIndex * 2)];
}

function yieldLineEraseWork(): Promise<void> {
    if (typeof requestAnimationFrame === 'function') {
        return new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    return Promise.resolve();
}

function appendContinuedChunk(output: number[][], chunkPaths: number[][]): void {
    if (chunkPaths.length === 0) return;
    const previous = output.at(-1);
    const first = chunkPaths[0];
    if (previous && previous.at(-2) === first[0] && previous.at(-1) === first[1]) {
        previous.push(...first.slice(2));
        output.push(...chunkPaths.slice(1));
        return;
    }
    output.push(...chunkPaths);
}

async function eraseLinePathsDirectlyInChunks(
    paths: number[][],
    eraserPath: number[],
    effectiveRadius: number,
    yieldControl: LineEraseYield
): Promise<LineEraseEngineResult> {
    const uniqueSegmentCount = Math.max(1, countUniquePathSegments(eraserPath));
    const maxLineSegmentsPerChunk = Math.max(
        1,
        Math.floor(LINE_ERASE_MAX_WORK / uniqueSegmentCount)
    );
    const totalLineSegments = paths.reduce(
        (total, path) => total + Math.max(0, path.length / 2 - 1),
        0
    );
    if (totalLineSegments <= maxLineSegmentsPerChunk) {
        return eraseLinePathsWithLimits(paths, eraserPath, effectiveRadius, {
            ...DEFAULT_LIMITS,
            ...RELAXED_STRUCTURE_LIMITS,
            maxWork: LINE_ERASE_MAX_WORK,
            useSpatialIndex: false
        });
    }

    const output: number[][] = [];
    let estimatedWorkSinceYield = 0;
    let didChange = false;

    for (const path of paths) {
        const pathOutput: number[][] = [];
        const pointCount = path.length / 2;
        if (pointCount < 2) continue;

        for (
            let startPointIndex = 0;
            startPointIndex < pointCount - 1;
            startPointIndex += maxLineSegmentsPerChunk
        ) {
            const endPointIndex = Math.min(
                pointCount - 1,
                startPointIndex + maxLineSegmentsPerChunk
            );
            const chunk = path.slice(startPointIndex * 2, (endPointIndex + 1) * 2);
            const estimatedWork = (endPointIndex - startPointIndex) * uniqueSegmentCount;
            if (
                estimatedWorkSinceYield > 0 &&
                estimatedWorkSinceYield + estimatedWork > LINE_ERASE_MAX_WORK
            ) {
                await yieldControl();
                estimatedWorkSinceYield = 0;
            }

            const result = eraseLinePathsWithLimits([chunk], eraserPath, effectiveRadius, {
                ...DEFAULT_LIMITS,
                ...RELAXED_STRUCTURE_LIMITS,
                maxWork: LINE_ERASE_MAX_WORK,
                useSpatialIndex: false
            });
            if (result.status === 'failed') return failed(paths, result.reason);
            if (result.status === 'changed') didChange = true;
            appendContinuedChunk(pathOutput, result.paths);
            estimatedWorkSinceYield += estimatedWork;
        }
        output.push(...pathOutput);
    }

    return didChange ? { status: 'changed', paths: output } : { status: 'unchanged', paths };
}

function isStructureLimitFailure(reason: LineEraseEngineFailureReason): boolean {
    return (
        reason === 'line_path_limit_exceeded' ||
        reason === 'line_point_limit_exceeded' ||
        reason === 'output_path_limit_exceeded' ||
        reason === 'output_point_limit_exceeded'
    );
}

/**
 * Completes valid user gestures without dropping input. Work-heavy batches are divided until each
 * spatial job fits the budget or contains at most a small, fixed number of unique segments for an
 * exact direct scan. Pending jobs yield to the browser between chunks so long-lived fragmented lines
 * cannot monopolise the main thread.
 */
export async function eraseLinePathsResiliently(
    paths: number[][],
    eraserPath: number[],
    effectiveRadius: number,
    yieldControl: LineEraseYield = yieldLineEraseWork
): Promise<LineEraseTerminalResult> {
    const pending: PendingEraseBatch[] = [{ path: eraserPath, useDirectScan: false }];
    let currentPaths = paths;
    let didChange = false;
    let relaxedStructureLimits = false;

    while (pending.length > 0) {
        const batch = pending.shift();
        if (!batch) break;

        const result = batch.useDirectScan
            ? await eraseLinePathsDirectlyInChunks(
                  currentPaths,
                  batch.path,
                  effectiveRadius,
                  yieldControl
              )
            : eraseLinePathsWithLimits(currentPaths, batch.path, effectiveRadius, {
                  ...DEFAULT_LIMITS,
                  ...(relaxedStructureLimits ? RELAXED_STRUCTURE_LIMITS : {})
              });

        if (result.status === 'changed') {
            currentPaths = result.paths;
            didChange = true;
            if (pending.length > 0) await yieldControl();
            continue;
        }
        if (result.status === 'unchanged') {
            if (pending.length > 0) await yieldControl();
            continue;
        }

        if (isStructureLimitFailure(result.reason)) {
            if (relaxedStructureLimits) return terminalFailed(paths, result.reason);
            relaxedStructureLimits = true;
            pending.unshift(batch);
            await yieldControl();
            continue;
        }

        if (result.reason === 'eraser_batch_limit_exceeded') {
            const split = splitEraserBatch(batch.path);
            if (split) {
                pending.unshift(
                    { path: split[0], useDirectScan: false },
                    { path: split[1], useDirectScan: false }
                );
                await yieldControl();
                continue;
            }
        }

        if (result.reason === 'work_budget_exceeded') {
            if (!batch.useDirectScan) {
                const split = splitEraserBatch(batch.path);
                if (split && countUniquePathSegments(batch.path) > DIRECT_SCAN_MAX_SEGMENTS) {
                    pending.unshift(
                        { path: split[0], useDirectScan: false },
                        { path: split[1], useDirectScan: false }
                    );
                } else {
                    pending.unshift({ ...batch, useDirectScan: true });
                }
                await yieldControl();
                continue;
            }
        }

        return terminalFailed(paths, result.reason);
    }

    return didChange ? { status: 'changed', paths: currentPaths } : { status: 'unchanged', paths };
}
