import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type BrowserContext, type Page } from 'playwright/test';

export interface HarnessActor {
    id: string;
    email: string;
    role: string;
    cookieHeader: string;
}

export interface HarnessDevice {
    deviceId: string;
    kind: 'wall' | 'controller' | 'gallery';
    status: 'active' | 'pending' | 'revoked';
    assignedWallId: string | null;
    privateKey: string;
    publicKey: string;
}

export interface HarnessManifest {
    baseUrl: string;
    actors: Record<string, HarnessActor>;
    fixtures: {
        wallId: string;
        privateProjectId: string;
        privateCommitId: string;
        privateSlideId: string;
        publicProjectId: string;
        publicCommitId: string;
        publicSlideId: string;
        renderingProjectId: string;
        renderingCommitId: string;
        renderingSlideId: string;
        editorProjectId: string;
        editorCommitId: string;
        editorSlideId: string;
        convergenceProjectId: string;
        convergenceCommitId: string;
        convergenceSlideId: string;
        webCaptureProjectId: string;
        webCaptureCommitId: string;
        webCaptureSlideId: string;
        externalCaptureUrl: string;
        mediaProjectId: string;
        mediaCommitId: string;
        mediaSlideId: string;
        interactionProjectId: string;
        interactionCommitId: string;
        interactionSlideId: string;
        customRenderProjectId: string;
        multiWallId: string;
        multiWallProjectId: string;
        multiWallCommitId: string;
        multiWallSlideId: string;
        galleryWallId: string;
        galleryAlternateSlideId: string;
        controllerWallId: string;
        ownershipWallId: string;
        mediaWallId: string;
    };
    devices: Record<string, HarnessDevice>;
}

const manifestPath = resolve(process.cwd(), 'apps/web/tests/.fixtures/seed-manifest.json');

export function readHarnessManifest(): HarnessManifest {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as HarnessManifest;
    return {
        ...manifest,
        baseUrl: process.env.TEST_BASE_URL || manifest.baseUrl
    };
}

export function actorStorageState(actor: 'user_admin' | 'user_editor' | 'user_viewer'): string {
    return resolve(process.cwd(), `apps/web/tests/.auth/${actor}.json`);
}

export async function waitForFonts(page: Page): Promise<void> {
    await page.evaluate(async () => {
        await document.fonts.ready;
    });
}

export async function waitForCanvasReady(page: Page, canvasSelector: string): Promise<void> {
    await expect
        .poll(
            async () => {
                return page.locator(canvasSelector).evaluateAll(
                    (canvases) =>
                        canvases.length > 0 &&
                        canvases.every((canvas) => {
                            const bounds = canvas.getBoundingClientRect();
                            return bounds.width > 0 && bounds.height > 0;
                        })
                );
            },
            { timeout: 15_000, intervals: [50, 100, 150, 250, 500] }
        )
        .toBe(true);

    await page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            })
    );
}

export async function waitForWallBusReady(page: Page): Promise<void> {
    await expect
        .poll(
            () =>
                page.evaluate(() =>
                    Boolean((window as Window & { __WALL_ENGINE__?: unknown }).__WALL_ENGINE__)
                ),
            { timeout: 10_000, intervals: [25, 50, 100, 200] }
        )
        .toBe(true);

    await page.evaluate(async () => {
        const engine = (
            window as Window & {
                __WALL_ENGINE__?: { onReady: (callback: () => void) => () => void };
            }
        ).__WALL_ENGINE__;
        if (!engine) throw new Error('Wall engine was not created');
        await new Promise<void>((resolve) => {
            engine.onReady(resolve);
        });
    });
}

export async function waitForWallHydrated(
    page: Page,
    input: { source: 'live' | 'gallery'; foregroundLayerCount: number }
): Promise<void> {
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const engine = (
                        window as Window & {
                            __WALL_ENGINE__?: {
                                boundSource?: 'live' | 'gallery';
                                layers: Map<number, unknown>;
                            };
                        }
                    ).__WALL_ENGINE__;
                    return {
                        source: engine?.boundSource ?? null,
                        foregroundLayerCount: engine?.layers.size ?? -1
                    };
                }),
            { timeout: 20_000, intervals: [50, 100, 200, 400, 800] }
        )
        .toEqual({
            source: input.source,
            foregroundLayerCount: input.foregroundLayerCount
        });

    await expect(page.locator('div.pointer-events-none.absolute.inset-0.bg-black')).toHaveCSS(
        'opacity',
        '0',
        { timeout: 15_000 }
    );
    await waitForFonts(page);
    await page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            })
    );
}

