export const ERASER_MIN_WIDTH = 10;
export const ERASER_MAX_WIDTH = 1000;
export const ERASER_WHEEL_STEP = 10;
export const ERASER_DEFAULT_WIDTH = 70;

export function clampEraserWidth(width: number): number {
    return Math.max(ERASER_MIN_WIDTH, Math.min(ERASER_MAX_WIDTH, Math.round(width)));
}

export function adjustEraserWidth(width: number, deltaY: number): number {
    return clampEraserWidth(width - Math.sign(deltaY) * ERASER_WHEEL_STEP);
}
