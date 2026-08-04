import { resolve } from 'node:path';

import { expect, type Locator, type Page, test } from 'playwright/test';

import { actorStorageState, readHarnessManifest, waitForFonts } from '../support/harness';

const TOOLBAR_SELECTION_HIGHLIGHT = 'lexical-toolbar-selection';
const screenshotStyle = resolve(process.cwd(), 'apps/web/tests/visual.css');

async function waitForLiveEditorSelection(page: Page, editor: Locator, expectedText: string) {
    await expect
        .poll(() =>
            editor.evaluate((root) => {
                const selection = window.getSelection();
                if (!selection || selection.isCollapsed || selection.rangeCount === 0) return '';
                const range = selection.getRangeAt(0);
                return root.contains(range.commonAncestorContainer) ? selection.toString() : '';
            })
        )
        .toBe(expectedText);

    // selectionchange is asynchronous. Let the toolbar's listener preserve the
    // range before the test transfers focus to a toolbar control.
    await page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            })
    );
}

async function hasToolbarSelectionHighlight(page: Page) {
    return page.evaluate((name) => {
        const editor = document.querySelector('[role="dialog"] [contenteditable="true"]');
        const highlight = CSS.highlights?.get(name);
        if (!editor || !highlight) return false;

        return Array.from(highlight).some((abstractRange) => {
            const range = abstractRange as Range;
            return (
                !range.collapsed &&
                editor.contains(range.commonAncestorContainer) &&
                range.toString() === 'Harness focus text'
            );
        });
    }, TOOLBAR_SELECTION_HIGHLIGHT);
}

async function resetEditorViewportScroll(page: Page, editor: Locator) {
    await editor.evaluate((root) => {
        let element: HTMLElement | null = root as HTMLElement;
        while (element) {
            element.scrollLeft = 0;
            element.scrollTop = 0;
            element = element.parentElement;
        }
    });
    await page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            })
    );
}

test.use({ storageState: actorStorageState('user_admin') });

test('colour and size inputs keep focus until an explicit valid commit @visual', async ({
    page
}, testInfo) => {
    const { toolbarProjectId, toolbarCommitId, toolbarSlideIds } = readHarnessManifest().fixtures;
    const toolbarSlideId = toolbarSlideIds[Math.min(testInfo.retry, toolbarSlideIds.length - 1)];
    await page.goto(`/quarry/editor/${toolbarProjectId}/${toolbarCommitId}/${toolbarSlideId}`);

    await expect(page.getByText('Loading slide...')).toBeHidden();
    await expect(page.getByText('Harness focus text', { exact: true })).toBeVisible();
    await page.getByText('Harness focus text', { exact: true }).click();
    await page.getByRole('button', { name: 'Edit text' }).click();

    const dialog = page.getByRole('dialog', { name: 'Edit Text Layer' });
    await expect(dialog.getByText('Edit Text Layer')).toBeVisible();
    const editor = dialog.locator('[contenteditable="true"]');
    await expect(editor).toContainText('Harness focus text');
    await editor.click();
    await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await waitForLiveEditorSelection(page, editor, 'Harness focus text');

    await dialog.locator('button[aria-label="Text Colour"]').click();
    const colourInput = page.getByRole('textbox', { name: 'Hex colour' });
    await colourInput.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await colourInput.pressSequentially('#abcdef', { delay: 160 });

    await expect(colourInput).toBeFocused();
    await expect(colourInput).toHaveValue('#abcdef');
    await expect(editor).toContainText('Harness focus text');
    await expect.poll(() => hasToolbarSelectionHighlight(page)).toBe(true);
    await waitForFonts(page);
    await resetEditorViewportScroll(page, editor);
    const dialogBox = await dialog.boundingBox();
    if (!dialogBox) throw new Error('Text editor dialog was not measurable');
    await expect(page).toHaveScreenshot('text-colour-input-selection.png', {
        clip: dialogBox,
        stylePath: screenshotStyle
    });

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
    await expect.poll(() => hasToolbarSelectionHighlight(page)).toBe(true);
    await resetEditorViewportScroll(page, editor);
    await expect(page).toHaveScreenshot('text-size-input-selection.png', {
        clip: dialogBox,
        stylePath: screenshotStyle
    });
    await sizeInput.pressSequentially('72');
    await expect(sizeInput).toHaveValue('72');
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
