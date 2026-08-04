import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { test, type Page } from 'playwright/test';

import type { EditorEngine } from '../../src/lib/editorEngine';
import type { EditorStateCreator } from '../../src/lib/editorStore';
import type { GSMessage, Layer, LayerWithEditorState } from '../../src/lib/types';
import type { WallEngine } from '../../src/lib/wallEngine';

interface SeedManifest {
    baseUrl: string;
    fixtures: {
        wallId: string;
        privateProjectId: string;
        privateCommitId: string;
        privateSlideId: string;
        publicProjectId: string;
        publicCommitId: string;
        publicSlideId: string;
    };
    devices: Record<
        string,
        {
            privateKey: string;
            publicKey: string;
        }
    >;
}

type EditorWindow = Window & {
    __EDITOR_ENGINE__?: EditorEngine;
    __EDITOR_STORE__?: EditorStateCreator;
};

type WallWindow = Window & {
    __WALL_ENGINE__?: WallEngine;
    __LINE_ERASER_MESSAGES__?: GSMessage[];
};

const SAVE_RELOAD_LAYER_ID = 60_001;
const COLLABORATION_LAYER_ID = 60_002;
const originalLine = [0, 0, 100, 0];
const erasedLine = [
    [0, 0, 40, 0],
    [60, 0, 100, 0]
];

function readManifest(): SeedManifest {
    const filePath = resolve(process.cwd(), 'apps/web/tests/.fixtures/seed-manifest.json');
    return JSON.parse(readFileSync(filePath, 'utf8')) as SeedManifest;
}

function editorUrl(projectId: string, commitId: string, slideId: string): string {
    return `/quarry/editor/${projectId}/${commitId}/${slideId}`;
}

function makeLineLayer(numericId: number): LayerWithEditorState {
    return {
        numericId,
        type: 'line',
        config: {
            cx: 50,
            cy: 0,
            width: 100,
            height: 10,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            zIndex: numericId,
            visible: true
        },
        line: originalLine,
        strokeColor: '#ff0000',
        strokeWidth: 10,
        strokeDash: []
    };
}

async function waitForEditor(page: Page, slideId: string): Promise<void> {
    await page.waitForFunction((expectedSlideId) => {
        const state = (window as EditorWindow).__EDITOR_STORE__?.getState();
        return Boolean(
            state &&
            !state.loading &&
            state.activeSlideId === expectedSlideId &&
            state.connectionStatus === 'connected'
        );
    }, slideId);
}

async function waitForLine(page: Page, numericId: number, line: number[] | number[][]) {
    await page.waitForFunction(
        ({ expectedId, expectedLine }) => {
            const layer = (window as EditorWindow).__EDITOR_STORE__
                ?.getState()
                .layers.get(expectedId);
            return (
                layer?.type === 'line' &&
                JSON.stringify(layer.line) === JSON.stringify(expectedLine)
            );
        },
        { expectedId: numericId, expectedLine: line }
    );
}

async function seedLine(page: Page, layer: LayerWithEditorState): Promise<void> {
    await page.evaluate((nextLayer) => {
        const editorWindow = window as EditorWindow;
        editorWindow.__EDITOR_STORE__?.getState().upsertLayer(nextLayer);
        editorWindow.__EDITOR_ENGINE__?.sendJSON({
            type: 'upsert_layer',
            origin: 'editor:line_eraser_seed',
            layer: nextLayer
        });
    }, layer);
}

async function waitForServerLine(
    page: Page,
    numericId: number,
    line: number[] | number[][]
): Promise<void> {
    await page.evaluate(
        ({ expectedId, expectedLine }) =>
            new Promise<void>((resolvePromise, rejectPromise) => {
                const engine = (window as EditorWindow).__EDITOR_ENGINE__;
                if (!engine) {
                    rejectPromise(new Error('Editor engine is unavailable'));
                    return;
                }

                engine.clearBufferedHydration();
                let unsubscribe = () => {};
                const timeout = window.setTimeout(() => {
                    unsubscribe();
                    rejectPromise(new Error('Timed out waiting for server hydrate'));
                }, 10_000);

                unsubscribe = engine.subscribeToJson((message: GSMessage) => {
                    if (message.type !== 'hydrate') return;
                    const layer = message.layers.find(
                        (candidate: Layer) => candidate.numericId === expectedId
                    );
                    if (
                        layer?.type !== 'line' ||
                        JSON.stringify(layer.line) !== JSON.stringify(expectedLine)
                    ) {
                        return;
                    }

                    window.clearTimeout(timeout);
                    unsubscribe();
                    resolvePromise();
                });
                engine.sendJSON({ type: 'rehydrate_please' });
            }),
        { expectedId: numericId, expectedLine: line }
    );
}

async function commitErase(page: Page, numericId: number): Promise<void> {
    await page.evaluate(
        ({ id, line }) => {
            (window as EditorWindow).__EDITOR_STORE__?.getState().commitLineErase(id, line);
        },
        { id: numericId, line: erasedLine }
    );
}

async function removeTestLayer(page: Page, numericId: number): Promise<void> {
    await page.evaluate((id) => {
        const state = (window as EditorWindow).__EDITOR_STORE__?.getState();
        if (state?.layers.has(id)) state.removeLayer(id);
    }, numericId);
}

