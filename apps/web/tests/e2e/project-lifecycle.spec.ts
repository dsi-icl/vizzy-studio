import { expect, test, type BrowserContext } from 'playwright/test';

import { actorStorageState, readHarnessManifest } from '../support/harness';

test.use({ storageState: actorStorageState('user_admin') });

test('create, publish, rename, and archive transitions update the public gallery', async ({
    browser,
    page: adminPage
}, testInfo) => {
    test.setTimeout(90_000);
    const manifest = readHarnessManifest();
    let guestContext: BrowserContext | null = null;
    const originalName = `Harness Lifecycle ${testInfo.retry}`;
    const renamedName = `${originalName} Renamed`;

    try {
        guestContext = await browser.newContext({
            baseURL: manifest.baseUrl,
            viewport: { width: 1440, height: 900 },
            deviceScaleFactor: 1,
            colorScheme: 'light',
            locale: 'en-GB',
            timezoneId: 'Europe/London',
            reducedMotion: 'reduce'
        });
        const galleryPage = await guestContext.newPage();

        await adminPage.goto('/quarry');
        const projectSearch = adminPage.getByPlaceholder('Search projects...');
        await expect(async () => {
            await projectSearch.fill('__harness_hydration_gate__');
            await expect(adminPage.getByText('No projects found')).toBeVisible({ timeout: 1_000 });
        }).toPass({ timeout: 10_000, intervals: [50, 100, 250] });
        await adminPage.getByRole('button', { name: 'New project' }).click();
        await expect(adminPage).toHaveURL('/quarry/projects/new');

        const createButton = adminPage.getByRole('button', { name: 'Create project' });
        const createNameInput = adminPage.getByLabel('Name / Full Title *');
        const createAuthorInput = adminPage.getByLabel('Author / Organisation *');
        const createDescriptionInput = adminPage.getByLabel('Description *');
        await createNameInput.fill(originalName);
        await createAuthorInput.fill('Harness Lifecycle Org');
        await createDescriptionInput.fill('Project created by the lifecycle browser test.');
        await adminPage.getByLabel('Visibility').selectOption('public');
        await expect(createNameInput).toHaveValue(originalName);
        await expect(createAuthorInput).toHaveValue('Harness Lifecycle Org');
        await expect(createDescriptionInput).toHaveValue(
            'Project created by the lifecycle browser test.'
        );
        await createButton.click();
        await expect(adminPage).toHaveURL(/\/quarry\/projects\/[0-9a-f]{24}$/);
        await expect(adminPage.getByText('Project created').last()).toBeVisible();
        const projectId = new URL(adminPage.url()).pathname.split('/').at(-1);
        if (!projectId) throw new Error('Created project ID was not present in the URL');

        await galleryPage.goto('/gallery');
        await expect(galleryPage.getByText(originalName, { exact: true })).toBeHidden();

        await adminPage.goto(`/quarry/projects/${projectId}/commits`);
        await adminPage.getByRole('button', { name: 'Edit stage' }).first().click();
        await expect(adminPage).toHaveURL(
            new RegExp(`/quarry/editor/${projectId}/[0-9a-f]{24}/[^/]+$`)
        );
        await expect(adminPage.getByText('Loading slide...')).toBeHidden();

        await adminPage.goto(`/quarry/projects/${projectId}/commits`);
        await expect(adminPage.getByText('HEAD', { exact: true })).toBeVisible();
        await adminPage.getByRole('button', { name: 'Publish', exact: true }).click();
        await expect(
            adminPage.getByRole('button', { name: 'Unpublish', exact: true })
        ).toBeVisible();
        await galleryPage.reload();
        await expect(galleryPage.getByText(originalName, { exact: true }).first()).toBeVisible({
            timeout: 20_000
        });

        await adminPage.getByRole('button', { name: 'Unpublish', exact: true }).click();
        await expect(adminPage.getByRole('button', { name: 'Publish', exact: true })).toBeVisible({
            timeout: 15_000
        });
        await galleryPage.reload();
        await expect(galleryPage.getByText(originalName, { exact: true })).toBeHidden({
            timeout: 20_000
        });

        await adminPage.getByRole('button', { name: 'Publish', exact: true }).click();
        await expect(adminPage.getByRole('button', { name: 'Unpublish', exact: true })).toBeVisible(
            { timeout: 15_000 }
        );
        await galleryPage.reload();
        await expect(galleryPage.getByText(originalName, { exact: true }).first()).toBeVisible({
            timeout: 20_000
        });

        await adminPage.goto(`/quarry/projects/${projectId}`);
        const nameInput = adminPage.getByLabel('Name / Full Title *');
        await expect(nameInput).toHaveValue(originalName);
        await nameInput.fill(renamedName);
        await adminPage.getByRole('button', { name: 'Save changes' }).click();
        await expect(adminPage.getByRole('heading', { name: renamedName })).toBeVisible({
            timeout: 15_000
        });
        await galleryPage.reload();
        await expect(galleryPage.getByText(renamedName, { exact: true }).first()).toBeVisible({
            timeout: 20_000
        });
        await expect(galleryPage.getByText(originalName, { exact: true })).toBeHidden();

        await adminPage.goto('/quarry');
        const projectRow = adminPage.getByRole('row').filter({ hasText: renamedName });
        await expect(projectRow).toBeVisible();
        await projectRow.getByRole('button').last().click();
        await adminPage.getByRole('menuitem', { name: 'Archive' }).click();
        await expect(adminPage.getByText('Project archived').last()).toBeVisible();
        await expect(projectRow).toBeHidden();
        await galleryPage.reload();
        await expect(galleryPage.getByText(renamedName, { exact: true })).toBeHidden({
            timeout: 20_000
        });
    } finally {
        await guestContext?.close();
    }
});
