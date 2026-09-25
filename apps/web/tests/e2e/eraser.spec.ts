import { expect, test, type BrowserContext, type Page } from 'playwright/test';

import {
    actorStorageState,
    installDeviceIdentity,
    readHarnessManifest,
    waitForWallBusReady,
    waitForWallHydrated
} from '../support/harness';

type EditorWindow = Window & {
    __EDITOR_STORE__?: {
        getState: () => {
            layers: Map<number, { linePaths?: number[][] }>;
            selectedLayerIds: string[];
            addLineLayer: (line: number[]) => void;
            commitLineErase: (numericId: number, paths: number[][]) => void;
            removeLayer: (numericId: number) => void;
        };
    };
    __EDITOR_ENGINE__?: {
        bindWall: (wallId: string, projectId: string, commitId: string, slideId: string) => void;
        unbindWall: () => void;
    };
};
type WallWindow = Window & {
    __WALL_ENGINE__?: { layers: Map<number, { linePaths?: number[][] }> };
};

const LINE_PATHS = [
    [160, 360, 500, 360],
    [620, 360, 1120, 360]
];

test.use({ storageState: actorStorageState('user_editor') });

async function save(page: Page) {
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByText('Unsaved', { exact: false })).toBeHidden({ timeout: 15_000 });
}

async function openEditor(page: Page, path: string) {
    await page.goto(path);
    await expect(page.getByText('Loading slide...')).toBeHidden();
}

async function addLine(page: Page) {
    return page.evaluate(() => {
        const store = (window as EditorWindow).__EDITOR_STORE__;
        if (!store) throw new Error('Editor store was not ready');
        store.getState().addLineLayer([160, 360, 1120, 360]);
        return Number(store.getState().selectedLayerIds[0]);
    });
}

async function eraseLine(page: Page, numericId: number) {
    await page.evaluate(
        ({ id, paths }) =>
            (window as EditorWindow).__EDITOR_STORE__?.getState().commitLineErase(id, paths),
        { id: numericId, paths: LINE_PATHS }
    );
}

async function removeLine(page: Page, numericId: number) {
    await page.evaluate(
        (id) => (window as EditorWindow).__EDITOR_STORE__?.getState().removeLayer(id),
        numericId
    );
    await save(page);
}

async function readEditorLinePaths(page: Page, numericId: number) {
    return page.evaluate(
        (id) =>
            (window as EditorWindow).__EDITOR_STORE__?.getState().layers.get(id)?.linePaths ?? null,
        numericId
    );
}

async function readWallLinePaths(page: Page, numericId: number) {
    return page.evaluate(
        (id) => (window as WallWindow).__WALL_ENGINE__?.layers.get(id)?.linePaths ?? null,
        numericId
    );
}

test('an erased line survives save and reload', async ({ page }) => {
    const { fixtures } = readHarnessManifest();
    const path = `/quarry/editor/${fixtures.editorProjectId}/${fixtures.editorCommitId}/${fixtures.editorSlideId}`;
    await openEditor(page, path);

    const lineId = await addLine(page);
    await eraseLine(page, lineId);

    await expect(page.getByText('Unsaved', { exact: false })).toBeVisible();
    await save(page);
    await page.reload();
    await expect(page.getByText('Loading slide...')).toBeHidden();

    await expect.poll(() => readEditorLinePaths(page, lineId)).toEqual(LINE_PATHS);

    await removeLine(page, lineId);
});

test('an erased line reaches a second editor and bound wall', async ({ browser, page }) => {
    test.setTimeout(60_000);
    const manifest = readHarnessManifest();
    const path = `/quarry/editor/${manifest.fixtures.convergenceProjectId}/${manifest.fixtures.convergenceCommitId}/${manifest.fixtures.convergenceSlideId}`;
    let secondEditorContext: BrowserContext | null = null;
    let wallContext: BrowserContext | null = null;
    let lineId: number | null = null;

    try {
        secondEditorContext = await browser.newContext({
            baseURL: manifest.baseUrl,
            storageState: actorStorageState('user_editor')
        });
        const secondEditor = await secondEditorContext.newPage();
        await Promise.all([openEditor(page, path), openEditor(secondEditor, path)]);

        const createdLineId = await addLine(page);
        lineId = createdLineId;

        wallContext = await browser.newContext({ baseURL: manifest.baseUrl });
        await installDeviceIdentity(wallContext, {
            kind: 'wall',
            device: manifest.devices.dev_wall_media,
            wallId: manifest.fixtures.mediaWallId
        });
        const wall = await wallContext.newPage();
        await wall.goto(`/wall?w=${manifest.fixtures.mediaWallId}&c=0&r=0`);
        await waitForWallBusReady(wall);

        await page.evaluate(
            ({ wallId, projectId, commitId, slideId }) =>
                (window as EditorWindow).__EDITOR_ENGINE__?.bindWall(
                    wallId,
                    projectId,
                    commitId,
                    slideId
                ),
            {
                wallId: manifest.fixtures.mediaWallId,
                projectId: manifest.fixtures.convergenceProjectId,
                commitId: manifest.fixtures.convergenceCommitId,
                slideId: manifest.fixtures.convergenceSlideId
            }
        );
        await waitForWallHydrated(wall, { source: 'live', foregroundLayerCount: 3 });

        await eraseLine(page, createdLineId);

        await expect
            .poll(() =>
                Promise.all([
                    readEditorLinePaths(secondEditor, createdLineId),
                    readWallLinePaths(wall, createdLineId)
                ])
            )
            .toEqual([LINE_PATHS, LINE_PATHS]);
    } finally {
        await page.evaluate(() => (window as EditorWindow).__EDITOR_ENGINE__?.unbindWall());
        if (lineId !== null) await removeLine(page, lineId);
        await Promise.all([secondEditorContext?.close(), wallContext?.close()]);
    }
});
