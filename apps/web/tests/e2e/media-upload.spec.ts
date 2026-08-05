import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

const VIDEO_FIXTURE_BASE64 =
    'AAAAJGZ0eXBpc29tAAACAGlzb21pc282aXNvMmF2YzFtcDQxAAAC7m1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAHwdHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAABAAAAAQAAAAAABjG1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAKAAAAAAAVcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAATdtaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAD3c3RibAAAAKtzdHNkAAAAAAAAAAEAAACbYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAABAAEAASAAAAEgAAAAAAAAAARVMYXZjNjIuMjguMTAyIGxpYngyNjQAAAAAAAAAAAAAABj//wAAADVhdmNDAWQACv/hABhnZAAKrNlEJsBEAAADAAQAAAMAKDxIllgBAAZo6+PLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjIuMTIuMTAyAAAAiG1vb2YAAAAQbWZoZAAAAAAAAAABAAAAcHRyYWYAAAAkdGZoZAAAADkAAAABAAAAAAAAAxIAAAgAAAAC3AEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAADB0cnVuAAAKBQAAAAMAAACQAgAAAAAAAtwAABAAAAAADgAAGAAAAAAMAAAIAAAAAv5tZGF0AAACrQYF//+p3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMyAwNDgwY2IwIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTIgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTUgc2NlbmVjdXQ9NDAgaW50cmFfcmVmc mVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAnZYiEABH//ufj/ApnYB8TeQWPh/ptdyoujXHtijNqS8fduEPbEZ/BAAAACkGaImxD//6pnTQAAAAIAZ5BeQ//BMUAAABDbWZyYQAAACt0ZnJhAQAAAAAAAAEAAAAAAAAAAQAAAAAAABAAAAAAAAAAAxIBAQEAAAAQbWZybwAAAAAAAABD'.replace(
        /\s/g,
        ''
    );

type UploadedLayer = {
    numericId: number;
    type: 'image' | 'video';
    url: string;
    stillImage?: string;
    duration?: number;
};

async function readUploadedLayer(
    page: Page,
    type: UploadedLayer['type']
): Promise<UploadedLayer | null> {
    return page.evaluate((layerType) => {
        const store = (
            window as Window & {
                __EDITOR_STORE__?: {
                    getState: () => {
                        layers: Map<number, UploadedLayer & { isUploading?: boolean }>;
                    };
                };
            }
        ).__EDITOR_STORE__;
        if (!store) throw new Error('Editor store was not ready');
        const layer = [...store.getState().layers.values()].find(
            (candidate) => candidate.type === layerType && !candidate.isUploading
        );
        if (!layer) return null;
        return {
            numericId: layer.numericId,
            type: layer.type,
            url: layer.url,
            stillImage: layer.stillImage,
            duration: layer.duration
        };
    }, type);
}

test.use({ storageState: actorStorageState('user_editor') });

