import { expect, test, type BrowserContext } from 'playwright/test';

import {
    actorStorageState,
    installDeviceIdentity,
    readHarnessManifest,
    waitForCanvasReady,
    waitForWallBusReady,
    waitForWallHydrated
} from '../support/harness';

test.use({ storageState: actorStorageState('user_editor') });

test('rectangle corner radius control updates the editor and bound wall', async ({
    browser,
    page
}) => {
    test.setTimeout(60_000);
    const manifest = readHarnessManifest();
    let wallContext: BrowserContext | null = null;

    try {
        await page.goto(
            `/quarry/editor/${manifest.fixtures.interactionProjectId}/${manifest.fixtures.interactionCommitId}/${manifest.fixtures.interactionSlideId}`
        );
        await expect(page.getByText('Loading slide...')).toBeHidden();
        await waitForCanvasReady(page, '#slate canvas');

        await page.evaluate(() => {
            const store = (
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
            ).__EDITOR_STORE__;
            if (!store) throw new Error('Editor store was not ready');
            store.getState().toggleLayerSelection('2', false, false);
        });

        await page.getByLabel('Rectangle corner radius').click();
        const radiusInput = page.getByRole('textbox', { name: 'Corner radius' });
        await expect(radiusInput).toHaveValue('0');
        await radiusInput.fill('48');
        await radiusInput.press('Enter');

        await expect
            .poll(() =>
                page.evaluate(
                    () =>
                        (
                            window as Window & {
                                __EDITOR_STORE__?: {
                                    getState: () => {
                                        layers: Map<number, { cornerRadius?: number }>;
                                    };
                                };
                            }
                        ).__EDITOR_STORE__
                            ?.getState()
                            .layers.get(2)?.cornerRadius ?? null
                )
            )
            .toBe(48);

        wallContext = await browser.newContext({ baseURL: manifest.baseUrl });
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

        await waitForWallHydrated(wallPage, { source: 'live', foregroundLayerCount: 2 });
        const rectangle = wallPage.locator('rect[fill="#2563eb"]');
        await expect(rectangle).toHaveAttribute('rx', '48');
        await expect(rectangle).toHaveAttribute('ry', '48');
    } finally {
        await page.evaluate(() => {
            const harnessWindow = window as Window & {
                __EDITOR_STORE__?: {
                    getState: () => { setRectangleCornerRadius: (radius: number) => void };
                };
                __EDITOR_ENGINE__?: { unbindWall: () => void };
            };
            harnessWindow.__EDITOR_STORE__?.getState().setRectangleCornerRadius(0);
            harnessWindow.__EDITOR_ENGINE__?.unbindWall();
        });
        await wallContext?.close();
    }
});