async function prepareWall(page: Page, manifest: SeedManifest): Promise<void> {
    const device = manifest.devices.dev_wall_active;
    if (!device) throw new Error('Active wall device is missing from the seed manifest');

    const storageKey = `vizzy_device_identity_wall_c0r0_${manifest.fixtures.wallId}_default`;
    await page.addInitScript(
        ({ key, identity }) => {
            window.localStorage.setItem(key, JSON.stringify(identity));
        },
        {
            key: storageKey,
            identity: {
                v: 1,
                pub: JSON.parse(device.publicKey),
                priv: JSON.parse(device.privateKey)
            }
        }
    );

    await page.goto(`/wall?w=${encodeURIComponent(manifest.fixtures.wallId)}&c=0&r=0`);
    await page.waitForFunction(() => Boolean((window as WallWindow).__WALL_ENGINE__));
    await page.evaluate(
        () =>
            new Promise<void>((resolvePromise, rejectPromise) => {
                const wallWindow = window as WallWindow;
                const engine = wallWindow.__WALL_ENGINE__;
                if (!engine) {
                    rejectPromise(new Error('Wall engine is unavailable'));
                    return;
                }

                wallWindow.__LINE_ERASER_MESSAGES__ = [];
                engine.subscribeToLayoutUpdates((message: GSMessage) => {
                    wallWindow.__LINE_ERASER_MESSAGES__?.push(message);
                });
                engine.onReady(resolvePromise);
            })
    );
}

async function bindWall(page: Page, manifest: SeedManifest): Promise<void> {
    await page.evaluate(
        ({ wallId, projectId, commitId, slideId }) => {
            const engine = (window as EditorWindow).__EDITOR_ENGINE__;
            if (!engine) throw new Error('Editor engine is unavailable');
            engine.bindWall(wallId, projectId, commitId, slideId);
        },
        {
            wallId: manifest.fixtures.wallId,
            projectId: manifest.fixtures.publicProjectId,
            commitId: manifest.fixtures.publicCommitId,
            slideId: manifest.fixtures.publicSlideId
        }
    );
}

async function waitForWallHydrate(page: Page, manifest: SeedManifest): Promise<void> {
    await page.waitForFunction(
        ({ projectId, commitId, slideId }) =>
            (window as WallWindow).__LINE_ERASER_MESSAGES__?.some(
                (message) =>
                    message.type === 'hydrate' &&
                    message.projectId === projectId &&
                    message.commitId === commitId &&
                    message.slideId === slideId
            ),
        {
            projectId: manifest.fixtures.publicProjectId,
            commitId: manifest.fixtures.publicCommitId,
            slideId: manifest.fixtures.publicSlideId
        }
    );
}

async function cleanUpCollaboration(page: Page, numericId: number): Promise<void> {
    if (page.isClosed()) return;
    try {
        await removeTestLayer(page, numericId);
    } catch (error) {
        if (!page.isClosed()) throw error;
    }
}

async function waitForWallLine(page: Page, numericId: number, line: number[] | number[][]) {
    await page.waitForFunction(
        ({ expectedId, expectedLine }) =>
            (window as WallWindow).__LINE_ERASER_MESSAGES__?.some(
                (message) =>
                    message.type === 'upsert_layer' &&
                    message.layer.numericId === expectedId &&
                    message.layer.type === 'line' &&
                    JSON.stringify(message.layer.line) === JSON.stringify(expectedLine)
            ),
        { expectedId: numericId, expectedLine: line }
    );
}

test.use({ storageState: 'apps/web/tests/.auth/user_editor.json' });
test.describe.configure({ mode: 'serial' });

test('erased line survives save and reload', async ({ page }) => {
    const manifest = readManifest();
    const { privateProjectId, privateCommitId, privateSlideId } = manifest.fixtures;
    const layer = makeLineLayer(SAVE_RELOAD_LAYER_ID);

    await page.goto(editorUrl(privateProjectId, privateCommitId, privateSlideId));
    await waitForEditor(page, privateSlideId);

    try {
        await seedLine(page, layer);
        await waitForServerLine(page, layer.numericId, originalLine);
        await commitErase(page, layer.numericId);
        await waitForServerLine(page, layer.numericId, erasedLine);

        await page.evaluate(() => {
            (window as EditorWindow).__EDITOR_STORE__?.getState().saveProject('Eraser E2E save');
        });
        await page.waitForFunction(
            () => (window as EditorWindow).__EDITOR_STORE__?.getState().saveStatus === 'saved'
        );

        await page.reload();
        await waitForEditor(page, privateSlideId);
        await waitForLine(page, layer.numericId, erasedLine);
    } finally {
        await removeTestLayer(page, layer.numericId);
    }
});

test('erased line reaches a second editor and the bound wall', async ({
    browser,
    context,
    page
}) => {
    const manifest = readManifest();
    const { publicProjectId, publicCommitId, publicSlideId } = manifest.fixtures;
    const url = editorUrl(publicProjectId, publicCommitId, publicSlideId);
    const layer = makeLineLayer(COLLABORATION_LAYER_ID);
    const secondEditor = await context.newPage();
    const wallContext = await browser.newContext({ baseURL: manifest.baseUrl });
    const wall = await wallContext.newPage();

    try {
        await Promise.all([page.goto(url), secondEditor.goto(url), prepareWall(wall, manifest)]);
        await Promise.all([
            waitForEditor(page, publicSlideId),
            waitForEditor(secondEditor, publicSlideId)
        ]);
        await bindWall(page, manifest);
        await waitForWallHydrate(wall, manifest);

        await seedLine(page, layer);
        await Promise.all([
            waitForLine(secondEditor, layer.numericId, originalLine),
            waitForWallLine(wall, layer.numericId, originalLine)
        ]);

        await commitErase(page, layer.numericId);
        await Promise.all([
            waitForLine(secondEditor, layer.numericId, erasedLine),
            waitForWallLine(wall, layer.numericId, erasedLine)
        ]);
    } finally {
        await cleanUpCollaboration(page, layer.numericId);
        await wallContext.close();
    }
});
