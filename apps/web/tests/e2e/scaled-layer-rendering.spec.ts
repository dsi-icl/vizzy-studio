import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type BrowserContext, type Locator } from 'playwright/test';
import sharp from 'sharp';

import {
    actorStorageState,
    installDeviceIdentity,
    readHarnessManifest,
    waitForCanvasReady,
    waitForWallBusReady,
    waitForWallHydrated
} from '../support/harness';

const MINIMAL_VIDEO_DATA_URL = `data:video/mp4;base64,${readFileSync(
    resolve(process.cwd(), 'apps/web/tests/fixtures/minimal-video.mp4.base64'),
    'utf8'
).replace(/\s/g, '')}`;

const SCALED_LAYERS = [
    {
        numericId: 40,
        type: 'video',
        config: {
            cx: 500,
            cy: 300,
            width: 600,
            height: 300,
            rotation: 0,
            scaleX: 1.5,
            scaleY: 0.75,
            zIndex: 10,
            visible: true
        },
        url: MINIMAL_VIDEO_DATA_URL,
        blurhash: '00TI?p',
        duration: 1,
        loop: true,
        playback: { status: 'paused', anchorMediaTime: 0, anchorServerTime: 0 },
        rvfcActive: false
    },
    {
        numericId: 41,
        type: 'shape',
        shape: 'rectangle',
        config: {
            cx: 1300,
            cy: 300,
            width: 300,
            height: 240,
            rotation: 0,
            scaleX: 1.4,
            scaleY: 0.8,
            zIndex: 11,
            visible: true
        },
        fill: '#22c55e',
        strokeColor: '#22c55e',
        strokeDash: [],
        strokeWidth: 0
    },
    {
        numericId: 42,
        type: 'image',
        config: {
            cx: 1400,
            cy: 700,
            width: 500,
            height: 300,
            rotation: 0,
            scaleX: 0.8,
            scaleY: 1.25,
            zIndex: 12,
            visible: true
        },
        url: `data:image/svg+xml,${encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="300"><rect width="500" height="300" fill="#06b6d4"/></svg>'
        )}`
    },
    {
        numericId: 43,
        type: 'shape',
        shape: 'circle',
        config: {
            cx: 1900,
            cy: 300,
            width: 240,
            height: 240,
            rotation: 0,
            scaleX: 1.5,
            scaleY: 0.5,
            zIndex: 13,
            visible: true
        },
        fill: '#f97316',
        strokeColor: '#f97316',
        strokeDash: [],
        strokeWidth: 0
    },
    {
        numericId: 44,
        type: 'line',
        config: {
            cx: 2375,
            cy: 625,
            width: 650,
            height: 50,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            zIndex: 14,
            visible: true
        },
        line: [2050, 600, 2400, 650, 2700, 600],
        strokeColor: '#a855f7',
        strokeDash: [],
        strokeWidth: 40
    }
] as const;

test.use({ storageState: actorStorageState('user_editor') });

async function measureColour(
    canvas: Locator,
    matches: (red: number, green: number, blue: number, alpha: number) => boolean
) {
    const screenshot = await canvas.screenshot();
    const { data, info } = await sharp(screenshot)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    let left = info.width;
    let top = info.height;
    let right = -1;
    let bottom = -1;

    for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
            const offset = (y * info.width + x) * info.channels;
            if (!matches(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])) {
                continue;
            }
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
        }
    }

    return right < left ? null : { left, top, width: right - left + 1, height: bottom - top + 1 };
}

async function readVisualBounds(locator: Locator) {
    return locator.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            objectFit: getComputedStyle(node).objectFit
        };
    });
}

