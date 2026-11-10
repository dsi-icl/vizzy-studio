import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from 'playwright/test';

import { makeUniqueMediaLayerName } from '../../src/lib/mediaUtils';

interface SeedManifest {
    fixtures: {
        privateProjectId: string;
        privateCommitId: string;
        privateSlideId: string;
    };
}

function readManifest(): SeedManifest {
    const filePath = resolve(process.cwd(), 'apps/web/tests/.fixtures/seed-manifest.json');
    return JSON.parse(readFileSync(filePath, 'utf8')) as SeedManifest;
}

test.describe('media layer naming', () => {
    test('strips only the final file extension', () => {
        expect(makeUniqueMediaLayerName(' Launch.Final.PNG ', [])).toBe('Launch.Final');
        expect(makeUniqueMediaLayerName('README', [])).toBe('README');
        expect(makeUniqueMediaLayerName('.gitignore', [])).toBe('.gitignore');
    });

    test('compares against visible legacy labels', () => {
        expect(makeUniqueMediaLayerName('Image.png', [{ type: 'image' }])).toBe('Image 1');
        expect(makeUniqueMediaLayerName('Video.mp4', [{ type: 'video' }])).toBe('Video 1');
    });

    test('normalizes case and uses the first available suffix', () => {
        expect(
            makeUniqueMediaLayerName('photo.JPG', [
                { type: 'image', name: 'Photo' },
                { type: 'image', name: 'photo 1' },
                { type: 'image', name: 'PHOTO 2' }
            ])
        ).toBe('photo 3');
        expect(
            makeUniqueMediaLayerName('Still.png', [
                { type: 'image', name: 'Still' },
                { type: 'image', name: 'Still 2' }
            ])
        ).toBe('Still 1');
    });
});

test.describe('media asset persistence', () => {
    test.use({ storageState: 'apps/web/tests/.auth/user_editor.json' });

    test('image upload continues after closing the dialog and survives save and reload', async ({
        page
    }) => {
        const { privateProjectId, privateCommitId, privateSlideId } = readManifest().fixtures;
        const layerLabel = `Named.Asset.${randomUUID()}`;
        const originalFilename = `${layerLabel}.PNG`;
        const image = readFileSync(resolve(process.cwd(), 'apps/web/public/favicon-96x96.png'));
        let signalUploadStarted!: () => void;
        let continueUpload!: () => void;
        const uploadStarted = new Promise<void>((resolve) => (signalUploadStarted = resolve));
        const uploadCanContinue = new Promise<void>((resolve) => (continueUpload = resolve));
        await page.route('**/api/uploads/**', async (route) => {
            if (route.request().method() === 'PATCH') {
                signalUploadStarted();
                await uploadCanContinue;
            }
            await route.continue();
        });

        await page.goto(`/quarry/editor/${privateProjectId}/${privateCommitId}/${privateSlideId}`);
        await expect(page.getByRole('heading', { name: 'Layers' })).toBeVisible();
        await expect(page.locator('#titlebar')).toContainText('Harness Private Project');

        await page
            .getByRole('button', { name: 'Upload', exact: true })
            .or(page.getByRole('button', { name: 'Drop files or click to upload' }))
            .first()
            .click();
        const uploadDialog = page.getByRole('dialog');
        await expect(uploadDialog.getByText('Upload Assets', { exact: true })).toBeVisible();
        await expect(uploadDialog.locator('code')).toBeVisible();
        await uploadDialog.locator('input[type="file"]').setInputFiles({
            name: originalFilename,
            mimeType: 'image/png',
            buffer: image
        });
        try {
            await uploadStarted;
            await page.keyboard.press('Escape');
            await expect(uploadDialog).toBeHidden();
        } finally {
            continueUpload();
        }

        const assetCard = page.locator('[data-asset-id]').filter({ hasText: originalFilename });
        await expect(assetCard).toBeVisible({ timeout: 45_000 });
        await assetCard.click();
        await expect(page.getByText(layerLabel, { exact: true })).toBeVisible({
            timeout: 45_000
        });
        await expect(page.getByTitle(originalFilename, { exact: true })).toBeVisible({
            timeout: 45_000
        });

        await page.keyboard.press('Control+s');
        await expect(page.locator('#titlebar svg.text-green-500')).toBeVisible();

        await page.reload();
        await expect(page.getByText(layerLabel, { exact: true })).toBeVisible();
        await expect(page.getByTitle(originalFilename, { exact: true })).toBeVisible();
    });
});
