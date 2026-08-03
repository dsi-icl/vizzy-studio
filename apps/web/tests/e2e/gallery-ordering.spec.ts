import { expect, test } from 'playwright/test';

const orderedProjectNames = ['Gallery Alpha 2', 'gallery alpha 10', 'Harness Public Project'];

async function visibleOrderedProjectNames(page: import('playwright/test').Page) {
    const names = await page
        .locator('main button[aria-haspopup="dialog"]:visible')
        .allTextContents();
    return names
        .map((name) => name.trim())
        .filter((name) => orderedProjectNames.some((expected) => name.includes(expected)))
        .map((name) => orderedProjectNames.find((expected) => name.includes(expected)) ?? name);
}

test('gallery orders published projects case-insensitively with numeric segments', async ({
    page
}) => {
    await page.goto('/gallery');

    await expect
        .poll(() => visibleOrderedProjectNames(page), { timeout: 15_000 })
        .toEqual(orderedProjectNames);

    await page.getByRole('button', { name: 'order-regression', exact: true }).click();
    await expect
        .poll(() => visibleOrderedProjectNames(page), { timeout: 15_000 })
        .toEqual(orderedProjectNames);
});
