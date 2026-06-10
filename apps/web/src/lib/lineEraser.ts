type Point = { x: number; y: number };

function toPoints(values: number[]): Point[] {
    const points: Point[] = [];
    for (let i = 0; i < values.length - 1; i += 2) {
        points.push({ x: values[i], y: values[i + 1] });
    }
    return points;
}

function fromPoints(points: Point[]): number[] {
    return points.flatMap((point) => [Math.round(point.x), Math.round(point.y)]);
}

function distance(a: Point, b: Point): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

function pointTouchesEraser(point: Point, eraserPoints: Point[], radius: number): boolean {
    return eraserPoints.some((eraserPoint) => distance(point, eraserPoint) <= radius);
}

export function eraseLineSegments(
    segments: number[][],
    eraserPath: number[],
    radius: number
): number[][] {
    const eraserPoints = toPoints(eraserPath);
    if (eraserPoints.length === 0) return segments;

    const nextSegments: number[][] = [];

    for (const segment of segments) {
        const points = toPoints(segment);
        let currentRun: Point[] = [];

        for (const point of points) {
            if (pointTouchesEraser(point, eraserPoints, radius)) {
                if (currentRun.length >= 2) {
                    nextSegments.push(fromPoints(currentRun));
                }
                currentRun = [];
            } else {
                currentRun.push(point);
            }
        }

        if (currentRun.length >= 2) {
            nextSegments.push(fromPoints(currentRun));
        }
    }

    return nextSegments;
}
