/** Spread a wall's demo launches so the controller can load during a bind. */
export function serveWallLaunchDelayMs(
    col: number,
    row: number,
    columns: number,
    rows: number
): number {
    if (
        !Number.isInteger(col) ||
        !Number.isInteger(row) ||
        !Number.isInteger(columns) ||
        !Number.isInteger(rows) ||
        columns < 1 ||
        rows < 1 ||
        col < 0 ||
        row < 0 ||
        col >= columns ||
        row >= rows
    ) {
        return 0;
    }
    const tileIndex = row * columns + col;
    return Math.floor(tileIndex / 8) * 300;
}
