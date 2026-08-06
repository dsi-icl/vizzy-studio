import { expect, test, type Page } from 'playwright/test';
import sharp from 'sharp';

import { actorStorageState, readHarnessManifest, waitForCanvasReady } from '../support/harness';

const SHAPE_LAYER = {
    numericId: 2,
    type: 'shape',
    shape: 'rectangle',
    config: {
        cx: 360,
        cy: 360,
        width: 300,
        height: 220,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        visible: true
    },
    fill: '#2563eb',
    strokeColor: '#bfdbfe',
    strokeDash: [],
    strokeWidth: 8
} as const;

const TEXT_LAYER = {
    numericId: 3,
    type: 'text',
    config: {
        cx: 850,
        cy: 360,
        width: 420,
        height: 180,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 2,
        visible: true
    },
    textHtml:
        '<p style="font-size:1.8em;color:#f8fafc;text-align:center"><strong>Line one<br>Line two</strong></p>',
    textRevision: 1
} as const;

test.use({ storageState: actorStorageState('user_editor') });

async function openInteractionEditor(page: Page) {
    const { fixtures } = readHarnessManifest();
    await page.goto(
        `/quarry/editor/${fixtures.interactionProjectId}/${fixtures.interactionCommitId}/${fixtures.interactionSlideId}`
    );
    await expect(page.getByText('Loading slide...')).toBeHidden();
    await waitForCanvasReady(page, '#slate canvas');
    await expect
        .poll(
            () =>
                page.evaluate(
                    () =>
                        (
                            window as Window & {
                                __EDITOR_ENGINE__?: { connectionStatus: string };
                            }
                        ).__EDITOR_ENGINE__?.connectionStatus ?? null
                ),
            { timeout: 15_000, intervals: [25, 50, 100, 200] }
        )
        .toBe('connected');
}

async function resetInteractionLayers(page: Page) {
    await page.evaluate(
        ({ shapeLayer, textLayer }) => {
            type HarnessLayer = typeof shapeLayer | typeof textLayer;
            const harnessWindow = window as Window & {
                __EDITOR_STORE__?: {
                    getState: () => {
                        upsertLayer: (layer: HarnessLayer) => void;
                        markDirty: () => void;
                    };
                };
                __EDITOR_ENGINE__?: { sendJSON: (message: Record<string, unknown>) => void };
            };
            const state = harnessWindow.__EDITOR_STORE__?.getState();
            const engine = harnessWindow.__EDITOR_ENGINE__;
            if (!state || !engine) throw new Error('Editor runtime was not ready');
            for (const layer of [shapeLayer, textLayer]) {
                state.upsertLayer(layer);
                engine.sendJSON({ type: 'upsert_layer', origin: 'test:reset_interaction', layer });
            }
            state.markDirty();
        },
        { shapeLayer: SHAPE_LAYER, textLayer: TEXT_LAYER }
    );
    await expect(page.getByText('Unsaved', { exact: false })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByText('Unsaved', { exact: false })).toBeHidden({ timeout: 15_000 });
}

async function countBrightTextPixels(page: Page) {
    const screenshot = await page.locator('#slate .konvajs-content').screenshot();
    const { data, info } = await sharp(screenshot)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const logical = { left: 640, top: 260, right: 1060, bottom: 460 };
    const left = Math.floor((logical.left / 1280) * info.width);
    const top = Math.floor((logical.top / 720) * info.height);
    const right = Math.ceil((logical.right / 1280) * info.width);
    const bottom = Math.ceil((logical.bottom / 720) * info.height);
    let brightPixels = 0;
    for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
            const offset = (y * info.width + x) * info.channels;
            if (
                data[offset] > 180 &&
                data[offset + 1] > 180 &&
                data[offset + 2] > 180 &&
                data[offset + 3] > 64
            ) {
                brightPixels += 1;
            }
        }
    }
    return brightPixels;
}

