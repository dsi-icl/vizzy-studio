import { readFileSync } from 'node:fs';

import { expect, test, type Browser, type BrowserContext, type Page } from 'playwright/test';

import {
    actorStorageState,
    installDeviceIdentity,
    readHarnessManifest,
    type HarnessDevice,
    type HarnessManifest
} from '../support/harness';

const PUBLIC_PROJECT = 'Harness Public Project';
const PRIVATE_PUBLISHED_PROJECT = 'Harness Private Published Project';

type GalleryRuntimeState = { wallId: string | null; isEnrolledDevice: boolean };
type StoredCookies = { cookies: Parameters<BrowserContext['addCookies']>[0] };

async function createGalleryContext(
    browser: Browser,
    manifest: HarnessManifest,
    options: { device?: HarnessDevice; storageState?: string } = {}
): Promise<BrowserContext> {
    const context = await browser.newContext({
        baseURL: manifest.baseUrl,
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        colorScheme: 'light',
        locale: 'en-GB',
        timezoneId: 'Europe/London',
        reducedMotion: 'reduce',
        ...(options.storageState ? { storageState: options.storageState } : {})
    });
    if (options.device) {
        await installDeviceIdentity(context, {
            kind: 'gallery',
            device: options.device,
            wallId: manifest.fixtures.galleryWallId
        });
    }
    return context;
}

/** The grid renders from the HTTP feed, so it settles independently of the device handshake. */
async function openGallery(page: Page, url: string): Promise<void> {
    await page.goto(url);
    await expect(page.getByText(PUBLIC_PROJECT, { exact: true }).first()).toBeVisible({
        timeout: 20_000
    });
    // The grid is server-rendered, so wait for the client store before interacting:
    // a click dispatched before hydration is swallowed by React's re-render.
    await expect
        .poll(
            () =>
                page.evaluate(() =>
                    Boolean((window as Window & { __GALLERY_STORE__?: unknown }).__GALLERY_STORE__)
                ),
            { timeout: 20_000, intervals: [25, 50, 100, 200, 400] }
        )
        .toBe(true);
}

async function readGalleryRuntimeState(page: Page): Promise<GalleryRuntimeState> {
    return page.evaluate(() => {
        const store = (
            window as Window & {
                __GALLERY_STORE__?: { getState: () => GalleryRuntimeState };
            }
        ).__GALLERY_STORE__;
        const state = store?.getState();
        return {
            wallId: state?.wallId ?? null,
            isEnrolledDevice: state?.isEnrolledDevice ?? false
        };
    });
}

async function expectEnrolled(page: Page, wallId: string): Promise<void> {
    await expect
        .poll(() => readGalleryRuntimeState(page), { timeout: 20_000 })
        .toEqual({
            wallId,
            isEnrolledDevice: true
        });
}

async function openCard(page: Page, projectName: string): Promise<void> {
    await page
        .locator('button[aria-haspopup="dialog"]')
        .filter({ hasText: projectName })
        .first()
        .click();
}

function loadButton(page: Page) {
    return page.getByRole('button', { name: 'Load project' });
}

/** Resolves to true when the server rejects the handshake outright. */
function waitForAuthDenied(page: Page, timeoutMs = 15_000): Promise<boolean> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        page.on('websocket', (socket) => {
            if (!new URL(socket.url()).pathname.endsWith('/bus')) return;
            socket.on('framereceived', ({ payload }) => {
                if (typeof payload !== 'string') return;
                try {
                    const message = JSON.parse(payload) as { type?: string };
                    if (message.type === 'auth_denied') {
                        clearTimeout(timer);
                        resolve(true);
                    }
                } catch {
                    // Non-protocol frames carry no handshake decision.
                }
            });
        });
    });
}

test('an anonymous enrolled device sees only public projects and binds its assigned wall', async ({
    browser
}) => {
    const manifest = readHarnessManifest();
    const context = await createGalleryContext(browser, manifest, {
        device: manifest.devices.dev_gallery_active
    });
    try {
        const page = await context.newPage();
        await openGallery(page, `/gallery?w=${manifest.fixtures.galleryWallId}&c=0&r=0`);
        await expectEnrolled(page, manifest.fixtures.galleryWallId);

        await expect(page.getByText(PRIVATE_PUBLISHED_PROJECT, { exact: true })).toHaveCount(0);

        await openCard(page, PUBLIC_PROJECT);
        await expect(loadButton(page)).toBeVisible();
        // The kiosk binds its assigned wall directly, so no picker is offered.
        await expect(page.getByText('Select a wall')).toHaveCount(0);
    } finally {
        await context.close();
    }
});