test('uploads image and video assets, persists metadata, and renders media on a wall and fresh viewer', async ({
    browser,
    page: editorPage
}) => {
    test.fail(
        true,
        'Known main-branch gap: finalised upload layers do not yet converge into the live wall state.'
    );
    test.setTimeout(150_000);
    const manifest = readHarnessManifest();
    const contexts: BrowserContext[] = [];
    const editorPath = `/quarry/editor/${manifest.fixtures.mediaProjectId}/${manifest.fixtures.mediaCommitId}/${manifest.fixtures.mediaSlideId}`;
    const uploadRunId = Date.now().toString(36);
    const imageName = `harness-image-${uploadRunId}.png`;
    const videoName = `harness-video-${uploadRunId}.mp4`;

    try {
        await editorPage.goto(editorPath);
        await expect(editorPage.getByText('Loading slide...')).toBeHidden();
        await waitForCanvasReady(editorPage, '#slate canvas');

        // Retries inherit the first attempt's database state. Normalize the dedicated
        // media scope through the same store actions and save pipeline used by the UI.
        await editorPage.evaluate(() => {
            const store = (
                window as Window & {
                    __EDITOR_STORE__?: {
                        getState: () => {
                            layers: Map<number, { numericId: number }>;
                            removeLayer: (numericId: number) => void;
                        };
                    };
                }
            ).__EDITOR_STORE__;
            if (!store) throw new Error('Editor store was not ready');
            const state = store.getState();
            for (const layer of state.layers.values()) state.removeLayer(layer.numericId);
        });
        const dirtyIndicator = editorPage.getByText('Unsaved', { exact: false });
        if (await dirtyIndicator.isVisible()) {
            await editorPage.keyboard.press('ControlOrMeta+s');
            await expect(dirtyIndicator).toBeHidden({ timeout: 15_000 });
        }

        const fileInput = editorPage.locator('#titlebar input[type="file"]');
        await fileInput.setInputFiles({
            name: imageName,
            mimeType: 'image/png',
            buffer: readFileSync(resolve(process.cwd(), 'apps/web/public/favicon-96x96.png'))
        });
        await expect
            .poll(() => readUploadedLayer(editorPage, 'image'))
            .toMatchObject({
                type: 'image'
            });
        const imageLayer = await readUploadedLayer(editorPage, 'image');
        if (!imageLayer) throw new Error('Image upload did not produce a finalized layer');
        expect(imageLayer.url).toMatch(/\/api\/assets\/.+\.png$/);
        const imageResponse = await editorPage.context().request.get(imageLayer.url);
        expect(imageResponse.status()).toBe(200);
        expect(imageResponse.headers()['content-type']).toContain('image/png');

        await fileInput.setInputFiles({
            name: videoName,
            mimeType: 'video/mp4',
            buffer: Buffer.from(VIDEO_FIXTURE_BASE64, 'base64')
        });
        await expect
            .poll(() => readUploadedLayer(editorPage, 'video'), {
                timeout: 45_000,
                intervals: [100, 250, 500, 1_000]
            })
            .toMatchObject({
                type: 'video'
            });
        const videoLayer = await readUploadedLayer(editorPage, 'video');
        if (!videoLayer) throw new Error('Video upload did not produce a finalized layer');
        expect(videoLayer.url).toMatch(/\/api\/assets\/.+\.mp4$/);
        expect(videoLayer.stillImage).toMatch(/\.jpg$/);
        if (!videoLayer.stillImage) throw new Error('Video upload did not produce a poster');
        expect(videoLayer.duration).toBeGreaterThan(0);
        const videoResponse = await editorPage.context().request.get(videoLayer.url, {
            headers: { Range: 'bytes=0-127' }
        });
        expect(videoResponse.status()).toBe(206);
        expect(videoResponse.headers()['content-type']).toContain('video/mp4');

        const guestContext = await browser.newContext({
            baseURL: manifest.baseUrl,
            storageState: { cookies: [], origins: [] }
        });
        contexts.push(guestContext);
        expect(await guestContext.cookies()).toEqual([]);
        expect((await guestContext.request.get(imageLayer.url)).status()).toBe(404);
        expect((await guestContext.request.get(videoLayer.url)).status()).toBe(404);

        const wallContext = await browser.newContext({ baseURL: manifest.baseUrl });
        contexts.push(wallContext);
        await installDeviceIdentity(wallContext, {
            kind: 'wall',
            device: manifest.devices.dev_wall_media,
            wallId: manifest.fixtures.mediaWallId
        });
        const wallPage = await wallContext.newPage();
        await wallPage.goto(`/wall?w=${manifest.fixtures.mediaWallId}&c=0&r=0`);
        await waitForWallBusReady(wallPage);
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
                wallId: manifest.fixtures.mediaWallId,
                projectId: manifest.fixtures.mediaProjectId,
                commitId: manifest.fixtures.mediaCommitId,
                slideId: manifest.fixtures.mediaSlideId
            }
        );
        await waitForWallHydrated(wallPage, { source: 'live', foregroundLayerCount: 2 });
        await expect
            .poll(() =>
                wallPage.evaluate((numericId) => {
                    const layer = (
                        window as Window & {
                            __WALL_ENGINE__?: {
                                layers: Map<
                                    number,
                                    {
                                        type: string;
                                        duration?: number;
                                        stillImage?: string;
                                        el?: HTMLVideoElement;
                                    }
                                >;
                            };
                        }
                    ).__WALL_ENGINE__?.layers.get(numericId);
                    return (
                        layer?.type === 'video' &&
                        (layer.duration ?? 0) > 0 &&
                        Boolean(layer.stillImage) &&
                        (layer.el?.readyState ?? 0) >= HTMLMediaElement.HAVE_METADATA &&
                        Number.isFinite(layer.el?.duration) &&
                        (layer.el?.duration ?? 0) > 0
                    );
                }, videoLayer.numericId)
            )
            .toBe(true);

        await editorPage.evaluate((numericId) => {
            const engine = (
                window as Window & {
                    __EDITOR_ENGINE__?: {
                        sendJSON: (message: Record<string, unknown>) => void;
                    };
                }
            ).__EDITOR_ENGINE__;
            if (!engine) throw new Error('Editor engine was not ready');
            engine.sendJSON({ type: 'video_play', numericId, issuedAt: Date.now() });
        }, videoLayer.numericId);
        await expect
            .poll(() =>
                wallPage.evaluate(
                    (numericId) =>
                        (
                            window as Window & {
                                __WALL_ENGINE__?: {
                                    layers: Map<number, { playback?: { status: string } }>;
                                };
                            }
                        ).__WALL_ENGINE__?.layers.get(numericId)?.playback?.status ?? null,
                    videoLayer.numericId
                )
            )
            .toBe('playing');
        await editorPage.evaluate((numericId) => {
            const engine = (
                window as Window & {
                    __EDITOR_ENGINE__?: {
                        sendJSON: (message: Record<string, unknown>) => void;
                    };
                }
            ).__EDITOR_ENGINE__;
            if (!engine) throw new Error('Editor engine was not ready');
            engine.sendJSON({ type: 'video_pause', numericId, issuedAt: Date.now() });
        }, videoLayer.numericId);
        await expect
            .poll(() =>
                wallPage.evaluate(
                    (numericId) =>
                        (
                            window as Window & {
                                __WALL_ENGINE__?: {
                                    layers: Map<number, { playback?: { status: string } }>;
                                };
                            }
                        ).__WALL_ENGINE__?.layers.get(numericId)?.playback?.status ?? null,
                    videoLayer.numericId
                )
            )
            .toBe('paused');

        if (await dirtyIndicator.isVisible()) {
            await editorPage.keyboard.press('ControlOrMeta+s');
            await expect(dirtyIndicator).toBeHidden({ timeout: 15_000 });
        }

        const viewerContext = await browser.newContext({
            baseURL: manifest.baseUrl,
            storageState: actorStorageState('user_editor')
        });
        contexts.push(viewerContext);
        const viewerPage = await viewerContext.newPage();
        const posterUrl = new URL(`/api/assets/${videoLayer.stillImage}`, manifest.baseUrl).href;
        const imageLoaded = viewerPage.waitForResponse(
            (response) => response.url() === imageLayer.url && response.status() === 200,
            { timeout: 20_000 }
        );
        const videoPosterLoaded = viewerPage.waitForResponse(
            (response) => response.url() === posterUrl && response.status() === 200,
            { timeout: 20_000 }
        );
        await viewerPage.goto(
            `/quarry/view/${manifest.fixtures.mediaProjectId}/${manifest.fixtures.mediaCommitId}`
        );
        await Promise.all([imageLoaded, videoPosterLoaded]);
        await waitForCanvasReady(viewerPage, '.konvajs-content canvas');

        await editorPage.evaluate((wallId) => {
            const engine = (
                window as Window & {
                    __EDITOR_ENGINE__?: {
                        sendJSON: (message: Record<string, unknown>) => void;
                    };
                }
            ).__EDITOR_ENGINE__;
            if (!engine) throw new Error('Editor engine was not ready');
            engine.sendJSON({ type: 'unbind_wall', wallId });
        }, manifest.fixtures.mediaWallId);
        await waitForWallCleared(wallPage);

        // Return the dedicated project to an empty state, then remove the two
        // uploaded asset records through the project UI and require access revocation.
        await editorPage.evaluate(() => {
            const store = (
                window as Window & {
                    __EDITOR_STORE__?: {
                        getState: () => {
                            layers: Map<number, { numericId: number }>;
                            removeLayer: (numericId: number) => void;
                        };
                    };
                }
            ).__EDITOR_STORE__;
            if (!store) throw new Error('Editor store was not ready');
            const state = store.getState();
            for (const layer of state.layers.values()) state.removeLayer(layer.numericId);
        });
        await editorPage.keyboard.press('ControlOrMeta+s');
        await expect(dirtyIndicator).toBeHidden({ timeout: 15_000 });

        await editorPage.goto(`/quarry/projects/${manifest.fixtures.mediaProjectId}/assets`);
        const deleteAsset = async (name: string) => {
            const row = editorPage.getByRole('row').filter({ hasText: name });
            await expect(row).toBeVisible({ timeout: 15_000 });
            await row.getByTitle('Delete').click();
            await editorPage.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
            await expect(editorPage.getByText('Asset deleted').last()).toBeVisible();
            await expect(row).toBeHidden({ timeout: 15_000 });
        };
        await deleteAsset(imageName);
        await deleteAsset(videoName);

        expect((await editorPage.context().request.get(imageLayer.url)).status()).toBe(404);
        expect((await editorPage.context().request.get(videoLayer.url)).status()).toBe(404);
        if (videoLayer.stillImage) {
            expect((await editorPage.context().request.get(posterUrl)).status()).toBe(404);
        }
    } finally {
        await Promise.allSettled(contexts.map((context) => context.close()));
    }
});
