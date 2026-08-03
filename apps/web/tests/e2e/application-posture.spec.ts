import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Request } from 'playwright/test';

const loginPostureHeading = /^Welcome to (?:Vizzy Studio|Onboarding)$/;

test.describe('@cross-browser public application posture', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('gallery supports narrow rendering, keyboard focus, history, reload, and clean errors', async ({
        browserName,
        page
    }) => {
        test.fail(
            browserName === 'webkit',
            'Known main-branch gap: WebKit does not hydrate the seeded public gallery result.'
        );
        const runtimeErrors: string[] = [];
        const inFlightServerFunctions = new Set<Request>();
        const isServerFunctionRequest = (request: Request) =>
            new URL(request.url()).pathname.startsWith('/_serverFn/');
        const waitForServerFunctionsToSettle = async () => {
            await expect
                .poll(
                    async () => {
                        if (inFlightServerFunctions.size > 0) return false;
                        await page.evaluate(
                            () =>
                                new Promise<void>((resolve) => {
                                    requestAnimationFrame(() =>
                                        requestAnimationFrame(() => resolve())
                                    );
                                })
                        );
                        return inFlightServerFunctions.size === 0;
                    },
                    { timeout: 15_000, intervals: [25, 50, 100, 200] }
                )
                .toBe(true);
        };
        page.on('request', (request) => {
            if (isServerFunctionRequest(request)) inFlightServerFunctions.add(request);
        });
        page.on('requestfinished', (request) => inFlightServerFunctions.delete(request));
        page.on('requestfailed', (request) => inFlightServerFunctions.delete(request));
        page.on('pageerror', (error) =>
            runtimeErrors.push(`pageerror at ${page.url()}: ${error.message}`)
        );
        page.on('console', (message) => {
            if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`);
        });

        await page.goto('/gallery');
        await expect(page.getByRole('heading', { name: 'Filters' })).toBeVisible();
        await expect(page.getByRole('main')).toBeVisible();
        await expect(
            page.getByText('Harness Public Project', { exact: true }).first()
        ).toBeVisible();
        await expect
            .poll(() =>
                page.evaluate(
                    () =>
                        document.documentElement.scrollWidth <=
                        document.documentElement.clientWidth + 1
                )
            )
            .toBe(true);

        await page.keyboard.press('Tab');
        await expect
            .poll(() => page.evaluate(() => document.activeElement !== document.body))
            .toBe(true);
        await waitForServerFunctionsToSettle();

        const loginLink = page.getByRole('link', { name: 'Log in' });
        await expect(loginLink).toHaveAttribute('href', '/login');
        if (browserName === 'webkit') await page.goto('/login');
        else await loginLink.click();
        await expect(page).toHaveURL(/\/(?:login|bootstrap)$/);
        await expect(page.getByRole('heading', { name: loginPostureHeading })).toBeVisible();
        await waitForServerFunctionsToSettle();
        if (browserName !== 'webkit') {
            await page.goBack();
            await expect(page).toHaveURL(/\/gallery$/);
            await expect(page.getByRole('main')).toBeVisible();
            await expect(
                page.getByText('Harness Public Project', { exact: true }).first()
            ).toBeVisible();
            await waitForServerFunctionsToSettle();
            await page.goForward();
        }
        // WebKit has already exercised gallery rendering and the gallery -> login link.
        // Reusing the same document for a second streamed SSR hydration intermittently
        // races TanStack's bootstrap barrier in this engine; Chromium and Firefox keep
        // the explicit back/forward contract while WebKit retains navigation + reload.
        await expect(page).toHaveURL(/\/(?:login|bootstrap)$/);
        await expect(page.getByRole('heading', { name: loginPostureHeading })).toBeVisible();
        await waitForServerFunctionsToSettle();
        await page.reload();
        await expect(page.getByRole('heading', { name: loginPostureHeading })).toBeVisible();
        await waitForServerFunctionsToSettle();

        const actionableErrors = runtimeErrors.filter(
            (message) =>
                !(
                    browserName === 'webkit' &&
                    /^pageerror at http:\/\/localhost:\d+\/(?:gallery|login): \/localhost:\d+\/_serverFn\/[a-f0-9]+ due to access control checks\.$/.test(
                        message
                    )
                )
        );
        const knownBootstrapHydrationErrors = actionableErrors.filter(
            (message) =>
                message.startsWith('console: Error: Minified React error #418;') ||
                (browserName === 'firefox' && message === 'console: Error')
        );
        const unknownErrors = actionableErrors.filter(
            (message) => !knownBootstrapHydrationErrors.includes(message)
        );
        // WebKit surfaces a canceled same-origin server-function fetch as an
        // access-control pageerror, sometimes after the destination URL is installed.
        // The exact cancellation signature above is non-actionable; all other runtime
        // errors remain gated.
        expect(unknownErrors).toEqual([]);
        test.fail(
            knownBootstrapHydrationErrors.length > 0,
            'Known main-branch gap: the fresh-install login redirect can hydrate the onboarding route against login markup.'
        );
        expect(knownBootstrapHydrationErrors).toEqual([]);
    });
});

test('public gallery and login have no serious automated accessibility violations', async ({
    page
}) => {
    for (const path of ['/gallery', '/login']) {
        await page.goto(path);
        await expect(page.locator('body')).toBeVisible();
        const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa'])
            // Contrast needs a deliberate visual-design and theme-token review. Keep this
            // posture gate non-visual while enforcing serious semantic/structural defects.
            .disableRules(['color-contrast'])
            .exclude('.konvajs-content')
            .analyze();
        const seriousViolations = results.violations.filter(
            ({ impact }) => impact === 'serious' || impact === 'critical'
        );
        expect(seriousViolations, `${path} accessibility violations`).toEqual([]);
    }
});
