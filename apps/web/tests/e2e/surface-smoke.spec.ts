import { expect, test } from 'playwright/test';

import { actorStorageState } from '../support/harness';

test('public gallery renders the published fixture', async ({ page }) => {
    await page.goto('/gallery');

    await expect(page).toHaveURL(/\/gallery/);
    await expect(page.getByText('Harness Public Project', { exact: true }).first()).toBeVisible();
});

test.describe('authenticated project surfaces', () => {
    test.use({ storageState: actorStorageState('user_editor') });

    test('project dashboard renders seeded projects', async ({ page }) => {
        await page.goto('/quarry');

        await expect(page).not.toHaveURL(/\/login/i);
        await expect(page.getByText('Harness Rendering Project', { exact: true })).toBeVisible();
        await expect(page.getByText('Harness Editor Project', { exact: true })).toBeVisible();
    });
});

test.describe('administration surfaces', () => {
    test.use({ storageState: actorStorageState('user_admin') });

    test('wall dashboard renders the seeded wall', async ({ page }) => {
        await page.goto('/admin/walls');

        await expect(page).not.toHaveURL(/\/login/i);
        await expect(page.getByText('Test Wall 1', { exact: true })).toBeVisible();
    });
});