test('non-unit video, shape, and image scales match the minimap and wall', async ({
    browser,
    page
}) => {
    test.setTimeout(90_000);
    const manifest = readHarnessManifest();
    const extraContexts: BrowserContext[] = [];

    try {
        await page.goto(
            `/quarry/editor/${manifest.fixtures.interactionProjectId}/${manifest.fixtures.interactionCommitId}/${manifest.fixtures.interactionSlideId}`
        );
        await expect(page.getByText('Loading slide...')).toBeHidden();
        await waitForCanvasReady(page, '#slate canvas');

        await page.evaluate((layers) => {
            type HarnessLayer = (typeof layers)[number];
            const harnessWindow = window as Window & {
                __EDITOR_STORE__?: {
                    getState: () => {
                        upsertLayer: (layer: HarnessLayer) => void;
                        toggleLayerSelection: (
                            numericId: string,
                            additive: boolean,
                            toggle: boolean
                        ) => void;
                    };
                };
                __EDITOR_ENGINE__?: { sendJSON: (message: Record<string, unknown>) => void };
            };
            const state = harnessWindow.__EDITOR_STORE__?.getState();
            const engine = harnessWindow.__EDITOR_ENGINE__;
            if (!state || !engine) throw new Error('Editor runtime was not ready');
            for (const layer of layers) {
                state.upsertLayer(layer);
                engine.sendJSON({ type: 'upsert_layer', origin: 'test:scaled_layers', layer });
            }
            state.toggleLayerSelection('40', false, false);
        }, SCALED_LAYERS);

        await page.getByRole('button', { name: 'Parameters' }).click();
        await expect(page.getByRole('textbox', { name: 'X' })).toHaveValue('50');
        await expect(page.getByRole('textbox', { name: 'Y' })).toHaveValue('187.5');

        const minimapCanvas = page.locator('.konvajs-content canvas').first();
        await expect
            .poll(
                async () =>
                    (
                        await measureColour(
                            minimapCanvas,
                            (red, green, blue, alpha) =>
                                red > 180 && green < 80 && blue > 180 && alpha > 100
                        )
                    )?.width ?? 0
            )
            .toBeGreaterThanOrEqual(18);

        const videoPreviewBounds = await measureColour(
            minimapCanvas,
            (red, green, blue, alpha) => red > 180 && green < 80 && blue > 180 && alpha > 100
        );
        const shapePreviewBounds = await measureColour(
            minimapCanvas,
            (red, green, blue, alpha) => red < 80 && green > 150 && blue < 150 && alpha > 100
        );
        const imagePreviewBounds = await measureColour(
            minimapCanvas,
            (red, green, blue, alpha) => red < 80 && green > 120 && blue > 150 && alpha > 100
        );
        const circlePreviewBounds = await measureColour(
            minimapCanvas,
            (red, green, blue, alpha) =>
                red > 200 && green > 70 && green < 160 && blue < 80 && alpha > 100
        );
        const linePreviewBounds = await measureColour(
            minimapCanvas,
            (red, green, blue, alpha) =>
                red > 120 && red < 210 && green < 130 && blue > 180 && alpha > 50
        );

        expect(videoPreviewBounds?.width).toBeGreaterThanOrEqual(18);
        expect(videoPreviewBounds?.height).toBeGreaterThanOrEqual(4);
        expect(shapePreviewBounds?.width).toBeGreaterThanOrEqual(8);
        expect(shapePreviewBounds?.height).toBeGreaterThanOrEqual(3);
        expect(imagePreviewBounds?.width).toBeGreaterThanOrEqual(8);
        expect(imagePreviewBounds?.height).toBeGreaterThanOrEqual(7);
        expect(circlePreviewBounds?.width).toBeGreaterThanOrEqual(6);
        expect(circlePreviewBounds?.height).toBeGreaterThanOrEqual(2);
        // Preview strokes are deliberately amplified before the stage scale is applied.
        expect(linePreviewBounds?.width).toBeGreaterThanOrEqual(12);
        expect(linePreviewBounds?.height).toBeGreaterThanOrEqual(1);

        const wallContext = await browser.newContext({ baseURL: manifest.baseUrl });
        extraContexts.push(wallContext);
        await installDeviceIdentity(wallContext, {
            kind: 'wall',
            device: manifest.devices.dev_wall_media,
            wallId: manifest.fixtures.mediaWallId
        });
        const wallPage = await wallContext.newPage();
        await wallPage.goto(`/wall?w=${manifest.fixtures.mediaWallId}&c=0&r=0`);
        await waitForWallBusReady(wallPage);

        await page.evaluate(
            ({ wallId, projectId, commitId, slideId }) => {
                const engine = (
                    window as Window & {
                        __EDITOR_ENGINE__?: {
                            bindWall: (
                                wallId: string,
                                projectId: string,
                                commitId: string,
                                slideId: string
                            ) => void;
                        };
                    }
                ).__EDITOR_ENGINE__;
                if (!engine) throw new Error('Editor engine was not ready');
                engine.bindWall(wallId, projectId, commitId, slideId);
            },
            {
                wallId: manifest.fixtures.mediaWallId,
                projectId: manifest.fixtures.interactionProjectId,
                commitId: manifest.fixtures.interactionCommitId,
                slideId: manifest.fixtures.interactionSlideId
            }
        );
        await waitForWallHydrated(wallPage, { source: 'live', foregroundLayerCount: 7 });

        await expect
            .poll(() => readVisualBounds(wallPage.locator('video')))
            .toMatchObject({ left: 50, top: 187.5, width: 900, height: 225, objectFit: 'fill' });
        await expect
            .poll(() => readVisualBounds(wallPage.locator('rect[fill="#22c55e"]')))
            .toMatchObject({ left: 1090, top: 204, width: 420, height: 192 });
        await expect
            .poll(() => readVisualBounds(wallPage.locator('img[alt="Layer 42"]')))
            .toMatchObject({ left: 1200, top: 512.5, width: 400, height: 375 });
        await expect
            .poll(() => readVisualBounds(wallPage.locator('circle[fill="#f97316"]')))
            .toMatchObject({ width: 360, height: 120 });
        await expect(wallPage.locator('polyline[stroke="#a855f7"]')).toHaveAttribute(
            'stroke-width',
            '40'
        );
    } finally {
        await page.evaluate(
            (numericIds) => {
                const harnessWindow = window as Window & {
                    __EDITOR_STORE__?: {
                        getState: () => { removeLayer: (numericId: number) => void };
                    };
                    __EDITOR_ENGINE__?: { sendJSON: (message: Record<string, unknown>) => void };
                };
                const state = harnessWindow.__EDITOR_STORE__?.getState();
                const engine = harnessWindow.__EDITOR_ENGINE__;
                if (!state || !engine) return;
                for (const numericId of numericIds) {
                    state.removeLayer(numericId);
                    engine.sendJSON({
                        type: 'delete_layer',
                        origin: 'test:scaled_layers_cleanup',
                        numericId
                    });
                }
            },
            SCALED_LAYERS.map((layer) => layer.numericId)
        );
        await Promise.all(extraContexts.map((context) => context.close()));
    }
});
