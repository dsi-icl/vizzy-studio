import { expect, test } from 'playwright/test';

import {
    actorStorageState,
    readHarnessManifest,
    waitForCanvasReady,
    waitForFonts
} from '../support/harness';

test.use({ storageState: actorStorageState('user_editor') });

test.describe('editor workflow', () => {
    test('selects and moves a layer, marks the project dirty, and saves it', async ({ page }) => {
        const { fixtures } = readHarnessManifest();
        await page.goto(
            `/quarry/editor/${fixtures.editorProjectId}/${fixtures.editorCommitId}/${fixtures.editorSlideId}`
        );

        await expect(page.getByText('Loading slide...')).toBeHidden();
        await expect(page.getByText('Editable harness layer', { exact: true })).toBeVisible();
        await waitForFonts(page);
        await waitForCanvasReady(page, '#slate canvas');

        await page.getByRole('button', { name: 'Editable harness layer', exact: true }).click();
        await page.getByRole('button', { name: 'Parameters' }).click();
        const xPosition = page.getByRole('textbox', { name: 'X' });
        const yPosition = page.getByRole('textbox', { name: 'Y' });
        const readNumericValue = async (field: typeof xPosition) =>
            Number((await field.inputValue()).replaceAll(',', ''));
        const replaceNumericValue = async (field: typeof xPosition, value: number) => {
            await field.click();
            await field.press('ControlOrMeta+a');
            await field.pressSequentially(String(value));
            await field.press('Enter');
        };
        await expect(xPosition).not.toHaveValue('');
        await expect(yPosition).not.toHaveValue('');
        const initialX = await readNumericValue(xPosition);
        const initialY = await readNumericValue(yPosition);
        expect(Number.isFinite(initialX)).toBe(true);
        expect(Number.isFinite(initialY)).toBe(true);

        const nextX = initialX + 80;
        const nextY = initialY + 80;
        await replaceNumericValue(xPosition, nextX);
        await replaceNumericValue(yPosition, nextY);

        await expect(page.getByText('Unsaved', { exact: false })).toBeVisible();
        await expect.poll(() => readNumericValue(xPosition)).toBe(nextX);
        await expect.poll(() => readNumericValue(yPosition)).toBe(nextY);

        await page.locator('button[aria-label="Save project"]').click();
        await page.getByRole('button', { name: 'Save version' }).click();
        await expect(page.getByText('Unsaved', { exact: false })).toBeHidden({ timeout: 15_000 });
    });
});
