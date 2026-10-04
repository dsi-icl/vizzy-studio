import { expect, test, type Page } from 'playwright/test';
import type { StoreApi } from 'zustand';

import type { EditorEngine } from '../../src/lib/editorEngine';
import type { EditorState } from '../../src/lib/editorStore.types';
import type { GSMessage, Layer } from '../../src/lib/types';
import { actorStorageState, readHarnessManifest, waitForCanvasReady } from '../support/harness';

type EditorRuntimeWindow = Window & {
    __EDITOR_STORE__?: StoreApi<EditorState>;
    __EDITOR_ENGINE__?: Pick<
        EditorEngine,
        'connectionStatus' | 'sendJSON' | 'subscribeToSaveResponse'
    >;
};

const MAP: Extract<Layer, { type: 'map' }> = {
    numericId: 50,
    type: 'map',
    config: {
        cx: 640,
        cy: 360,
        width: 300,
        height: 200,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 999,
        visible: true
    },
    style: 'protomaps-light',
    view: { longitude: -0.017, latitude: 51.4904999, zoom: 14, pitch: 0, bearing: 0 }
};

test.use({ storageState: actorStorageState('user_editor') });

test.afterEach(async ({ page }) => {
    const { fixtures } = readHarnessManifest();
    // A fresh editor also recovers from a failed gesture or reload. This slide is
    // shared with other specs, so cleanup must finish before the page is closed.
    await page.goto(
        `/quarry/editor/${fixtures.interactionProjectId}/${fixtures.interactionCommitId}/${fixtures.interactionSlideId}`
    );
    await expect
        .poll(() =>
            page.evaluate(() => {
                const state = (window as EditorRuntimeWindow).__EDITOR_STORE__?.getState();
                return state && !state.loading ? state.activeSlideId : null;
            })
        )
        .toBe(fixtures.interactionSlideId);

    await page.evaluate(async (numericId) => {
        const store = (window as EditorRuntimeWindow).__EDITOR_STORE__;
        const engine = (window as EditorRuntimeWindow).__EDITOR_ENGINE__;
        if (!store || !engine) throw new Error('Editor was not ready for map fixture cleanup');
        if (!store.getState().layers.has(numericId)) return;

        await new Promise<void>((resolve, reject) => {
            const unsubscribe = engine.subscribeToSaveResponse((response) => {
                unsubscribe();
                if (response.success) resolve();
                else reject(new Error(response.error ?? 'Map fixture cleanup failed'));
            });
            store.getState().removeLayer(numericId);
            store.getState().saveProject('Remove map test fixture');
        });
    }, MAP.numericId);
});

async function readMap(page: Page) {
    return page.evaluate((id) => {
        return (window as EditorRuntimeWindow).__EDITOR_STORE__?.getState().layers.get(id);
    }, MAP.numericId);
}

const scenarios = (['drag', 'resize', 'rotate'] as const).flatMap((gesture) => [
    { gesture, saveBeforeReload: false },
    { gesture, saveBeforeReload: true }
]);

for (const { gesture, saveBeforeReload } of scenarios) {
    test(`map ${gesture}: ${saveBeforeReload ? 'Save then reload' : 'reload directly'} without touching Parameters`, async ({
        page
    }) => {
        const sent: GSMessage[] = [];
        const received: GSMessage[] = [];
        page.on('websocket', (socket) => {
            socket.on('framesent', ({ payload }) => {
                if (typeof payload === 'string') sent.push(JSON.parse(payload));
            });
            socket.on('framereceived', ({ payload }) => {
                if (typeof payload === 'string') received.push(JSON.parse(payload));
            });
        });
        // This test checks editor geometry/persistence; no external tile service is needed.
        await page.route('**/api/projects/*/tiles/**', (route) => route.fulfill({ status: 204 }));
        const { fixtures } = readHarnessManifest();
        await page.goto(
            `/quarry/editor/${fixtures.interactionProjectId}/${fixtures.interactionCommitId}/${fixtures.interactionSlideId}`
        );
        await expect(page.getByText('Loading slide...')).toBeHidden();
        await waitForCanvasReady(page, '#slate canvas');
        await expect
            .poll(() =>
                page.evaluate(
                    () => (window as EditorRuntimeWindow).__EDITOR_ENGINE__?.connectionStatus
                )
            )
            .toBe('connected');

        const bounds = await page.locator('#slate .konvajs-content').last().boundingBox();
        if (!bounds) throw new Error('Stage bounds missing');
        const layout = await page.evaluate(
            () => (window as EditorRuntimeWindow).__EDITOR_STORE__!.getState().stageLayout
        );
        const scale = bounds.width / (layout.columns * layout.screenWidth);
        const map = {
            ...MAP,
            config: {
                ...MAP.config,
                cx: Math.round(250 / scale),
                cy: Math.round(200 / scale),
                width: Math.round(220 / scale),
                height: Math.round(160 / scale)
            }
        };

        await page.evaluate((layer) => {
            const store = (window as EditorRuntimeWindow).__EDITOR_STORE__;
            const engine = (window as EditorRuntimeWindow).__EDITOR_ENGINE__;
            if (!store || !engine) throw new Error('Editor was not ready');
            store.getState().upsertLayer(layer);
            store.setState({
                selectedLayerIds: [String(layer.numericId)],
                isSnapping: false
            } as Partial<EditorState>);
            engine.sendJSON({ type: 'upsert_layer', origin: 'test:map_fixture', layer });
            store.getState().saveProject('Map fixture');
        }, map);
        await expect
            .poll(
                () =>
                    received.filter(
                        (message) => message.type === 'stage_save_response' && message.success
                    ).length
            )
            .toBe(1);
        sent.length = 0;
        received.length = 0;

        // Move real mouse pointers on the actual Konva nodes; never open Parameters.
        const cx = bounds.x + map.config.cx * scale;
        const cy = bounds.y + map.config.cy * scale;
        if (gesture === 'drag') {
            await page.mouse.move(cx, cy);
            await page.mouse.down();
            await page.mouse.move(cx + 83, cy + 47, { steps: 8 });
        } else if (gesture === 'resize') {
            const right = cx + (map.config.width * scale) / 2;
            const bottom = cy + (map.config.height * scale) / 2;
            await page.mouse.move(right, bottom);
            await page.mouse.down();
            await page.mouse.move(right + 72, bottom + 48, { steps: 8 });
        } else {
            const top = cy - (map.config.height * scale) / 2;
            await page.mouse.move(cx, top - 50 * scale);
            await page.mouse.down();
            await page.mouse.move(cx + 55, top - 20 * scale, { steps: 8 });
        }
        await page.mouse.up();

        const edited = await readMap(page);
        expect(edited?.config).not.toEqual(map.config);
        await expect
            .poll(
                () =>
                    sent.filter(
                        (message) =>
                            message.type === 'upsert_layer' &&
                            message.origin === 'editor:handle_transform_end'
                    ).length
            )
            .toBe(1);
        await expect(page.getByText('Unsaved', { exact: false })).toBeVisible();
        if (saveBeforeReload) {
            await page.keyboard.press('ControlOrMeta+s');
            await expect
                .poll(
                    () =>
                        received.filter(
                            (message) => message.type === 'stage_save_response' && message.success
                        ).length
                )
                .toBe(1);
        }

        await page.reload();
        await expect(page.getByText('Loading slide...')).toBeHidden();
        await expect.poll(() => readMap(page)).toEqual(edited);
    });
}
