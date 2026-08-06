import { expect, test, type BrowserContext, type Locator, type Page } from 'playwright/test';

import { actorStorageState, readHarnessManifest, waitForFonts } from '../support/harness';

const LOADING_TEXT = 'Loading text…';
const UNAVAILABLE_TEXT = 'Text could not be loaded.';

/**
 * Below the 15s hydration timeout, so a document that never syncs fails this
 * wait rather than silently flipping to the error state first.
 */
const HYDRATION_TIMEOUT_MS = 14_000;

async function openSlide(page: Page, path: string): Promise<void> {
    await page.goto(path);
    await expect(page.getByText('Loading slide...')).toBeHidden();
    await waitForFonts(page);
}

function textEditorDialog(page: Page): Locator {
    return page.getByRole('dialog', { name: 'Edit Text Layer' });
}

/** Wait for the overlay to clear, which only happens once the document syncs. */
async function expectHydrated(dialog: Locator): Promise<void> {
    await expect(dialog.getByText(LOADING_TEXT)).toBeHidden({ timeout: HYDRATION_TIMEOUT_MS });
    await expect(dialog.getByText(UNAVAILABLE_TEXT)).toBeHidden();
}

test.use({ storageState: actorStorageState('user_admin') });

test('an existing text layer hydrates and clears its loading overlay', async ({ page }) => {
    const { toolbarProjectId, toolbarCommitId, toolbarSlideIds } = readHarnessManifest().fixtures;
    await openSlide(
        page,
        `/quarry/editor/${toolbarProjectId}/${toolbarCommitId}/${toolbarSlideIds[0]}`
    );

    await expect(page.getByText('Harness focus text', { exact: true })).toBeVisible();
    await page.getByText('Harness focus text', { exact: true }).click();
    await page.getByRole('button', { name: 'Edit text' }).click();

    const dialog = textEditorDialog(page);
    await expect(dialog).toBeVisible();
    await expectHydrated(dialog);

    // The seeded content is only present once the Yjs document has synced.
    await expect(dialog.locator('[contenteditable="true"]')).toContainText('Harness focus text');
});

test('a newly created text layer hydrates without waiting for autosave', async ({ page }) => {
    const { editorProjectId, editorCommitId, editorSlideId } = readHarnessManifest().fixtures;
    await openSlide(page, `/quarry/editor/${editorProjectId}/${editorCommitId}/${editorSlideId}`);

    // Creating a layer selects it, so the toolbar acts on the new layer.
    await page.getByRole('button', { name: 'Add text layer' }).click();
    await page.getByRole('button', { name: 'Edit text' }).click();

    const dialog = textEditorDialog(page);
    await expect(dialog).toBeVisible();

    // Regression guard: the layer used to reach the commit only on the 30s
    // autosave tick, so the Yjs session could not find it and this overlay
    // stayed up until it timed out into its error state.
    await expectHydrated(dialog);
    await expect(dialog.locator('[contenteditable="true"]')).toContainText('New Text');
});

test('two editors share one text document', async ({ browser }) => {
    test.setTimeout(90_000);
    const manifest = readHarnessManifest();
    const { convergenceProjectId, convergenceCommitId, convergenceSlideId } = manifest.fixtures;
    const path = `/quarry/editor/${convergenceProjectId}/${convergenceCommitId}/${convergenceSlideId}`;
    const contexts: BrowserContext[] = [];

    const openEditor = async () => {
        const context = await browser.newContext({
            baseURL: manifest.baseUrl,
            storageState: actorStorageState('user_editor'),
            viewport: { width: 1440, height: 900 },
            locale: 'en-GB',
            timezoneId: 'Europe/London',
            reducedMotion: 'reduce'
        });
        contexts.push(context);
        const page = await context.newPage();

        await openSlide(page, path);
        await expect(page.getByText('Editable harness layer', { exact: true })).toBeVisible();
        await page.getByText('Editable harness layer', { exact: true }).click();
        await page.getByRole('button', { name: 'Edit text' }).click();

        const dialog = textEditorDialog(page);
        await expect(dialog).toBeVisible();
        await expectHydrated(dialog);
        return dialog.locator('[contenteditable="true"]');
    };

    try {
        // Sequential rather than concurrent: the second editor must join a
        // document the first already published, which is the case that used to
        // hand back a half-built document.
        const first = await openEditor();
        const second = await openEditor();

        const marker = `sync-${Date.now()}`;
        await first.click();
        await first.pressSequentially(` ${marker}`);

        await expect(second).toContainText(marker, { timeout: 20_000 });
    } finally {
        await Promise.all(contexts.map((context) => context.close()));
    }
});
