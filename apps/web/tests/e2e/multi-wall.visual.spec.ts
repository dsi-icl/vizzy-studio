import { resolve } from 'node:path';

import { expect, test, type BrowserContext, type Locator, type Page } from 'playwright/test';

import {
    actorStorageState,
    installDeviceIdentity,
    readHarnessManifest,
    waitForCanvasReady,
    waitForFonts,
    waitForWallBusReady,
    waitForWallHydrated
} from '../support/harness';

const screenshotStyle = resolve(process.cwd(), 'apps/web/tests/visual.css');

const cells = [
    { col: 0, row: 0, deviceKey: 'dev_wall_grid_00', cornerLabel: 'GRID TOP LEFT' },
    { col: 1, row: 0, deviceKey: 'dev_wall_grid_10', cornerLabel: 'GRID TOP RIGHT' },
    { col: 0, row: 1, deviceKey: 'dev_wall_grid_01', cornerLabel: 'GRID BOTTOM LEFT' },
    { col: 1, row: 1, deviceKey: 'dev_wall_grid_11', cornerLabel: 'GRID BOTTOM RIGHT' }
] as const;

type WallUnit = (typeof cells)[number] & {
    context: BrowserContext;
    page: Page;
};

async function readLayerStyle(locator: Locator) {
    return locator.evaluate((node) => {
        let element: HTMLElement | null = node as HTMLElement;
        while (element && element.style.position !== 'absolute') {
            element = element.parentElement;
        }
        if (!element) throw new Error('Could not find the positioned wall-layer wrapper');
        return {
            opacity: element.style.opacity,
            transform: element.style.transform,
            zIndex: element.style.zIndex
        };
    });
}

async function expectLayerStyle(
    locator: Locator,
    expected: { opacity: string; transform?: string; zIndex?: string }
) {
    await expect
        .poll(() => readLayerStyle(locator), {
            timeout: 10_000,
            intervals: [25, 50, 100, 200]
        })
        .toMatchObject(expected);
}

test.use({ storageState: actorStorageState('user_editor') });

