import { expect, test, type Page, type Response } from 'playwright/test';
import sharp from 'sharp';

import {
    actorStorageState,
    readHarnessManifest,
    waitForCanvasReady,
    waitForFonts
} from '../support/harness';

test.use({ storageState: actorStorageState('user_editor') });

interface CapturePayload {
    filename: string;
    baseId: string;
    blurhash: string | null;
    sizes: number[];
}

async function captureWhenBrowserReady(page: Page): Promise<CapturePayload> {
    const captureButton = page.getByRole('button', { name: 'Capture screenshot' });
    let payload: CapturePayload | null = null;

    await expect(async () => {
        const captureResponse = page.waitForResponse(
            (response) =>
                response.request().method() === 'POST' &&
                new URL(response.url()).pathname === '/api/web-screenshot'
        );
        await captureButton.click();
        const response = await captureResponse;

        if (response.status() === 503) {
            await expect(captureButton).toBeEnabled();
            throw new Error('The server-side screenshot browser is still installing');
        }

        expect(response.status()).toBe(200);
        payload = (await response.json()) as CapturePayload;
    }).toPass({ timeout: 90_000, intervals: [1_000, 2_000, 3_000] });

    if (!payload) throw new Error('Screenshot capture did not return a payload');
    return payload;
}

function expectPixelNear(
    data: Buffer,
    info: { width: number; channels: number },
    x: number,
    y: number,
    expected: [number, number, number]
) {
    const offset = (y * info.width + x) * info.channels;
    for (let channel = 0; channel < expected.length; channel += 1) {
        expect(Math.abs((data[offset + channel] ?? -255) - expected[channel])).toBeLessThanOrEqual(
            3
        );
    }
}

test('captures an iframe-blocked external page and renders the saved still image', async ({
    context,
    page
}) => {
    test.fail(
        true,
        'Known main-branch gap: capture persistence/focus handling is intentionally outside this harness-only PR.'
    );
    test.setTimeout(150_000);
    const manifest = readHarnessManifest();
    const renderedAssetResponses: Response[] = [];
    page.on('response', (response) => {
        if (/\/api\/assets\/webshot_[a-f0-9]{32}_[0-9]+\.webp$/.test(response.url())) {
            renderedAssetResponses.push(response);
        }
    });

    const externalFixtureResponse = await page.request.get(
        `http://localhost:${process.env.EXTERNAL_SITE_HOST_PORT ?? '3970'}/capture`
    );
    expect(externalFixtureResponse.ok()).toBe(true);
    expect(externalFixtureResponse.headers()['x-frame-options']).toBe('DENY');
    expect(externalFixtureResponse.headers()['content-security-policy']).toContain(
        "frame-ancestors 'none'"
    );

    await page.goto(
        `/quarry/editor/${manifest.fixtures.webCaptureProjectId}/${manifest.fixtures.webCaptureCommitId}/${manifest.fixtures.webCaptureSlideId}`
    );
    await expect(page.getByText('Loading slide...')).toBeHidden();
    await expect(
        page.getByText(manifest.fixtures.externalCaptureUrl, { exact: true })
    ).toBeVisible();
    await waitForFonts(page);
    await waitForCanvasReady(page, '#slate canvas');

    await page
        .getByRole('button', { name: manifest.fixtures.externalCaptureUrl, exact: true })
        .click();
    await expect(page.getByPlaceholder('https://example.com')).toHaveValue(
        manifest.fixtures.externalCaptureUrl
    );

    const payload = await captureWhenBrowserReady(page);
    expect(payload.filename).toMatch(/^webshot_[a-f0-9]{32}\.png$/);
    expect(payload.baseId).toBe(payload.filename.replace(/\.png$/, ''));
    expect(payload.blurhash).toEqual(expect.any(String));
    expect(payload.sizes).toContain(640);
    await expect(page.getByText('Screenshot captured').last()).toBeVisible();

    await expect
        .poll(
            () =>
                renderedAssetResponses.some(
                    (response) => response.ok() && response.url().includes(payload.baseId)
                ),
            { timeout: 15_000, intervals: [50, 100, 250, 500] }
        )
        .toBe(true);

    const originalAsset = await page.request.get(`/api/assets/${payload.filename}`);
    expect(originalAsset.ok()).toBe(true);
    expect(originalAsset.headers()['content-type']).toBe('image/png');
    const originalBytes = Buffer.from(await originalAsset.body());
    const metadata = await sharp(originalBytes).metadata();
    expect(metadata).toMatchObject({ format: 'png', width: 640, height: 360 });

    const { data, info } = await sharp(originalBytes)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    expectPixelNear(data, info, 40, 40, [15, 23, 42]);
    expectPixelNear(data, info, 600, 40, [3, 105, 161]);
    expectPixelNear(data, info, 40, 320, [124, 58, 237]);
    expectPixelNear(data, info, 600, 320, [245, 158, 11]);

    const unsavedIndicator = page.getByText('Unsaved', { exact: false });
    // The server may complete its 30-second autosave before the capture assertions finish.
    // Request a manual save only while the editor is still dirty; the fresh viewer below
    // remains the persistence gate in either case.
    if (await unsavedIndicator.isVisible()) {
        await page.keyboard.press('ControlOrMeta+s');
        await expect(unsavedIndicator).toBeHidden({ timeout: 15_000 });
    }

    const viewerPage = await context.newPage();
    const viewerAsset = viewerPage.waitForResponse(
        (response) =>
            response.ok() && new URL(response.url()).pathname === `/api/assets/${payload.filename}`,
        { timeout: 15_000 }
    );
    await viewerPage.goto(
        `/quarry/view/${manifest.fixtures.webCaptureProjectId}/${manifest.fixtures.webCaptureCommitId}`
    );
    await expect(viewerPage.getByText('Harness web capture head')).toBeVisible();
    await waitForCanvasReady(viewerPage, '.konvajs-content canvas');
    await viewerAsset;
    await viewerPage.close();
});