test('a signed-in collaborator on an enrolled device sees and can load its private published project', async ({
    browser
}) => {
    const manifest = readHarnessManifest();
    const context = await createGalleryContext(browser, manifest, {
        device: manifest.devices.dev_gallery_active,
        storageState: actorStorageState('user_editor')
    });
    try {
        const page = await context.newPage();
        await openGallery(page, `/gallery?w=${manifest.fixtures.galleryWallId}&c=0&r=0`);
        await expectEnrolled(page, manifest.fixtures.galleryWallId);

        // Signing in adds the viewer's own private work without removing the public demos.
        await expect(page.getByText(PUBLIC_PROJECT, { exact: true }).first()).toBeVisible();
        await expect(
            page.getByText(PRIVATE_PUBLISHED_PROJECT, { exact: true }).first()
        ).toBeVisible();

        await openCard(page, PRIVATE_PUBLISHED_PROJECT);
        await expect(loadButton(page)).toBeVisible();
    } finally {
        await context.close();
    }
});

test('a signed-in non-admin on a non-enrolled device cannot bind any wall', async ({ browser }) => {
    const manifest = readHarnessManifest();
    const context = await createGalleryContext(browser, manifest, {
        storageState: actorStorageState('user_editor')
    });
    try {
        const page = await context.newPage();
        await openGallery(page, `/gallery?w=${manifest.fixtures.galleryWallId}&c=0&r=0`);

        await expect
            .poll(async () => (await readGalleryRuntimeState(page)).isEnrolledDevice, {
                timeout: 15_000
            })
            .toBe(false);

        // The feed still carries their private project; only loading is withheld.
        await openCard(page, PRIVATE_PUBLISHED_PROJECT);
        await expect(loadButton(page)).toHaveCount(0);
    } finally {
        await context.close();
    }
});

test('an administrator on a non-enrolled device can choose an authorised wall', async ({
    browser
}) => {
    const manifest = readHarnessManifest();
    const context = await createGalleryContext(browser, manifest, {
        storageState: actorStorageState('user_admin')
    });
    try {
        const page = await context.newPage();
        // No ?w=, so there is no preset wall and the picker has to carry the selection.
        await openGallery(page, '/gallery');

        await openCard(page, PUBLIC_PROJECT);
        await expect(async () => {
            await loadButton(page).click();
            await expect(page.getByText('Select a wall')).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 30_000 });

        await expect(
            page.getByRole('button', { name: new RegExp('Test Gallery Wall') })
        ).toBeVisible();
    } finally {
        await context.close();
    }
});

test('a revoked gallery device is rejected and cannot bind or request controller access', async ({
    browser
}) => {
    const manifest = readHarnessManifest();
    const context = await createGalleryContext(browser, manifest, {
        device: manifest.devices.dev_gallery_revoked
    });
    try {
        const page = await context.newPage();
        const denied = waitForAuthDenied(page);
        await openGallery(page, `/gallery?w=${manifest.fixtures.galleryWallId}&c=0&r=0`);

        expect(await denied).toBe(true);
        await expect
            .poll(async () => (await readGalleryRuntimeState(page)).isEnrolledDevice, {
                timeout: 15_000
            })
            .toBe(false);

        // canBindWall gates loading and controller tokens together.
        await openCard(page, PUBLIC_PROJECT);
        await expect(loadButton(page)).toHaveCount(0);
    } finally {
        await context.close();
    }
});

