import { resolve } from 'node:path';

import { expect, test, type BrowserContext } from 'playwright/test';

import {
    installDeviceIdentity,
    readHarnessManifest,
    waitForCanvasReady,
    waitForFonts,
    waitForWallBusReady,
    waitForWallCleared,
    waitForWallHydrated
} from '../support/harness';

const screenshotStyle = resolve(process.cwd(), 'apps/web/tests/visual.css');

test('controller renders the canonical bound composition @visual', async ({ browser }) => {
    test.setTimeout(90_000);
    const manifest = readHarnessManifest();
    const contexts: BrowserContext[] = [];

    const createContext = async () => {
        const context = await browser.newContext({
            baseURL: manifest.baseUrl,
            viewport: { width: 1440, height: 900 },
            deviceScaleFactor: 1,
            colorScheme: 'light',
            locale: 'en-GB',
            timezoneId: 'Europe/London',
            reducedMotion: 'reduce'
        });
        contexts.push(context);
        return context;
    };

    try {
        const wallContext = await createContext();
        await installDeviceIdentity(wallContext, {
            kind: 'wall',
            device: manifest.devices.dev_wall_controller,
            wallId: manifest.fixtures.controllerWallId
        });
        const wallPage = await wallContext.newPage();

        const controllerContext = await createContext();
        await installDeviceIdentity(controllerContext, {
            kind: 'controller',
            device: manifest.devices.dev_controller_visual,
            wallId: manifest.fixtures.controllerWallId
        });
        const controllerPage = await controllerContext.newPage();

        const galleryContext = await createContext();
        await installDeviceIdentity(galleryContext, {
            kind: 'gallery',
            device: manifest.devices.dev_gallery_controller,
            wallId: manifest.fixtures.controllerWallId
        });
        const galleryPage = await galleryContext.newPage();

        await Promise.all([
            wallPage.goto(`/wall?w=${manifest.fixtures.controllerWallId}&c=0&r=0`),
            controllerPage.goto(`/controller?w=${manifest.fixtures.controllerWallId}&c=0&r=0`),
            galleryPage.goto(`/gallery?w=${manifest.fixtures.controllerWallId}&c=0&r=0&enroll`)
        ]);
        await waitForWallBusReady(wallPage);
        await expect(controllerPage.getByText('Nothing to control just yet')).toBeVisible({
            timeout: 15_000
        });
        await expect(
            galleryPage.getByText('Harness Public Project', { exact: true }).first()
        ).toBeVisible();

        await galleryPage
            .locator('button[aria-haspopup="dialog"]')
            .filter({ hasText: 'Harness Public Project' })
            .click();
        await galleryPage.getByRole('button', { name: 'Load project' }).click();

        await waitForWallHydrated(wallPage, { source: 'gallery', foregroundLayerCount: 6 });
        const canonicalSlide = controllerPage.getByRole('button', {
            name: 'Slide Rendering baseline'
        });
        await expect(canonicalSlide).toBeVisible({ timeout: 20_000 });
        await waitForFonts(controllerPage);
        await waitForCanvasReady(controllerPage, '.konvajs-content canvas');
        await expect(canonicalSlide).toHaveClass(/bg-primary\/10/);

        await expect(controllerPage).toHaveScreenshot('controller-display.png', {
            stylePath: screenshotStyle
        });

        await galleryPage.getByRole('button', { name: 'Close dialog' }).click();
        await expect(controllerPage.getByText('Nothing to control just yet')).toBeVisible({
            timeout: 20_000
        });
        await waitForWallCleared(wallPage);
    } finally {
        await Promise.all(contexts.map((context) => context.close()));
    }
});
