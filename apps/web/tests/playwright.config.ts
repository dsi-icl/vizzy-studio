import { env } from 'node:process';

import { defineConfig } from 'playwright/test';

const baseURL = env.TEST_BASE_URL || `http://localhost:${env.WEB_HOST_PORT ?? '3870'}`;

export default defineConfig({
    testDir: './e2e',
    outputDir: '../test-results',
    snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}-{platform}{ext}',
    timeout: 60_000,
    expect: {
        timeout: 10_000,
        toHaveScreenshot: {
            animations: 'disabled',
            caret: 'hide',
            maxDiffPixelRatio: 0.005,
            threshold: 0.2
        }
    },
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!env.CI,
    retries: env.CI ? 1 : 0,
    reporter: env.CI
        ? [['dot'], ['html', { open: 'never', outputFolder: '../playwright-report' }]]
        : [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]],
    use: {
        baseURL,
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        colorScheme: 'light',
        locale: 'en-GB',
        timezoneId: 'Europe/London',
        contextOptions: { reducedMotion: 'reduce' },
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    projects: [
        { name: 'chromium', use: { browserName: 'chromium' } },
        { name: 'firefox-smoke', grep: /@cross-browser/, use: { browserName: 'firefox' } },
        { name: 'webkit-smoke', grep: /@cross-browser/, use: { browserName: 'webkit' } },
        {
            name: 'webkit-touch',
            grep: /@webkit-touch/,
            use: {
                browserName: 'webkit',
                hasTouch: true,
                viewport: { width: 834, height: 1_194 }
            }
        }
    ]
});
