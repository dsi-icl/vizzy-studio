import { expect, test } from 'playwright/test';

test.use({ storageState: 'apps/web/tests/.auth/user_editor.json' });

test('editor preview follows a non-default stage aspect ratio', async ({ page }) => {
    await page.goto(
        '/quarry/editor/000000000000000000000101/000000000000000000000201/slide-private-1'
    );

    await expect(page).toHaveURL(/\/quarry\/editor\//);

    const renderedStages = page.locator('.konvajs-content');
    await expect(renderedStages).toHaveCount(2);

    const boxes = await renderedStages.evaluateAll((nodes) =>
        nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            return { width: rect.width, height: rect.height };
        })
    );
    const expectedAspectRatio = (3 * 1280) / (2 * 1024);

    expect(boxes[0].width / boxes[0].height).toBeCloseTo(expectedAspectRatio, 2);
    expect(boxes[1].width / boxes[1].height).toBeCloseTo(expectedAspectRatio, 2);
});
