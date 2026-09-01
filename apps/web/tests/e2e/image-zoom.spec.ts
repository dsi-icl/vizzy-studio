import { expect, test } from 'playwright/test';

import {
    installDeviceIdentity,
    readHarnessManifest,
    waitForWallBusReady,
    waitForWallCleared,
    waitForWallHydrated
} from '../support/harness';

test('controller image zoom transforms the targeted bound image layer', async ({ browser }) => {
    test.setTimeout(60_000);
    const manifest = readHarnessManifest();
    const context = await browser.newContext({ baseURL: manifest.baseUrl });

    await installDeviceIdentity(context, {
        kind: 'wall',
        device: manifest.devices.dev_wall_gallery,
        wallId: manifest.fixtures.galleryWallId
    });
    await installDeviceIdentity(context, {
        kind: 'gallery',
        device: manifest.devices.dev_gallery_active,
        wallId: manifest.fixtures.galleryWallId
    });

    const wallPage = await context.newPage();
    const galleryPage = await context.newPage();

    try {
        await Promise.all([
            wallPage.goto(`/wall?w=${manifest.fixtures.galleryWallId}&c=0&r=0`),
            galleryPage.goto(`/gallery?w=${manifest.fixtures.galleryWallId}&c=0&r=0&enroll`)
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
        }, manifest.fixtures.galleryWallId);
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

        const controllerFrame = galleryPage.locator(
            'iframe[title="Controller for Harness Public Project"]'
        );
        await expect(controllerFrame).toBeVisible();
        const controllerUrl = await controllerFrame.getAttribute('src');
        if (!controllerUrl) throw new Error('Controller URL was not issued');
        const token = new URL(controllerUrl, manifest.baseUrl).searchParams.get('_gem_t');
        if (!token) throw new Error('Controller token was not issued');

        const before = await wallPage.evaluate(() => {
            type ImageLayer = {
                numericId: number;
                type: string;
                url: string;
                config: {
                    cx: number;
                    cy: number;
                    width: number;
                    height: number;
                    scaleX: number;
                    scaleY: number;
                };
            };
            const engine = (
                window as Window & {
                    __WALL_ENGINE__?: { layers: Map<number, ImageLayer> };
                }
            ).__WALL_ENGINE__;
            const layers = [...(engine?.layers.values() ?? [])];
            const layer = layers.find((candidate) => candidate.type === 'image');
            if (!layer) throw new Error('Image placeholder was not found');
            const nonImage = layers.find((candidate) => candidate.type !== 'image');
            if (!nonImage) throw new Error('Non-image layer was not found');
            return {
                numericId: layer.numericId,
                nonImageNumericId: nonImage.numericId,
                missingNumericId: Math.max(...layers.map((candidate) => candidate.numericId)) + 1,
                url: layer.url,
                ...layer.config
            };
        });

        const postZoom = (
            slideId: string,
            numericId: number,
            options: {
                requestToken?: string | null;
                body?: { scale: number; centerX: number; centerY: number };
            } = {}
        ) =>
            galleryPage.evaluate(
                async ({ requestToken, slideId, numericId, body }) => {
                    const headers: Record<string, string> = {
                        'Content-Type': 'application/json'
                    };
                    if (requestToken) headers.Authorization = `Bearer ${requestToken}`;

                    const response = await fetch(
                        `/api/portal/v1/slides/${encodeURIComponent(slideId)}/images/${numericId}/zoom`,
                        {
                            method: 'POST',
                            headers,
                            body: JSON.stringify(body)
                        }
                    );
                    const responseText = await response.text();
                    return {
                        status: response.status,
                        body: responseText
                            ? (JSON.parse(responseText) as Record<string, unknown>)
                            : null
                    };
                },
                {
                    requestToken: options.requestToken === undefined ? token : options.requestToken,
                    slideId,
                    numericId,
                    body: options.body ?? { scale: 2, centerX: 0.25, centerY: 0.75 }
                }
            );

        const missingTokenResult = await postZoom(
            manifest.fixtures.publicSlideId,
            before.numericId,
            { requestToken: null }
        );
        expect(missingTokenResult).toEqual({
            status: 401,
            body: { error: 'Missing bearer token' }
        });

        const invalidRequestResult = await postZoom(
            manifest.fixtures.publicSlideId,
            before.numericId,
            { body: { scale: 23, centerX: 0.5, centerY: 0.5 } }
        );
        expect(invalidRequestResult).toEqual({
            status: 400,
            body: { error: 'Invalid zoom request' }
        });

        const missingImageResult = await postZoom(
            manifest.fixtures.publicSlideId,
            before.missingNumericId
        );
        expect(missingImageResult).toEqual({ status: 204, body: null });

        const nonImageResult = await postZoom(
            manifest.fixtures.publicSlideId,
            before.nonImageNumericId
        );
        expect(nonImageResult).toEqual({ status: 204, body: null });

        const wrongSlideResult = await postZoom(
            manifest.fixtures.galleryAlternateSlideId,
            before.numericId
        );
        expect(wrongSlideResult).toEqual({
            status: 409,
            body: { error: 'Wall is no longer bound to the requested slide' }
        });

        const result = await postZoom(manifest.fixtures.publicSlideId, before.numericId);

        expect(result).toEqual({
            status: 200,
            body: { ok: true, numericId: before.numericId, scale: 2 }
        });
        await expect
            .poll(() =>
                wallPage.evaluate((numericId) => {
                    type ImageLayer = {
                        numericId: number;
                        url: string;
                        config: { cx: number; cy: number; scaleX: number; scaleY: number };
                    };
                    const engine = (
                        window as Window & {
                            __WALL_ENGINE__?: { layers: Map<number, ImageLayer> };
                        }
                    ).__WALL_ENGINE__;
                    const layer = engine?.layers.get(numericId);
                    return layer
                        ? {
                              url: layer.url,
                              cx: layer.config.cx,
                              cy: layer.config.cy,
                              scaleX: layer.config.scaleX,
                              scaleY: layer.config.scaleY
                          }
                        : null;
                }, before.numericId)
            )
            .toEqual({
                url: before.url,
                cx: before.cx + 0.5 * before.width * before.scaleX,
                cy: before.cy - 0.5 * before.height * before.scaleY,
                scaleX: before.scaleX * 2,
                scaleY: before.scaleY * 2
            });
    } finally {
        await galleryPage
            .evaluate((wallId) => {
                (
                    window as Window & {
                        __GALLERY_ENGINE__?: { unbindWall: (targetWallId: string) => void };
                    }
                ).__GALLERY_ENGINE__?.unbindWall(wallId);
            }, manifest.fixtures.galleryWallId)
            .catch(() => undefined);
        await context.close();
    }
});