test('logging out on an enrolled device replaces the document so the socket loses the session', async ({
    browser
}) => {
    test.setTimeout(90_000);
    const manifest = readHarnessManifest();
    const context = await createGalleryContext(browser, manifest, {
        device: manifest.devices.dev_gallery_active,
        // Signing out destroys this session, so it uses the disposable actor.
        storageState: actorStorageState('user_signout')
    });
    try {
        const page = await context.newPage();
        await openGallery(page, `/gallery?w=${manifest.fixtures.galleryWallId}&c=0&r=0`);
        await expectEnrolled(page, manifest.fixtures.galleryWallId);

        // Survives a client-side navigation but not a document replacement, which is the
        // only way the authenticated WebSocket can be torn down and re-handshaken.
        await page.evaluate(() => {
            (window as Window & { __SIGN_OUT_MARKER__?: boolean }).__SIGN_OUT_MARKER__ = true;
        });

        // Signing out destroys the session server side, so this test is not repeatable
        // against a used harness: re-run `bun run test:harness:prepare` first.
        const signOutTrigger = page.getByRole('button', { name: 'Log out' }).first();
        await expect(
            signOutTrigger,
            'user_signout session is spent; reseed the harness'
        ).toBeVisible({ timeout: 20_000 });

        const confirmSignOut = page.getByRole('button', { name: 'Log out', exact: true });
        await expect(async () => {
            await signOutTrigger.click();
            await expect(confirmSignOut).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 30_000 });
        await confirmSignOut.last().click();

        await page.waitForURL(/\/gallery\?.*w=test-wall-gallery/, { timeout: 20_000 });
        await expect(page.getByLabel('Log in')).toBeVisible({ timeout: 20_000 });

        const markerSurvived = await page.evaluate(
            () =>
                (window as Window & { __SIGN_OUT_MARKER__?: boolean }).__SIGN_OUT_MARKER__ === true
        );
        expect(markerSurvived).toBe(false);

        // The kiosk keeps working, now as an anonymous enrolled device.
        await expectEnrolled(page, manifest.fixtures.galleryWallId);
        await expect(page.getByText(PRIVATE_PUBLISHED_PROJECT, { exact: true })).toHaveCount(0);
    } finally {
        await context.close();
    }
});

test('a bind that never reaches the server is not reported as a successful load', async ({
    browser
}) => {
    const manifest = readHarnessManifest();
    const context = await createGalleryContext(browser, manifest, {
        device: manifest.devices.dev_gallery_active
    });
    try {
        const page = await context.newPage();
        await openGallery(page, `/gallery?w=${manifest.fixtures.galleryWallId}&c=0&r=0`);
        await expectEnrolled(page, manifest.fixtures.galleryWallId);

        // Stand in for a socket that has gone away: frames are accepted and dropped, so the
        // server never answers with wall_binding_changed.
        await page.evaluate(() => {
            const engine = (
                window as Window & { __GALLERY_ENGINE__?: { sendJSON: (data: unknown) => void } }
            ).__GALLERY_ENGINE__;
            if (!engine) throw new Error('Gallery engine was not created');
            engine.sendJSON = () => {};
        });

        await openCard(page, PUBLIC_PROJECT);
        await loadButton(page).click();

        await expect(page.getByText('Could not load project on wall')).toBeVisible({
            timeout: 20_000
        });
        await expect(page.getByText('Project loaded on wall')).toHaveCount(0);
    } finally {
        await context.close();
    }
});

test('switching sessions in one browser does not carry private projects across users', async ({
    browser
}) => {
    const manifest = readHarnessManifest();
    const context = await createGalleryContext(browser, manifest, {
        device: manifest.devices.dev_gallery_active,
        storageState: actorStorageState('user_editor')
    });
    try {
        const page = await context.newPage();
        await openGallery(page, `/gallery?w=${manifest.fixtures.galleryWallId}&c=0&r=0`);
        await expect(
            page.getByText(PRIVATE_PUBLISHED_PROJECT, { exact: true }).first()
        ).toBeVisible();

        // user_viewer is not on the private published project.
        const viewerState = JSON.parse(
            readFileSync(actorStorageState('user_viewer'), 'utf8')
        ) as StoredCookies;
        await context.clearCookies();
        await context.addCookies(viewerState.cookies);

        await page.reload();
        await expect(page.getByText(PUBLIC_PROJECT, { exact: true }).first()).toBeVisible({
            timeout: 20_000
        });
        await expect(page.getByText(PRIVATE_PUBLISHED_PROJECT, { exact: true })).toHaveCount(0);
    } finally {
        await context.close();
    }
});
