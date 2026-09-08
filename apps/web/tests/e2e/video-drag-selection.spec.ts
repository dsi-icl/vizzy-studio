import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from 'playwright/test';

import { actorStorageState, readHarnessManifest, waitForCanvasReady } from '../support/harness';

test.use({ storageState: actorStorageState('user_editor') });

const VIDEO_ID = 90001;
const OTHER_ID = 90002;

const POSTER_DATA_URI = `data:image/png;base64,${readFileSync(
    resolve(process.cwd(), 'apps/web/public/favicon-96x96.png')
).toString('base64')}`;

const LOGICAL_STAGE_WIDTH = 16 * 1920;

const injectedVideoLayer = {
    numericId: VIDEO_ID,
    type: 'video' as const,
    name: 'Regression video layer',
    url: POSTER_DATA_URI,
    loop: false,
    duration: 5,
    rvfcActive: false,
    playback: { status: 'paused' as const, anchorMediaTime: 0, anchorServerTime: 0 },
    config: {
        // Highest zIndex so the injected layer is the topmost hit target.
        zIndex: 100_000,
        visible: true,
        cx: 960,
        cy: 540,
        width: 640,
        height: 360,
        rotation: 0,
        scaleX: 1,
        scaleY: 1
    }
};

const otherLayer = {
    numericId: OTHER_ID,
    type: 'image' as const,
    name: 'Initially selected layer',
    url: POSTER_DATA_URI,
    config: {
        zIndex: 1,
        visible: true,
        cx: 300,
        cy: 900,
        width: 200,
        height: 200,
        rotation: 0,
        scaleX: 1,
        scaleY: 1
    }
};

async function waitForServerHydrate(page: Page): Promise<void> {
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    (
                        window as Window & {
                            __EDITOR_STORE__?: {
                                getState: () => { layers: Map<number, unknown> };
                            };
                        }
                    ).__EDITOR_STORE__?.getState().layers.size ?? 0
            )
        )
        .toBeGreaterThan(0);
}

async function injectLayers(page: Page, layers: unknown[]): Promise<void> {
    await page.evaluate((extra) => {
        const store = (
            window as Window & {
                __EDITOR_STORE__?: {
                    getState: () => {
                        layers: Map<number, unknown>;
                        hydrate: (layers: unknown[]) => void;
                    };
                };
            }
        ).__EDITOR_STORE__;
        if (!store) throw new Error('Editor store was not ready');
        const state = store.getState();
        state.hydrate([...state.layers.values(), ...extra]);
    }, layers);
}

function readSelectedIds(page: Page): Promise<string[]> {
    return page.evaluate(
        () =>
            (
                window as Window & {
                    __EDITOR_STORE__?: { getState: () => { selectedLayerIds: string[] } };
                }
            ).__EDITOR_STORE__?.getState().selectedLayerIds ?? []
    );
}

function readLayerPosition(page: Page, id: number): Promise<{ cx: number; cy: number } | null> {
    return page.evaluate((layerId) => {
        const layer = (
            window as Window & {
                __EDITOR_STORE__?: {
                    getState: () => {
                        layers: Map<number, { config: { cx: number; cy: number } }>;
                    };
                };
            }
        ).__EDITOR_STORE__
            ?.getState()
            .layers.get(layerId);
        return layer ? { cx: layer.config.cx, cy: layer.config.cy } : null;
    }, id);
}

async function removeInjectedLayers(page: Page, ids: number[]): Promise<void> {
    await page.evaluate((layerIds) => {
        const store = (
            window as Window & {
                __EDITOR_STORE__?: {
                    getState: () => {
                        removeLayer: (numericId: number) => void;
                        deselectAllLayers: () => void;
                    };
                };
            }
        ).__EDITOR_STORE__;
        const state = store?.getState();
        state?.deselectAllLayers();
        for (const id of layerIds) state?.removeLayer(id);
    }, ids);
}

async function openInteractionEditor(page: Page): Promise<void> {
    const manifest = readHarnessManifest();
    await page.goto(
        `/quarry/editor/${manifest.fixtures.interactionProjectId}/${manifest.fixtures.interactionCommitId}/${manifest.fixtures.interactionSlideId}`
    );
    await expect(page.getByText('Loading slide...')).toBeHidden();
    await waitForCanvasReady(page, '#slate canvas');
    await waitForServerHydrate(page);
}

async function layerPoint(page: Page, cx: number, cy: number): Promise<{ x: number; y: number }> {
    const bounds = await page.locator('#slate .konvajs-content').boundingBox();
    if (!bounds) throw new Error('Editor stage did not have bounds');
    const scale = bounds.width / LOGICAL_STAGE_WIDTH;
    return { x: bounds.x + cx * scale, y: bounds.y + cy * scale };
}

test('dragging a video selects and moves the layer through its wrapping Group', async ({
    page
}) => {
    test.setTimeout(60_000);
    await openInteractionEditor(page);

    try {
        await injectLayers(page, [injectedVideoLayer]);
        await expect.poll(() => readLayerPosition(page, VIDEO_ID)).toEqual({ cx: 960, cy: 540 });

        const point = await layerPoint(page, 960, 540);
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await expect.poll(() => readSelectedIds(page)).toEqual([String(VIDEO_ID)]);

        await page.mouse.move(point.x + 60, point.y + 30, { steps: 5 });
        await page.mouse.up();
        await expect
            .poll(() => readLayerPosition(page, VIDEO_ID))
            .not.toEqual({ cx: 960, cy: 540 });
    } finally {
        await removeInjectedLayers(page, [VIDEO_ID]);
    }
});

test('press-drag moves the video and transfers the selection box from another layer', async ({
    page
}) => {
    test.setTimeout(60_000);
    await openInteractionEditor(page);

    try {
        await injectLayers(page, [otherLayer, injectedVideoLayer]);
        await expect.poll(() => readLayerPosition(page, VIDEO_ID)).toEqual({ cx: 960, cy: 540 });

        await page.evaluate((id) => {
            (
                window as Window & {
                    __EDITOR_STORE__?: {
                        getState: () => {
                            toggleLayerSelection: (
                                id: string,
                                isShiftClick: boolean,
                                isCtrlClick: boolean
                            ) => void;
                        };
                    };
                }
            ).__EDITOR_STORE__
                ?.getState()
                .toggleLayerSelection(String(id), false, false);
        }, OTHER_ID);
        await expect.poll(() => readSelectedIds(page)).toEqual([String(OTHER_ID)]);

        const point = await layerPoint(page, 960, 540);
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.mouse.move(point.x + 60, point.y + 30, { steps: 5 });
        await page.mouse.up();

        await expect.poll(() => readSelectedIds(page)).toEqual([String(VIDEO_ID)]);
        await expect
            .poll(() => readLayerPosition(page, VIDEO_ID))
            .not.toEqual({ cx: 960, cy: 540 });
    } finally {
        await removeInjectedLayers(page, [VIDEO_ID, OTHER_ID]);
    }
});
