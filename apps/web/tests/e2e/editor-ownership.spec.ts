import { expect, test, type BrowserContext, type Page } from 'playwright/test';

import {
    actorStorageState,
    installDeviceIdentity,
    readHarnessManifest,
    waitForCanvasReady,
    waitForWallBusReady,
    waitForWallCleared,
    waitForWallHydrated
} from '../support/harness';

test('editor takeover approval and last-editor disconnect hand ownership back to the gallery', async ({
    browser
}) => {
    test.setTimeout(90_000);
    const manifest = readHarnessManifest();
    const contexts: BrowserContext[] = [];
    let editorContext: BrowserContext | null = null;

    const createContext = async (storageState?: string) => {
        const context = await browser.newContext({
            baseURL: manifest.baseUrl,
            ...(storageState ? { storageState } : {}),
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

    const loadPublicProject = async (galleryPage: Page) => {
        await galleryPage
            .locator('button[aria-haspopup="dialog"]')
            .filter({ hasText: 'Harness Public Project' })
            .click();
        await galleryPage.getByRole('button', { name: 'Load project' }).click();
    };

    try {
        const wallContext = await createContext();
        await installDeviceIdentity(wallContext, {
            kind: 'wall',
            device: manifest.devices.dev_wall_ownership,
            wallId: manifest.fixtures.ownershipWallId
        });
        const wallPage = await wallContext.newPage();

        const controllerContext = await createContext();
        await installDeviceIdentity(controllerContext, {
            kind: 'controller',
            device: manifest.devices.dev_controller_ownership,
            wallId: manifest.fixtures.ownershipWallId
        });
        const controllerPage = await controllerContext.newPage();

        const galleryContext = await createContext();
        await installDeviceIdentity(galleryContext, {
            kind: 'gallery',
            device: manifest.devices.dev_gallery_ownership,
            wallId: manifest.fixtures.ownershipWallId
        });
        const galleryPage = await galleryContext.newPage();

        await Promise.all([
            wallPage.goto(`/wall?w=${manifest.fixtures.ownershipWallId}&c=0&r=0`),
            controllerPage.goto(`/controller?w=${manifest.fixtures.ownershipWallId}&c=0&r=0`),
            galleryPage.goto(`/gallery?w=${manifest.fixtures.ownershipWallId}&c=0&r=0&enroll`)
        ]);
        await waitForWallBusReady(wallPage);
        await expect(
            galleryPage.getByText('Harness Public Project', { exact: true }).first()
        ).toBeVisible();

        await galleryPage.evaluate((wallId) => {
            const engine = (
                window as Window & {
                    __GALLERY_ENGINE__?: { unbindWall: (targetWallId: string) => void };
                }
            ).__GALLERY_ENGINE__;
            if (!engine) throw new Error('Gallery engine was not ready');
            engine.unbindWall(wallId);
        }, manifest.fixtures.ownershipWallId);
        await waitForWallCleared(wallPage);

        await loadPublicProject(galleryPage);
        await waitForWallHydrated(wallPage, { source: 'gallery', foregroundLayerCount: 6 });
        await expect(
            controllerPage.getByRole('button', { name: 'Slide Rendering baseline' })
        ).toBeVisible({ timeout: 20_000 });

        editorContext = await createContext(actorStorageState('user_editor'));
        const editorPage = await editorContext.newPage();
        await editorPage.goto(
            `/quarry/editor/${manifest.fixtures.publicProjectId}/${manifest.fixtures.publicCommitId}/${manifest.fixtures.galleryAlternateSlideId}`
        );
        await expect(editorPage.getByText('Loading slide...')).toBeHidden();
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
                                targetWallId: string,
                                targetProjectId: string,
                                targetCommitId: string,
                                targetSlideId: string
                            ) => void;
                        };
                    }
                ).__EDITOR_ENGINE__;
                if (!engine) throw new Error('Editor engine was not ready');
                engine.bindWall(wallId, projectId, commitId, slideId);
            },
            {
                wallId: manifest.fixtures.ownershipWallId,
                projectId: manifest.fixtures.publicProjectId,
                commitId: manifest.fixtures.publicCommitId,
                slideId: manifest.fixtures.galleryAlternateSlideId
            }
        );

        await expect(galleryPage.getByText(/Takeover request from/)).toBeVisible({
            timeout: 15_000
        });
        await galleryPage.getByRole('button', { name: 'Approve' }).click();
        await waitForWallHydrated(wallPage, { source: 'live', foregroundLayerCount: 2 });

        // Abruptly closing the final editor socket exercises server-side ownership
        // cleanup, not the editor's explicit unbind or leave-scope controls.
        await editorContext.close();
        contexts.splice(contexts.indexOf(editorContext), 1);
        editorContext = null;

        await waitForWallCleared(wallPage);
        await expect(controllerPage.getByText('Nothing to control just yet')).toBeVisible({
            timeout: 20_000
        });

        await loadPublicProject(galleryPage);
        await waitForWallHydrated(wallPage, { source: 'gallery', foregroundLayerCount: 6 });
        await expect(
            controllerPage.getByRole('button', { name: 'Slide Rendering baseline' })
        ).toBeVisible({ timeout: 20_000 });

        await galleryPage.getByRole('button', { name: 'Close dialog' }).click();
        await waitForWallCleared(wallPage);
    } finally {
        await editorContext?.close();
        await Promise.all(contexts.map((context) => context.close()));
    }
});
