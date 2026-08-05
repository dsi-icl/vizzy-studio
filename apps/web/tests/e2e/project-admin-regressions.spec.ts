import { expect, test } from 'playwright/test';

import { actorStorageState, readHarnessManifest } from '../support/harness';

test.describe('custom-render project navigation', () => {
    test.use({ storageState: actorStorageState('user_editor') });

    test('keeps asset management available while stage history stays hidden', async ({ page }) => {
        const { fixtures } = readHarnessManifest();
        await page.goto(`/quarry/projects/${fixtures.customRenderProjectId}`);

        await expect(page.getByRole('tab', { name: 'Assets' })).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Stages' })).toHaveCount(0);
        await page.getByRole('tab', { name: 'Assets' }).click();
        await expect(page).toHaveURL(
            new RegExp(`/quarry/projects/${fixtures.customRenderProjectId}/assets$`)
        );
        await expect(page.getByRole('heading', { name: 'Project Media' })).toBeVisible();
        await page.getByText('Upload assets', { exact: true }).click();
        await expect(
            page.getByRole('dialog').getByText('Upload Assets', { exact: true })
        ).toBeVisible();
        await expect(page.getByRole('dialog').locator('input[type="file"]')).toHaveCount(1);
    });
});

test.describe('wall administration form', () => {
    test.use({ storageState: actorStorageState('user_admin') });

    test('reacts to trimmed input, creates one wall, and resets', async ({ page }) => {
        const wallSlug = `harness-created-${Date.now().toString(36)}`;
        await page.goto('/admin/walls');

        const input = page.getByRole('textbox', { name: 'Wall Slug' });
        const addButton = page.getByRole('button', { name: 'Add Wall' });
        await expect(addButton).toBeDisabled();
        await input.fill('   ');
        await expect(addButton).toBeDisabled();
        await input.fill(wallSlug);
        await expect(addButton).toBeEnabled();
        await addButton.click();

        await expect(page.getByText('Wall created').last()).toBeVisible();
        const createdWallRow = page.getByRole('row').filter({ hasText: wallSlug });
        await expect(createdWallRow).toHaveCount(1);
        await expect(createdWallRow).toBeVisible();
        await expect(input).toHaveValue('');
        await expect(addButton).toBeDisabled();
    });
});
