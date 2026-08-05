'use client';

import type { StageLayout } from '@repo/db/schema';

/** Physical screen resolution for a single wall panel. */
export const SCREEN_W = 1920;
export const SCREEN_H = 1080;

/** Wall grid dimensions (columns × rows of screens). */
export const COLS = 16;
export const ROWS = 4;

/** Preserve the existing 16 × 9 grid density for any logical panel size. */
export function getSnapGridSize(layout: StageLayout): number {
    return Math.max(1, Math.round(Math.min(layout.screenWidth / 16, layout.screenHeight / 9)));
}