test('line-break text produces visible pixels on the editor canvas', async ({ page }) => {
    test.fail(
        true,
        'Known main-branch gap: rich-text line breaks are not yet normalised for canvas XHTML rendering.'
    );
    await openInteractionEditor(page);
    await expect.poll(() => countBrightTextPixels(page), { timeout: 15_000 }).toBeGreaterThan(50);
});

test('pointer-down selects an unselected layer and Backspace deletes it safely', async ({
    page
}) => {
    test.fail(
        true,
        'Known main-branch gap: pointer-first selection and contained Backspace deletion fixes are not yet present.'
    );
    await openInteractionEditor(page);
    await resetInteractionLayers(page);

    await page.getByRole('button', { name: 'Line oneLine two', exact: true }).click();
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    (
                        window as Window & {
                            __EDITOR_STORE__?: {
                                getState: () => { selectedLayerIds: string[] };
                            };
                        }
                    ).__EDITOR_STORE__?.getState().selectedLayerIds ?? []
            )
        )
        .toEqual(['3']);

    const stageBounds = await page.locator('#slate .konvajs-content').boundingBox();
    if (!stageBounds) throw new Error('Editor stage did not have bounds');
    const startX = stageBounds.x + (360 / 1280) * stageBounds.width;
    const startY = stageBounds.y + (360 / 720) * stageBounds.height;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    (
                        window as Window & {
                            __EDITOR_STORE__?: {
                                getState: () => { selectedLayerIds: string[] };
                            };
                        }
                    ).__EDITOR_STORE__?.getState().selectedLayerIds ?? []
            )
        )
        .toEqual(['2']);
    await page.mouse.move(startX + 90, startY + 30, { steps: 4 });
    await page.mouse.up();

    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    (
                        window as Window & {
                            __EDITOR_STORE__?: {
                                getState: () => {
                                    layers: Map<number, { config: { cx: number } }>;
                                };
                            };
                        }
                    ).__EDITOR_STORE__
                        ?.getState()
                        .layers.get(2)?.config.cx ?? null
            )
        )
        .toBeGreaterThan(360);

    const repeatedBackspace = await page.evaluate(() => {
        const event = new KeyboardEvent('keydown', {
            key: 'Backspace',
            repeat: true,
            bubbles: true,
            cancelable: true
        });
        window.dispatchEvent(event);
        return {
            defaultPrevented: event.defaultPrevented,
            shapeStillPresent:
                (
                    window as Window & {
                        __EDITOR_STORE__?: {
                            getState: () => { layers: Map<number, unknown> };
                        };
                    }
                ).__EDITOR_STORE__
                    ?.getState()
                    .layers.has(2) ?? false
        };
    });
    expect(repeatedBackspace).toEqual({ defaultPrevented: true, shapeStillPresent: true });

    await page.evaluate(() => {
        (
            window as Window & { __BACKSPACE_DEFAULT_PREVENTED__?: boolean }
        ).__BACKSPACE_DEFAULT_PREVENTED__ = false;
        window.addEventListener(
            'keydown',
            (event) => {
                if (event.key === 'Backspace') {
                    (
                        window as Window & { __BACKSPACE_DEFAULT_PREVENTED__?: boolean }
                    ).__BACKSPACE_DEFAULT_PREVENTED__ = event.defaultPrevented;
                }
            },
            { once: true }
        );
    });
    await page.keyboard.press('Backspace');
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
                    ).__EDITOR_STORE__
                        ?.getState()
                        .layers.has(2) ?? true
            )
        )
        .toBe(false);
    expect(
        await page.evaluate(
            () =>
                (window as Window & { __BACKSPACE_DEFAULT_PREVENTED__?: boolean })
                    .__BACKSPACE_DEFAULT_PREVENTED__
        )
    ).toBe(true);
    await expect(page).toHaveURL(/\/quarry\/editor\//);
    await expect(page.getByText('Unsaved', { exact: false })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByText('Unsaved', { exact: false })).toBeHidden({ timeout: 15_000 });

    await page.reload();
    await expect(page.getByText('Loading slide...')).toBeHidden();
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
                    ).__EDITOR_STORE__
                        ?.getState()
                        .layers.has(2) ?? true
            )
        )
        .toBe(false);
});