export async function readWallRuntimeState(page: Page): Promise<{
    source: 'live' | 'gallery' | null;
    foregroundLayerCount: number;
}> {
    return page.evaluate(() => {
        const engine = (
            window as Window & {
                __WALL_ENGINE__?: {
                    boundSource?: 'live' | 'gallery';
                    layers: Map<number, unknown>;
                };
            }
        ).__WALL_ENGINE__;
        return {
            source: engine?.boundSource ?? null,
            foregroundLayerCount: engine?.layers.size ?? -1
        };
    });
}

export async function waitForWallCleared(page: Page): Promise<void> {
    await expect
        .poll(() => readWallRuntimeState(page), {
            timeout: 20_000,
            intervals: [50, 100, 200, 400, 800]
        })
        .toEqual({ source: null, foregroundLayerCount: 0 });
}

export type RuntimeEngineKey =
    | '__EDITOR_ENGINE__'
    | '__WALL_ENGINE__'
    | '__CONTROLLER_ENGINE__'
    | '__GALLERY_ENGINE__';

/**
 * Close the current runtime socket as if the connection was interrupted, then
 * require the reconnecting client to replace it with an open socket. Product
 * state is asserted separately by the calling workflow after authentication
 * and scope recovery have completed.
 */
export async function forceRuntimeReconnect(
    page: Page,
    engineKey: RuntimeEngineKey
): Promise<void> {
    await page.evaluate((key) => {
        type HarnessEngine = {
            ws?: WebSocket;
            bus?: { ws: WebSocket; status: string };
            connectionStatus?: string;
        };
        const harnessWindow = window as unknown as Window & {
            __HARNESS_PREVIOUS_RUNTIME_SOCKET__?: WebSocket;
        } & Record<string, unknown>;
        const engine = harnessWindow[key] as HarnessEngine | undefined;
        const socket = engine?.ws ?? engine?.bus?.ws;
        if (!engine || !socket) throw new Error(`${key} runtime socket was not available`);
        harnessWindow.__HARNESS_PREVIOUS_RUNTIME_SOCKET__ = socket;
        socket.close(4100, 'Playwright forced reconnect');
    }, engineKey);

    await expect
        .poll(
            () =>
                page.evaluate((key) => {
                    type HarnessEngine = {
                        ws?: WebSocket;
                        bus?: { ws: WebSocket; status: string };
                        connectionStatus?: string;
                    };
                    const harnessWindow = window as unknown as Window & {
                        __HARNESS_PREVIOUS_RUNTIME_SOCKET__?: WebSocket;
                    } & Record<string, unknown>;
                    const engine = harnessWindow[key] as HarnessEngine | undefined;
                    const socket = engine?.ws ?? engine?.bus?.ws;
                    return {
                        connected:
                            (engine?.connectionStatus ?? engine?.bus?.status) === 'connected',
                        replaced:
                            Boolean(socket) &&
                            socket !== harnessWindow.__HARNESS_PREVIOUS_RUNTIME_SOCKET__,
                        open: socket?.readyState === WebSocket.OPEN
                    };
                }, engineKey),
            { timeout: 15_000, intervals: [25, 50, 100, 200, 400] }
        )
        .toEqual({ connected: true, replaced: true, open: true });

    await page.evaluate(() => {
        delete (window as Window & { __HARNESS_PREVIOUS_RUNTIME_SOCKET__?: WebSocket })
            .__HARNESS_PREVIOUS_RUNTIME_SOCKET__;
    });
}

export async function installDeviceIdentity(
    context: BrowserContext,
    input: {
        kind: 'wall' | 'controller' | 'gallery';
        device: HarnessDevice;
        wallId: string;
        col?: number;
        row?: number;
        display?: string;
    }
): Promise<void> {
    const col = input.col ?? 0;
    const row = input.row ?? 0;
    const display = (input.display ?? 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const suffix = display ? display.slice(0, 64) : 'default';
    const key = `vizzy_device_identity_${input.kind}_c${col}r${row}_${input.wallId}_${suffix}`;
    const value = JSON.stringify({
        v: 1,
        pub: JSON.parse(input.device.publicKey),
        priv: JSON.parse(input.device.privateKey)
    });

    await context.addInitScript(
        ({ storageKey, storageValue }) => {
            window.localStorage.setItem(storageKey, storageValue);
        },
        { storageKey: key, storageValue: value }
    );
}