test('four wall units crop one world consistently across seams and overlaps @visual', async ({
    browser,
    page: editorPage
}) => {
    test.setTimeout(90_000);
    const manifest = readHarnessManifest();
    const units: WallUnit[] = [];

    try {
        for (const cell of cells) {
            const device = manifest.devices[cell.deviceKey];
            expect(device, `Missing device fixture ${cell.deviceKey}`).toBeDefined();
            const context = await browser.newContext({
                baseURL: manifest.baseUrl,
                viewport: { width: 1920, height: 1080 },
                deviceScaleFactor: 1,
                colorScheme: 'light',
                locale: 'en-GB',
                timezoneId: 'Europe/London',
                reducedMotion: 'reduce'
            });
            await installDeviceIdentity(context, {
                kind: 'wall',
                device,
                wallId: manifest.fixtures.multiWallId,
                col: cell.col,
                row: cell.row
            });
            const page = await context.newPage();
            units.push({ ...cell, context, page });
        }

        await Promise.all(
            units.map(async ({ page, col, row }) => {
                await page.goto(`/wall?w=${manifest.fixtures.multiWallId}&c=${col}&r=${row}`);
                await waitForWallBusReady(page);
                await expect(page.getByText("This screen hasn't been registered yet")).toBeHidden();
            })
        );

        await editorPage.goto(
            `/quarry/editor/${manifest.fixtures.multiWallProjectId}/${manifest.fixtures.multiWallCommitId}/${manifest.fixtures.multiWallSlideId}`
        );
        await expect(editorPage.getByText('Loading slide...')).toBeHidden();
        await expect(editorPage.getByText('VERTICAL SEAM', { exact: true })).toBeVisible();
        await waitForFonts(editorPage);
        await waitForCanvasReady(editorPage, '#slate canvas');
        await expect
            .poll(
                () =>
                    editorPage.evaluate(
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

        await editorPage.evaluate(
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
                wallId: manifest.fixtures.multiWallId,
                projectId: manifest.fixtures.multiWallProjectId,
                commitId: manifest.fixtures.multiWallCommitId,
                slideId: manifest.fixtures.multiWallSlideId
            }
        );

        await Promise.all(
            units.map(({ page }) =>
                waitForWallHydrated(page, { source: 'live', foregroundLayerCount: 12 })
            )
        );

        const byCell = new Map(units.map((unit) => [`${unit.col},${unit.row}`, unit]));
        const topLeft = byCell.get('0,0')!;
        const topRight = byCell.get('1,0')!;
        const bottomLeft = byCell.get('0,1')!;
        const bottomRight = byCell.get('1,1')!;

        await expectLayerStyle(topLeft.page.locator('rect[fill="#e11d48"]'), {
            opacity: '1',
            transform: 'translate3d(1640px, 90px, 0px) rotate(0deg) scale(1, 1)'
        });
        await expectLayerStyle(topRight.page.locator('rect[fill="#e11d48"]'), {
            opacity: '1',
            transform: 'translate3d(-280px, 90px, 0px) rotate(0deg) scale(1, 1)'
        });
        await expectLayerStyle(bottomLeft.page.locator('rect[fill="#e11d48"]'), { opacity: '0' });
        await expectLayerStyle(bottomRight.page.locator('rect[fill="#e11d48"]'), {
            opacity: '0'
        });

        await expectLayerStyle(topLeft.page.locator('rect[fill="#16a34a"]'), {
            opacity: '1',
            transform: 'translate3d(680px, 880px, 0px) rotate(0deg) scale(1, 1)'
        });
        await expectLayerStyle(bottomLeft.page.locator('rect[fill="#16a34a"]'), {
            opacity: '1',
            transform: 'translate3d(680px, -200px, 0px) rotate(0deg) scale(1, 1)'
        });
        await expectLayerStyle(topRight.page.locator('rect[fill="#16a34a"]'), { opacity: '0' });
        await expectLayerStyle(bottomRight.page.locator('rect[fill="#16a34a"]'), {
            opacity: '0'
        });

        const centerTransforms = new Map([
            ['0,0', 'translate3d(1560px, 820px, 0px) rotate(0deg) scale(1, 1)'],
            ['1,0', 'translate3d(-360px, 820px, 0px) rotate(0deg) scale(1, 1)'],
            ['0,1', 'translate3d(1560px, -260px, 0px) rotate(0deg) scale(1, 1)'],
            ['1,1', 'translate3d(-360px, -260px, 0px) rotate(0deg) scale(1, 1)']
        ]);
        for (const unit of units) {
            await expectLayerStyle(unit.page.locator('rect[fill="#2563eb"]'), {
                opacity: '1',
                transform: centerTransforms.get(`${unit.col},${unit.row}`),
                zIndex: '3'
            });
            await expectLayerStyle(unit.page.locator('rect[fill="#facc15"]'), {
                opacity: '1',
                zIndex: '4'
            });

            for (const candidate of cells) {
                await expectLayerStyle(
                    unit.page.getByText(candidate.cornerLabel, { exact: true }),
                    { opacity: candidate.cornerLabel === unit.cornerLabel ? '1' : '0' }
                );
            }
        }

        await expectLayerStyle(bottomLeft.page.getByText('VERTICAL SEAM', { exact: true }), {
            opacity: '1',
            transform: 'translate3d(1360px, 585px, 0px) rotate(0deg) scale(1, 1)'
        });
        await expectLayerStyle(bottomRight.page.getByText('VERTICAL SEAM', { exact: true }), {
            opacity: '1',
            transform: 'translate3d(-560px, 585px, 0px) rotate(0deg) scale(1, 1)'
        });
        await expectLayerStyle(topLeft.page.getByText('VERTICAL SEAM', { exact: true }), {
            opacity: '0'
        });
        await expectLayerStyle(topRight.page.getByText('VERTICAL SEAM', { exact: true }), {
            opacity: '0'
        });

        for (const unit of units) {
            const panelViewport = unit.page.locator(
                'div.absolute.overflow-hidden.bg-black:not(.inset-0)'
            );
            await expect(panelViewport).toHaveCSS('width', '1920px');
            await expect(panelViewport).toHaveCSS('height', '1080px');
            await expect(unit.page).toHaveScreenshot(`multi-wall-c${unit.col}-r${unit.row}.png`, {
                stylePath: screenshotStyle
            });
        }
    } finally {
        await Promise.all(units.map(({ context }) => context.close()));
    }
});
