import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from 'playwright/test';

interface SeedManifest {
    fixtures: {
        privateProjectId: string;
        privateCommitId: string;
        privateSlideId: string;
    };
}

const TOOLBAR_SELECTION_HIGHLIGHT = 'lexical-toolbar-selection';

async function hasToolbarSelectionHighlight(page: import('playwright/test').Page) {
    return page.evaluate((name) => CSS.highlights?.has(name) ?? false, TOOLBAR_SELECTION_HIGHLIGHT);
}

function readManifest(): SeedManifest {
    return JSON.parse(
        readFileSync(resolve(process.cwd(), 'apps/web/tests/.fixtures/seed-manifest.json'), 'utf8')
    ) as SeedManifest;
}

test.use({ storageState: 'apps/web/tests/.auth/user_admin.json' });

test('colour and size inputs keep focus until an explicit valid commit', async ({ page }) => {
    const { privateProjectId, privateCommitId, privateSlideId } = readManifest().fixtures;
    await page.goto(`/quarry/editor/${privateProjectId}/${privateCommitId}/${privateSlideId}`);

    await page.getByText('Harness focus text', { exact: true }).click();
    await page.getByRole('button', { name: 'Edit text' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Edit Text Layer')).toBeVisible();
    const editor = dialog.locator('[contenteditable="true"]');
    await expect(editor).toContainText('Harness focus text');
    await editor.click();
    await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');

    await dialog.locator('button[aria-label="Text Colour"]').click();
    const colourInput = page.getByRole('textbox', { name: 'Hex colour' });
    await colourInput.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await colourInput.pressSequentially('#abcdef', { delay: 160 });

    await expect(colourInput).toBeFocused();
    await expect(colourInput).toHaveValue('#abcdef');
    await expect(editor).toContainText('Harness focus text');
    await expect.poll(() => hasToolbarSelectionHighlight(page)).toBe(true);

    await colourInput.press('Enter');
    await expect(colourInput).toBeHidden();
    await expect(editor).toBeFocused();
    await expect(editor).toContainText('Harness focus text');
    await expect.poll(() => hasToolbarSelectionHighlight(page)).toBe(false);

    const sizeInput = dialog.getByRole('spinbutton', { name: 'Font Size (virtual px)' });
    await sizeInput.fill('48');
    await expect(sizeInput).toBeFocused();
    await expect(editor).toContainText('Harness focus text');
    await expect.poll(() => hasToolbarSelectionHighlight(page)).toBe(true);

    await sizeInput.press('Tab');
    await expect(editor).toBeFocused();
    await expect(sizeInput).toHaveValue('48');
    await expect(editor).toContainText('Harness focus text');
    await expect.poll(() => hasToolbarSelectionHighlight(page)).toBe(false);

    await sizeInput.dblclick();
    await sizeInput.pressSequentially('72');
    await expect(sizeInput).toHaveValue('72');
    await expect.poll(() => hasToolbarSelectionHighlight(page)).toBe(true);
    await sizeInput.press('Enter');
    await expect(editor).toBeFocused();
    await expect(sizeInput).toHaveValue('72');

    await sizeInput.fill('9');
    await sizeInput.press('Tab');
    await expect(sizeInput).toBeFocused();
    await expect(sizeInput).toHaveAttribute('aria-invalid', 'true');
    await expect(editor).toContainText('Harness focus text');
    await expect.poll(() => hasToolbarSelectionHighlight(page)).toBe(true);
});
