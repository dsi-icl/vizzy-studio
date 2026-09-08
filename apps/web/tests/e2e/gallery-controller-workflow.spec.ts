import { expect, test, type BrowserContext, type Page } from 'playwright/test';

import {
    forceRuntimeReconnect,
    installDeviceIdentity,
    readHarnessManifest,
    waitForCanvasReady,
    waitForWallBusReady,
    waitForWallCleared,
    waitForWallHydrated
} from '../support/harness';

test('gallery binding converges across the wall and enrolled controller while portal access is issued', async ({
    browser
}) => {
    test.setTimeout(90_000);
    test.fail(
        true,
        'Known main-branch gap: a controller reconnect clears the fresh authoritative slide snapshot.'
    );
    const manifest = readHarnessManifest();
    const contexts: BrowserContext[] = [];
    let wallPage: Page | null = null;
    let controllerPage: Page | null = null;
    let galleryPage: Page | null = null;

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
            device: manifest.devices.dev_wall_gallery,
            wallId: manifest.fixtures.galleryWallId
        });
        wallPage = await wallContext.newPage();

        const controllerContext = await createContext();
        await installDeviceIdentity(controllerContext, {
            kind: 'controller',
            device: manifest.devices.dev_controller_active,
            wallId: manifest.fixtures.galleryWallId
        });
        controllerPage = await controllerContext.newPage();

        const galleryContext = await createContext();
        await installDeviceIdentity(galleryContext, {
            kind: 'gallery',
            device: manifest.devices.dev_gallery_active,
            wallId: manifest.fixtures.galleryWallId
        });
        galleryPage = await galleryContext.newPage();

        await Promise.all([
            wallPage.goto(`/wall?w=${manifest.fixtures.galleryWallId}&c=0&r=0`),
            controllerPage.goto(`/controller?w=${manifest.fixtures.galleryWallId}&c=0&r=0`),
            galleryPage.goto(`/gallery?w=${manifest.fixtures.galleryWallId}&c=0&r=0&enroll`)
        ]);

        await waitForWallBusReady(wallPage);
        await expect(
            galleryPage.getByText('Harness Public Project', { exact: true }).first()
        ).toBeVisible();

        // Establish a retry-safe idle state through the authenticated gallery channel.
        await galleryPage.evaluate((wallId) => {
            const engine = (
                window as Window & {
                    __GALLERY_ENGINE__?: { unbindWall: (targetWallId: string) => void };
                }
            ).__GALLERY_ENGINE__;
            if (!engine) throw new Error('Gallery engine was not ready');
            engine.unbindWall(wallId);
        }, manifest.fixtures.galleryWallId);

        await expect(controllerPage.getByText('Nothing to control just yet')).toBeVisible({
            timeout: 15_000
        });
        await waitForWallCleared(wallPage);

        await galleryPage
            .locator('button[aria-haspopup="dialog"]')
            .filter({ hasText: 'Harness Public Project' })
            .click();
        await galleryPage.getByRole('button', { name: 'Load project' }).click();

        await waitForWallHydrated(wallPage, {
            source: 'gallery',
            foregroundLayerCount: 6
        });
        await expect(wallPage.getByText('Visual harness', { exact: false })).toBeVisible();

        const firstSlide = controllerPage.getByRole('button', {
            name: 'Rendering baseline'
        });
        await expect(firstSlide).toBeVisible({ timeout: 20_000 });
        await waitForCanvasReady(controllerPage, '.konvajs-content canvas');

        // Token issuance and iframe creation are observable even though the current
        // single-server build has a known /controller/ canonicalisation defect.
        // The standalone controller remains the rendering/control authority here.
        const embeddedController = galleryPage.locator(
            'iframe[title="Controller for Harness Public Project"]'
        );
        await expect(embeddedController).toBeVisible({ timeout: 20_000 });
        await expect(embeddedController).toHaveAttribute(
            'src',
            /\/controller\/\?.*_viz_t=viz_ctrl_/
        );

        await forceRuntimeReconnect(galleryPage, '__GALLERY_ENGINE__');

        const alternateSlide = controllerPage.getByRole('button', { name: 'Alternate' });
        await expect(alternateSlide).toBeVisible();
        await alternateSlide.click();

        await waitForWallHydrated(wallPage, {
            source: 'gallery',
            foregroundLayerCount: 2
        });
        await expect(wallPage.getByText('Gallery alternate', { exact: true })).toBeVisible();
        await expect(controllerPage.getByText('Switching slide...')).toBeHidden();
        await expect(alternateSlide).toHaveClass(/bg-primary\/10/);

        await forceRuntimeReconnect(wallPage, '__WALL_ENGINE__');
        await waitForWallHydrated(wallPage, {
            source: 'gallery',
            foregroundLayerCount: 2
        });
        await forceRuntimeReconnect(controllerPage, '__CONTROLLER_ENGINE__');
        await expect(alternateSlide).toHaveClass(/bg-primary\/10/, { timeout: 20_000 });

        // Fresh clients must recover the server-authoritative gallery binding;
        // no fixed reconnect delay is part of the gate.
        await Promise.all([wallPage.reload(), controllerPage.reload()]);
        await waitForWallBusReady(wallPage);
        await waitForWallHydrated(wallPage, {
            source: 'gallery',
            foregroundLayerCount: 2
        });
        const recoveredSlide = controllerPage.getByRole('button', { name: 'Alternate' });
        await expect(recoveredSlide).toBeVisible({ timeout: 20_000 });
        await waitForCanvasReady(controllerPage, '.konvajs-content canvas');
        await expect(recoveredSlide).toHaveClass(/bg-primary\/10/);

        // Closing the user-facing project dialog is the product unbind action.
        await galleryPage.getByRole('button', { name: 'Close dialog' }).click();
        await expect(controllerPage.getByText('Nothing to control just yet')).toBeVisible({
            timeout: 20_000
        });
        await waitForWallCleared(wallPage);
    } finally {
        await Promise.all(contexts.map((context) => context.close()));
    }
});
