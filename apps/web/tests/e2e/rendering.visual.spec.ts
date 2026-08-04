import { resolve } from 'node:path';

import { expect, test } from 'playwright/test';

import {
    actorStorageState,
    installDeviceIdentity,
    readHarnessManifest,
    waitForCanvasReady,
    waitForFonts
} from '../support/harness';

const screenshotStyle = resolve(process.cwd(), 'apps/web/tests/visual.css');

test.use({ storageState: actorStorageState('user_editor') });

test.describe('canonical rendering @visual', () => {
    test('editor renders the seeded composition and workspace chrome', async ({ page }) => {
        const { fixtures } = readHarnessManifest();
        await page.goto(
            `/quarry/editor/${fixtures.renderingProjectId}/${fixtures.renderingCommitId}/${fixtures.renderingSlideId}`
        );

        await expect(page.getByText('Loading slide...')).toBeHidden();
        await expect(page.getByText('Visual harness', { exact: false })).toBeVisible();
        await expect(page.locator('#slate .konvajs-content')).toBeVisible();
        await waitForFonts(page);
        await waitForCanvasReady(page, '#slate canvas');

        await expect(page).toHaveScreenshot('editor-workspace.png', {
            stylePath: screenshotStyle
        });
    });

    test('commit viewer renders the same canonical composition', async ({ page }) => {
        const { fixtures } = readHarnessManifest();
        await page.goto(
            `/quarry/view/${fixtures.renderingProjectId}/${fixtures.renderingCommitId}`
        );

        await expect(page.getByText('Harness rendering head')).toBeVisible();
        await expect(page.getByText('Slide 1', { exact: true })).toBeVisible();
        await waitForFonts(page);
        await waitForCanvasReady(page, '.konvajs-content canvas');

        await expect(page).toHaveScreenshot('commit-viewer.png', { stylePath: screenshotStyle });
    });

    test('wall display hydrates and renders its bound composition', async ({ context, page }) => {
        const manifest = readHarnessManifest();
        const wallDevice = manifest.devices.dev_wall_active;
        expect(wallDevice).toBeDefined();

        await installDeviceIdentity(context, {
            kind: 'wall',
            device: wallDevice,
            wallId: manifest.fixtures.wallId
        });
        await page.goto(`/wall?w=${manifest.fixtures.wallId}&c=0&r=0`);

        await expect(page.getByText("This screen hasn't been registered yet")).toBeHidden();
        const editorPage = await context.newPage();
        await editorPage.goto(
            `/quarry/editor/${manifest.fixtures.renderingProjectId}/${manifest.fixtures.renderingCommitId}/${manifest.fixtures.renderingSlideId}`
        );
        await expect(editorPage.getByText('Loading slide...')).toBeHidden();
        await expect(editorPage.getByText('Visual harness', { exact: false })).toBeVisible();
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
                wallId: manifest.fixtures.wallId,
                projectId: manifest.fixtures.renderingProjectId,
                commitId: manifest.fixtures.renderingCommitId,
                slideId: manifest.fixtures.renderingSlideId
            }
        );

        await expect(page.getByText('Visual harness', { exact: false })).toBeVisible({
            timeout: 20_000
        });
        await expect(page.locator('img[alt="Layer 6"]')).toBeVisible();
        await expect(page.locator('iframe[title="Web layer 7"]')).toBeVisible();
        await expect(page.locator('div.pointer-events-none.absolute.inset-0.bg-black')).toHaveCSS(
            'opacity',
            '0',
            { timeout: 10_000 }
        );
        await waitForFonts(page);

        await expect(page).toHaveScreenshot('wall-display.png', {
            stylePath: screenshotStyle
        });
        await editorPage.close();
    });
});
