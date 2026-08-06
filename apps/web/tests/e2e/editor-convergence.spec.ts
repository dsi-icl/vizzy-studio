import { expect, test, type BrowserContext, type Locator, type Page } from 'playwright/test';

import {
    actorStorageState,
    forceRuntimeReconnect,
    readHarnessManifest,
    waitForCanvasReady,
    waitForFonts
} from '../support/harness';

async function prepareEditor(page: Page, path: string) {
    await page.goto(path);
    await expect(page.getByText('Loading slide...')).toBeHidden();
    await expect(page.getByText('Editable harness layer', { exact: true })).toBeVisible();
    await waitForFonts(page);
    await waitForCanvasReady(page, '#slate canvas');
    await expect
        .poll(
            () =>
                page.evaluate(
                    () =>
                        (
                            window as Window & {
                                __EDITOR_ENGINE__?: { connectionStatus: string };
                            }
                        ).__EDITOR_ENGINE__?.connectionStatus ?? null
                ),
            { timeout: 15_000, intervals: [25, 50, 100, 200] }
        )
        .toBe('connected');

    await page
        .getByRole('button', { name: 'Editable harness layer', exact: true })
        .getByText('Editable harness layer', { exact: true })
        .click();
    await page.getByRole('button', { name: 'Parameters' }).click();
    const x = page.getByRole('textbox', { name: 'X' });
    const y = page.getByRole('textbox', { name: 'Y' });
    return { x, y };
}

async function setNumberField(locator: Locator, value: string) {
    await locator.click();
    await locator.press('ControlOrMeta+A');
    await locator.pressSequentially(value);
    await locator.press('Enter');
}

test('two editors converge bidirectionally on authoritative layer updates', async ({ browser }) => {
    test.fail(
        true,
        'Known main-branch gap: keyboard transforms are not yet relayed and coalesced across editors.'
    );
    test.setTimeout(60_000);
    const manifest = readHarnessManifest();
    const contexts: BrowserContext[] = [];
    const path = `/quarry/editor/${manifest.fixtures.convergenceProjectId}/${manifest.fixtures.convergenceCommitId}/${manifest.fixtures.convergenceSlideId}`;

    const createEditorPage = async () => {
        const context = await browser.newContext({
            baseURL: manifest.baseUrl,
            storageState: actorStorageState('user_editor'),
            viewport: { width: 1440, height: 900 },
            deviceScaleFactor: 1,
            colorScheme: 'light',
            locale: 'en-GB',
            timezoneId: 'Europe/London',
            reducedMotion: 'reduce'
        });
        contexts.push(context);
        return context.newPage();
    };

    try {
        const [firstPage, secondPage] = await Promise.all([createEditorPage(), createEditorPage()]);
        const [first, second] = await Promise.all([
            prepareEditor(firstPage, path),
            prepareEditor(secondPage, path)
        ]);

        // Normalize the dedicated mutable scope through the product controls so
        // retries are independent of an earlier run's in-memory autosave state.
        await setNumberField(first.x, '550');
        await expect(first.x).toHaveValue('550');
        await expect(second.x).toHaveValue('550', { timeout: 15_000 });
        await setNumberField(first.y, '270');
        await expect(first.y).toHaveValue('270');
        await expect(second.y).toHaveValue('270', { timeout: 15_000 });

        await forceRuntimeReconnect(firstPage, '__EDITOR_ENGINE__');
        await expect(first.x).toHaveValue('550');
        await expect(first.y).toHaveValue('270');

        await firstPage.getByRole('button', { name: 'Parameters' }).focus();
        await firstPage.keyboard.press('ArrowRight');
        await expect(first.x).toHaveValue('630');
        await expect(second.x).toHaveValue('630', { timeout: 15_000 });

        await secondPage.getByRole('button', { name: 'Parameters' }).focus();
        await secondPage.keyboard.press('ArrowDown');
        await expect(second.y).toHaveValue('350');
        await expect(first.y).toHaveValue('350', { timeout: 15_000 });

        await firstPage.evaluate(() => {
            const harnessWindow = window as Window & {
                __EDITOR_ENGINE__?: {
                    sendJSON: (message: { type: string; origin?: string }) => void;
                };
                __HARNESS_KEYBOARD_UPSERT_COUNT__?: number;
            };
            const editorEngine = harnessWindow.__EDITOR_ENGINE__;
            if (!editorEngine) throw new Error('Editor engine was not available');
            const sendJSON = editorEngine.sendJSON;
            harnessWindow.__HARNESS_KEYBOARD_UPSERT_COUNT__ = 0;
            editorEngine.sendJSON = (message) => {
                if (message.type === 'upsert_layer' && message.origin === 'editor:keyboard_move') {
                    harnessWindow.__HARNESS_KEYBOARD_UPSERT_COUNT__ =
                        (harnessWindow.__HARNESS_KEYBOARD_UPSERT_COUNT__ ?? 0) + 1;
                }
                sendJSON(message);
            };
        });
        await firstPage.evaluate(() => {
            for (let index = 0; index < 20; index += 1) {
                window.dispatchEvent(
                    new KeyboardEvent('keydown', {
                        key: 'ArrowRight',
                        repeat: index > 0
                    })
                );
            }
            window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight' }));
        });

        await expect
            .poll(() =>
                firstPage.evaluate(
                    () =>
                        (
                            window as Window & {
                                __HARNESS_KEYBOARD_UPSERT_COUNT__?: number;
                            }
                        ).__HARNESS_KEYBOARD_UPSERT_COUNT__ ?? 0
                )
            )
            .toBe(1);
        await expect(first.x).toHaveValue('2,230');
        await expect(second.x).toHaveValue('2,230', { timeout: 15_000 });

        await setNumberField(first.x, '550');
        await expect(second.x).toHaveValue('550', { timeout: 15_000 });
        await setNumberField(first.y, '270');
        await expect(second.y).toHaveValue('270', { timeout: 15_000 });
    } finally {
        await Promise.all(contexts.map((context) => context.close()));
    }
});
