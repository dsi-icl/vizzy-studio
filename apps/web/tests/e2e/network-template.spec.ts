import type Konva from 'konva';
import { expect, test, type Page } from 'playwright/test';
import type { StoreApi } from 'zustand';

import type { EditorEngine } from '../../src/lib/editorEngine';
import type { EditorState } from '../../src/lib/editorStore.types';
import { networkDocumentKey } from '../../src/lib/network/document';
import type { NetworkFrameBuffer } from '../../src/lib/network/frames';
import { DEFAULT_NETWORK_SETTINGS } from '../../src/lib/network/schema';
import type { Layer } from '../../src/lib/types';
import {
    actorStorageState,
    installDeviceIdentity,
    readHarnessManifest,
    waitForWallBusReady
} from '../support/harness';

type RuntimeWindow = Window & {
    Konva: typeof Konva;
    __RESTORE_NETWORK_FRAMES__?: () => void;
    __EDITOR_STORE__: StoreApi<EditorState>;
    __EDITOR_ENGINE__: Pick<
        EditorEngine,
        'connectionStatus' | 'subscribeToSaveResponse' | 'bindWall' | 'sendJSON' | 'networkFrames'
    >;
};
test.use({ storageState: actorStorageState('user_editor') });

type PreviewTestCanvas = HTMLCanvasElement & {
    paintedNodes?: { x: number; y: number }[];
};

// Observe the real drawing coordinates without changing layout or simulation.
async function observePreviewNodes(page: Page) {
    await page.addInitScript(() => {
        // Preserve the receiver explicitly with apply below.
        // oxlint-disable-next-line typescript/unbound-method
        const clear = CanvasRenderingContext2D.prototype.clearRect;
        // oxlint-disable-next-line typescript/unbound-method
        const arc = CanvasRenderingContext2D.prototype.arc;
        CanvasRenderingContext2D.prototype.clearRect = function (...args) {
            const canvas = this.canvas as PreviewTestCanvas;
            if (canvas.getAttribute('aria-label') === 'Network preview') canvas.paintedNodes = [];
            clear.apply(this, args);
        };
        CanvasRenderingContext2D.prototype.arc = function (...args) {
            const canvas = this.canvas as PreviewTestCanvas;
            if (canvas.paintedNodes && args[2] === 7) {
                const point = new DOMPoint(args[0], args[1]).matrixTransform(this.getTransform());
                canvas.paintedNodes.push({ x: point.x, y: point.y });
            }
            arc.apply(this, args);
        };
    });
}

async function previewPoint(page: Page, target: number | [number, number] | 'empty') {
    return page.getByLabel('Network preview', { exact: true }).evaluate((el, target) => {
        const canvas = el as PreviewTestCanvas;
        const nodes = canvas.paintedNodes!;
        let point = { x: 5, y: 5 };
        if (typeof target === 'number') point = nodes[target]!;
        else if (Array.isArray(target)) {
            const a = nodes[target[0]]!,
                b = nodes[target[1]]!;
            const candidates = [0.5, 0.35, 0.65, 0.2, 0.8].map((t) => ({
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t
            }));
            point = candidates.find((p) =>
                nodes.every((n) => Math.hypot(p.x - n.x, p.y - n.y) > 30)
            )!;
            if (!point) throw new Error('No unobstructed point on test link');
        }
        const bounds = canvas.getBoundingClientRect();
        const scale = Math.min(bounds.width / canvas.width, bounds.height / canvas.height);
        return {
            x: bounds.left + (bounds.width - canvas.width * scale) / 2 + point.x * scale,
            y: bounds.top + (bounds.height - canvas.height * scale) / 2 + point.y * scale
        };
    }, target);
}

async function clickPreview(page: Page, target: number | [number, number] | 'empty') {
    const point = await previewPoint(page, target);
    await page.mouse.click(point.x, point.y);
}

async function dragPreviewLink(page: Page, source: number, target: number) {
    const from = await previewPoint(page, source);
    const to = await previewPoint(page, target);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
}

// Read the already painted canvas, without forcing a redraw via node.toDataURL().
async function editorNetworkPixels(page: Page, numericId: number) {
    const found = await page.evaluate((id) => {
        const w = window as unknown as RuntimeWindow;
        const shape = w.Konva.stages.map((stage) => stage.findOne(`#${id}`)).find(Boolean);
        const canvas = shape?.getLayer()?.getCanvas()._canvas;
        canvas?.setAttribute('data-network-motion-test', String(id));
        return !!canvas;
    }, numericId);
    if (!found) return undefined;
    // Existing image layers may taint the canvas, so capture what the browser
    // displays instead of exporting its pixels through canvas APIs.
    return (
        await page.locator(`canvas[data-network-motion-test="${numericId}"]`).screenshot()
    ).toString('base64');
}

async function expectEditorNetworkMotion(page: Page, numericId: number) {
    const network = await page.evaluate((id) => {
        const layer = (window as unknown as RuntimeWindow).__EDITOR_STORE__
            .getState()
            .layers.get(id);
        return layer?.type === 'graph' ? layer.network : undefined;
    }, numericId);
    const key = networkDocumentKey(network!);
    const position = () =>
        page.evaluate(
            ({ id, key }) =>
                (window as unknown as RuntimeWindow).__EDITOR_ENGINE__.networkFrames.sample(id, key)
                    ?.view.positions[0],
            { id: numericId, key }
        );
    await expect.poll(position).toBeTruthy();
    // Let insertion/apply layout and selection redraws finish. The graph must
    // keep repainting afterwards, without pointer motion or a new data event.
    await page.waitForTimeout(1500);
    await expect.poll(() => editorNetworkPixels(page, numericId)).toBeTruthy();
    const before = await editorNetworkPixels(page, numericId);
    const beforePosition = await position();
    await expect.poll(position).not.toEqual(beforePosition);
    await expect.poll(() => editorNetworkPixels(page, numericId)).not.toBe(before);
}

async function openEditor(page: Page, multi = false) {
    const { fixtures: f } = readHarnessManifest();
    await page.goto(
        multi
            ? `/quarry/editor/${f.multiWallProjectId}/${f.multiWallCommitId}/${f.multiWallSlideId}`
            : `/quarry/editor/${f.interactionProjectId}/${f.interactionCommitId}/${f.interactionSlideId}`
    );
    await expect(page.getByText('Loading slide...')).toBeHidden();
    await expect
        .poll(() =>
            page.evaluate(
                () => (window as unknown as RuntimeWindow).__EDITOR_ENGINE__?.connectionStatus
            )
        )
        .toBe('connected');
}

async function save(page: Page) {
    await page.evaluate(async () => {
        const w = window as unknown as RuntimeWindow;
        await new Promise<void>((resolve, reject) => {
            const unsubscribe = w.__EDITOR_ENGINE__.subscribeToSaveResponse((response) => {
                unsubscribe();
                if (response.success) resolve();
                else reject(new Error(response.error));
            });
            w.__EDITOR_STORE__.getState().saveProject('Network integration test');
        });
    });
}

test('closing the network editor saves a draft until Add or Apply', async ({ page }) => {
    await openEditor(page);
    const addNetwork = page
        .locator('#titlebar')
        .getByRole('button', { name: 'Add network', exact: true });
    const layerIds = () =>
        page.evaluate(() => [
            ...(window as unknown as RuntimeWindow).__EDITOR_STORE__.getState().layers.keys()
        ]);
    const selectedNetwork = () =>
        page.evaluate(() => {
            const store = (window as unknown as RuntimeWindow).__EDITOR_STORE__.getState();
            const layer = store.layers.get(Number(store.selectedLayerIds[0]));
            return layer?.type === 'graph' ? layer : undefined;
        });
    const dismiss = () =>
        page.locator('[data-slot="dialog-backdrop"]').click({ position: { x: 10, y: 10 } });
    const before = await layerIds();
    let createdId: number | undefined;
    try {
        await addNetwork.click();
        await dismiss();
        await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeHidden();
        expect(await layerIds()).toEqual(before);

        await addNetwork.click();
        await page.getByLabel('Node name Vizzy', { exact: true }).fill('Changed node');
        await dismiss();
        await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeHidden();
        expect(await layerIds()).toEqual(before);

        await addNetwork.click();
        await expect(page.getByLabel('Node name Vizzy', { exact: true })).toHaveValue(
            'Changed node'
        );
        await page.getByRole('button', { name: 'Add', exact: true }).click();
        const created = (await selectedNetwork())!;
        createdId = created.numericId;
        expect(created.network?.data.nodes[0]?.label).toBe('Changed node');

        await page.getByRole('button', { name: 'Edit network', exact: true }).click();
        await page.getByRole('tab', { name: 'Motion', exact: true }).click();
        await page.getByRole('slider', { name: 'Link distance' }).fill('160');
        await dismiss();
        await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeHidden();
        expect((await selectedNetwork())?.network?.settings.linkDistance).toBe(
            created.network?.settings.linkDistance
        );

        // The edit tool unmounts when selection changes; its draft still survives.
        await page.evaluate(() => {
            (window as unknown as RuntimeWindow).__EDITOR_STORE__.setState({
                selectedLayerIds: []
            });
        });
        await expect(page.getByRole('button', { name: 'Edit network', exact: true })).toBeHidden();
        await page.evaluate((id) => {
            (window as unknown as RuntimeWindow).__EDITOR_STORE__.setState({
                selectedLayerIds: [String(id)]
            });
        }, createdId);
        await page.getByRole('button', { name: 'Edit network', exact: true }).click();
        await page.getByRole('tab', { name: 'Motion', exact: true }).click();
        await expect(page.getByRole('slider', { name: 'Link distance' })).toHaveValue('160');
        await page.getByRole('button', { name: 'Apply', exact: true }).click();
        expect((await selectedNetwork())?.network?.settings.linkDistance).toBe(160);

        await page.getByRole('button', { name: 'Edit network', exact: true }).click();
        await page.getByRole('tab', { name: 'Motion', exact: true }).click();
        await page.getByRole('slider', { name: 'Link distance' }).fill('200');
        await dismiss();
        await page.getByRole('button', { name: 'Edit network', exact: true }).click();
        await page.getByRole('tab', { name: 'Motion', exact: true }).click();
        await expect(page.getByRole('slider', { name: 'Link distance' })).toHaveValue('200');
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.getByRole('button', { name: 'Edit network', exact: true }).click();
        await page.getByRole('tab', { name: 'Motion', exact: true }).click();
        await expect(page.getByRole('slider', { name: 'Link distance' })).toHaveValue('160');
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        expect((await selectedNetwork())?.network?.settings.linkDistance).toBe(160);
    } finally {
        if (createdId !== undefined) {
            await page.evaluate((id) => {
                (window as unknown as RuntimeWindow).__EDITOR_STORE__.getState().removeLayer(id);
            }, createdId);
            await save(page);
        }
    }
});

test('network example, import, edit, save and reload use native layers', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openEditor(page);
    const ids: number[] = [];
    try {
        const tools = page
            .locator('#titlebar')
            .getByRole('button', { name: 'Add network', exact: true });
        await tools.click();
        await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
        await expect(page.getByTestId('network-preview-pane')).toHaveText('');
        const preview = page.getByLabel('Network preview', { exact: true });
        await expect
            .poll(() =>
                preview.evaluate((element) => {
                    const pixels = (element as HTMLCanvasElement)
                        .getContext('2d')!
                        .getImageData(0, 0, 1000, 650).data;
                    let count = 0;
                    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) count++;
                    return count;
                })
            )
            .toBeGreaterThan(100);
        const initialPixels = await preview.evaluate((element) =>
            (element as HTMLCanvasElement).toDataURL()
        );
        await expect
            .poll(() => preview.evaluate((element) => (element as HTMLCanvasElement).toDataURL()))
            .not.toBe(initialPixels);
        // The backdrop is CSS only: all drawn pixels start white, empty pixels stay transparent.
        const colours = () =>
            preview.evaluate((element) => {
                const pixels = (element as HTMLCanvasElement)
                    .getContext('2d')!
                    .getImageData(0, 0, 1000, 650).data;
                let coloured = 0,
                    empty = 0;
                for (let i = 0; i < pixels.length; i += 4) {
                    if (!pixels[i + 3]) empty++;
                    else if (
                        pixels[i + 3]! > 100 &&
                        (pixels[i]! < 240 || pixels[i + 1]! < 240 || pixels[i + 2]! < 240)
                    )
                        coloured++;
                }
                return { coloured, empty };
            });
        expect((await colours()).coloured).toBe(0);
        expect((await colours()).empty).toBeGreaterThan(600000);
        await page.getByRole('tab', { name: 'Style', exact: true }).click();
        await page.getByLabel('Colour nodes by group', { exact: true }).check();
        await expect.poll(async () => (await colours()).coloured).toBeGreaterThan(100);
        await page.getByLabel('Colour nodes by group', { exact: true }).uncheck();
        await expect.poll(async () => (await colours()).coloured).toBe(0);
        await expect(page.getByLabel('Show labels', { exact: true })).toHaveText('None');
        await page.getByLabel('Show labels', { exact: true }).click();
        await page.getByRole('option', { name: 'All nodes' }).click();
        await expect(page.getByLabel('Label font')).toBeVisible();
        await page.getByLabel('Show labels', { exact: true }).click();
        await page.getByRole('option', { name: 'None' }).click();
        await expect(page.getByRole('slider', { name: 'Node size' })).toHaveCount(0);
        await expect(page.getByRole('slider', { name: 'Line width' })).toHaveCount(0);
        await page.getByRole('tab', { name: 'Motion', exact: true }).click();
        await expect(page.getByRole('tab', { name: 'Motion', exact: true })).toHaveAttribute(
            'aria-selected',
            'true'
        );
        await expect(page.getByRole('button', { name: /^Help: / })).toHaveCount(5);
        await expect(page.getByText('More force settings')).toHaveCount(0);
        await expect(page.getByRole('slider', { name: 'Link strength' })).toBeVisible();
        await expect(page.getByRole('slider', { name: 'Collision spacing' })).toBeVisible();
        await expect(page.getByRole('slider', { name: 'Node size' })).toBeVisible();
        await expect(page.getByRole('slider', { name: 'Line width' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Help: Node size' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Help: Line width' })).toHaveCount(0);
        await page.getByRole('slider', { name: 'Node size' }).fill('12');
        await page.getByRole('slider', { name: 'Line width' }).fill('3');
        await page.getByRole('slider', { name: 'Link distance' }).fill('140');
        await page.getByRole('button', { name: 'Reset to default' }).click();
        await expect(page.getByRole('slider', { name: 'Node size' })).toHaveValue(
            String(DEFAULT_NETWORK_SETTINGS.nodeRadius)
        );
        await expect(page.getByRole('slider', { name: 'Line width' })).toHaveValue(
            String(DEFAULT_NETWORK_SETTINGS.edgeWidth)
        );
        await expect(page.getByRole('slider', { name: 'Link distance' })).toHaveValue(
            String(DEFAULT_NETWORK_SETTINGS.linkDistance)
        );
        await page.getByRole('button', { name: 'Help: Link distance' }).hover();
        await expect(page.getByRole('tooltip')).toContainText('target distance');
        await page.mouse.move(0, 0);
        await page.getByRole('button', { name: 'Help: Repulsion' }).click();
        await expect(page.getByRole('tooltip')).toContainText('push apart');
        await page.getByLabel('Layer name', { exact: true }).focus();
        await page.screenshot({ path: test.info().outputPath('network-editor.png') });
        await page.getByLabel('Layer name', { exact: true }).fill('Network integration example');
        await page.getByRole('button', { name: 'Add', exact: true }).click();
        const first = (await page.evaluate(() => {
            const store = (window as unknown as RuntimeWindow).__EDITOR_STORE__.getState();
            return store.layers.get(Number(store.selectedLayerIds[0]));
        })) as Extract<Layer, { type: 'graph' }>;
        expect(first.network?.positions).toBeUndefined();
        expect(first.network?.source).toBe('live-example');
        ids.push(first.numericId);
        await expectEditorNetworkMotion(page, first.numericId);
        // A buffer object exists even before this layer has received any frames.
        // Apply must not leave the native editor canvas frozen in that interval.
        await page.evaluate((id) => {
            const w = window as unknown as RuntimeWindow;
            const frames = w.__EDITOR_ENGINE__.networkFrames;
            const sample = frames.sample.bind(frames);
            w.__RESTORE_NETWORK_FRAMES__ = () => {
                frames.sample = sample;
            };
            frames.sample = (...args) => (args[0] === id ? null : sample(...args));
        }, first.numericId);
        await page.getByRole('button', { name: 'Edit network', exact: true }).click();
        await page.getByRole('tab', { name: 'Motion', exact: true }).click();
        await page.getByRole('slider', { name: 'Link distance', exact: true }).fill('160');
        await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: 'Apply', exact: true }).click();
        await expect
            .poll(
                () => page.workers().filter((worker) => worker.url().includes('live.worker')).length
            )
            .toBeGreaterThan(0);
        await page.waitForTimeout(1500);
        const localPixels = await editorNetworkPixels(page, first.numericId);
        await expect.poll(() => editorNetworkPixels(page, first.numericId)).not.toBe(localPixels);
        await page.evaluate(() => {
            const w = window as unknown as RuntimeWindow;
            w.__RESTORE_NETWORK_FRAMES__?.();
            delete w.__RESTORE_NETWORK_FRAMES__;
        });
        // Once shared coordinates arrive, the fallback worker must stop.
        await expect
            .poll(
                () => page.workers().filter((worker) => worker.url().includes('live.worker')).length
            )
            .toBe(0);
        await expectEditorNetworkMotion(page, first.numericId);
        await save(page);
        await page.reload();
        await expect
            .poll(() =>
                page.evaluate((id) => {
                    const l = (window as unknown as RuntimeWindow).__EDITOR_STORE__
                        ?.getState()
                        .layers.get(id);
                    return l?.type === 'graph' ? l.network?.settings.linkDistance : undefined;
                }, first.numericId)
            )
            .toBe(160);
        const positions = await page.evaluate((id) => {
            const l = (window as unknown as RuntimeWindow).__EDITOR_STORE__
                .getState()
                .layers.get(id);
            return l?.type === 'graph' ? l.network?.positions : undefined;
        }, first.numericId);
        expect(positions).toBeUndefined();
        const savedNetwork = await page.evaluate((id) => {
            const layer = (window as unknown as RuntimeWindow).__EDITOR_STORE__
                .getState()
                .layers.get(id);
            return layer?.type === 'graph' ? layer.network : undefined;
        }, first.numericId);
        const liveKey = networkDocumentKey(savedNetwork!);
        await expect
            .poll(() =>
                page.evaluate(
                    ({ id, key }) =>
                        (window as unknown as RuntimeWindow).__EDITOR_ENGINE__.networkFrames.sample(
                            id,
                            key
                        )?.view.data.nodes.length ?? 0,
                    { id: first.numericId, key: liveKey }
                )
            )
            .toBe(12);

        await page.evaluate(
            (id) =>
                (window as unknown as RuntimeWindow).__EDITOR_STORE__.setState({
                    selectedLayerIds: [String(id)]
                }),
            first.numericId
        );
        await expect(
            page.getByRole('button', { name: 'Live network controls', exact: true })
        ).toHaveCount(0);
        await page.getByRole('button', { name: 'Edit network', exact: true }).click();
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await page.getByRole('button', { name: 'Apply', exact: true }).click();
        await expect
            .poll(() =>
                page.evaluate((id) => {
                    const layer = (window as unknown as RuntimeWindow).__EDITOR_STORE__
                        .getState()
                        .layers.get(id);
                    return layer?.type === 'graph' && layer.network?.settings.paused;
                }, first.numericId)
            )
            .toBe(true);
        await page.getByRole('button', { name: 'Edit network', exact: true }).click();
        await page.getByRole('button', { name: 'Resume', exact: true }).click();
        await page.getByRole('button', { name: 'Apply', exact: true }).click();
        await expect
            .poll(() =>
                page.evaluate((id) => {
                    const layer = (window as unknown as RuntimeWindow).__EDITOR_STORE__
                        .getState()
                        .layers.get(id);
                    return layer?.type === 'graph' && layer.network?.settings.paused;
                }, first.numericId)
            )
            .toBe(false);

        await tools.click();
        await page.getByLabel('Network data file', { exact: true }).setInputFiles({
            name: 'People.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from('Person,Colleague,Count\nAlice,Bob,2\nBob,Carol,3')
        });
        await page.getByLabel('weight column', { exact: true }).selectOption('Count');
        await expect(page.getByRole('button', { name: 'Nodes 3', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Links 2', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: 'Add', exact: true }).click();
        const importedId = await page.evaluate(() => {
            const store = (window as unknown as RuntimeWindow).__EDITOR_STORE__.getState();
            const layer = store.layers.get(Number(store.selectedLayerIds[0]));
            return layer?.type === 'graph' && layer.network?.name === 'People'
                ? layer.numericId
                : undefined;
        });
        expect(importedId).toBeDefined();
        ids.push(importedId!);

        await tools.click();
        await page.getByLabel('Network data file', { exact: true }).setInputFiles({
            name: 'invalid.json',
            mimeType: 'application/json',
            buffer: Buffer.from(
                '{"nodes":[{"id":"a"}],"edges":[{"source":"a","target":"missing"}]}'
            )
        });
        await expect(page.getByRole('alert')).toContainText('Unknown node');
        await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        expect(errors).toEqual([]);
    } finally {
        await page.evaluate((numericIds) => {
            const w = window as unknown as RuntimeWindow;
            w.__RESTORE_NETWORK_FRAMES__?.();
            delete w.__RESTORE_NETWORK_FRAMES__;
            const store = (window as unknown as RuntimeWindow).__EDITOR_STORE__.getState();
            numericIds.forEach((id) => store.removeLayer(id));
        }, ids);
        await save(page);
    }
});

test('custom topology edits the example and imported data, persists and keeps animating', async ({
    page
}) => {
    await openEditor(page);
    const ids: number[] = [];
    const selectedNetwork = () =>
        page.evaluate(() => {
            const store = (window as unknown as RuntimeWindow).__EDITOR_STORE__.getState();
            const layer = store.layers.get(Number(store.selectedLayerIds[0]));
            return layer?.type === 'graph' ? layer : undefined;
        });
    try {
        await page
            .locator('#titlebar')
            .getByRole('button', { name: 'Add network', exact: true })
            .click();
        await expect(page.getByRole('tab', { name: 'Custom', exact: true })).toHaveAttribute(
            'aria-selected',
            'true'
        );
        await expect(page.getByRole('button', { name: 'Nodes 12', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Links 17', exact: true })).toBeVisible();
        await page.getByLabel('Node name Vizzy', { exact: true }).fill('My hub');
        await page.getByRole('button', { name: 'Add node', exact: true }).click();
        await page.getByLabel('Node name node-1', { exact: true }).fill('My new node');
        await page.getByRole('button', { name: /^Links \d+$/ }).click();
        await page.getByRole('button', { name: 'Add link', exact: true }).click();
        await page.getByLabel('From node', { exact: true }).click();
        await page.getByRole('button', { name: 'My hub', exact: true }).click();
        await page.getByLabel('To node', { exact: true }).click();
        await page.getByRole('button', { name: 'My new node', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Nodes 13', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Links 18', exact: true })).toBeVisible();
        await page.screenshot({ path: test.info().outputPath('custom-network-links.png') });
        await page.getByRole('button', { name: 'Add', exact: true }).click();
        const created = (await selectedNetwork())!;
        ids.push(created.numericId);
        expect(created.network!.source).toBe('custom');
        expect(created.network!.data.nodes.find((node) => node.id === 'Vizzy')?.label).toBe(
            'My hub'
        );
        expect(created.network!.data.edges.at(-1)).toEqual({ source: 'Vizzy', target: 'node-1' });
        await expectEditorNetworkMotion(page, created.numericId);

        await page.getByRole('button', { name: 'Edit network', exact: true }).click();
        await page.getByRole('button', { name: 'Delete node Research', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Nodes 12', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Links 15', exact: true })).toBeVisible();
        await page.getByRole('button', { name: /^Links \d+$/ }).click();
        await page.getByRole('button', { name: 'Delete link 1', exact: true }).click();
        await page.getByRole('button', { name: 'Apply', exact: true }).click();
        const modified = (await selectedNetwork())!;
        expect(modified.network!.data.nodes.some((node) => node.id === 'Research')).toBe(false);
        expect(modified.network!.data.edges).toHaveLength(14);
        expect(
            modified.network!.data.edges.some(
                (edge) => edge.source === 'Research' || edge.target === 'Research'
            )
        ).toBe(false);
        await save(page);
        await page.reload();
        await expect
            .poll(() =>
                page.evaluate((id) => {
                    const layer = (window as unknown as RuntimeWindow).__EDITOR_STORE__
                        ?.getState()
                        .layers.get(id);
                    return layer?.type === 'graph' ? layer.network?.data : undefined;
                }, created.numericId)
            )
            .toEqual(modified.network!.data);
        await expectEditorNetworkMotion(page, created.numericId);
        await page.evaluate(
            (id) =>
                (window as unknown as RuntimeWindow).__EDITOR_STORE__.setState({
                    selectedLayerIds: [String(id)]
                }),
            created.numericId
        );

        // Cancel leaves the existing layer untouched after draft setting changes.
        await page.getByRole('button', { name: 'Edit network', exact: true }).click();
        await page.getByRole('tab', { name: 'Motion', exact: true }).click();
        await page.getByRole('slider', { name: 'Node size' }).fill('12');
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        expect((await selectedNetwork())?.network?.data).toEqual(modified.network!.data);
        expect((await selectedNetwork())?.network?.settings).toEqual(modified.network!.settings);

        // Imported topology opens in the very same controls.
        await page.getByRole('button', { name: 'Edit network', exact: true }).click();
        await page.getByLabel('Network data file', { exact: true }).setInputFiles({
            name: 'Imported.json',
            mimeType: 'application/json',
            buffer: Buffer.from(
                '{"nodes":[{"id":"alice"},{"id":"bob"}],"edges":[{"source":"alice","target":"bob","weight":2}]}'
            )
        });
        await page.getByLabel('Node name alice', { exact: true }).fill('Alice renamed');
        await page.getByRole('button', { name: 'Delete node bob', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Nodes 1', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Links 0', exact: true })).toBeVisible();
        await expect(
            page.getByRole('button', { name: 'Delete node alice', exact: true })
        ).toBeDisabled();
        await page.getByRole('button', { name: 'Apply', exact: true }).click();
        expect((await selectedNetwork())?.network?.data).toEqual({
            nodes: [{ id: 'alice', label: 'Alice renamed' }],
            edges: []
        });
    } finally {
        await page.evaluate((ids) => {
            const store = (window as unknown as RuntimeWindow).__EDITOR_STORE__.getState();
            ids.forEach((id) => store.removeLayer(id));
        }, ids);
        await save(page);
    }
});

test('canvas selection locates nodes and links in the panel and keeps draft shortcuts isolated', async ({
    page
}) => {
    await observePreviewNodes(page);
    await openEditor(page);
    const ids: number[] = [];
    const layerIds = () =>
        page.evaluate(() => [
            ...(window as unknown as RuntimeWindow).__EDITOR_STORE__.getState().layers.keys()
        ]);
    const before = await layerIds();
    try {
        await page
            .locator('#titlebar')
            .getByRole('button', { name: 'Add network', exact: true })
            .click();
        await page.getByLabel('Network data file', { exact: true }).setInputFiles({
            name: 'Canvas topology.json',
            mimeType: 'application/json',
            buffer: Buffer.from(
                JSON.stringify({
                    nodes: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}` })),
                    edges: [
                        { source: 'n0', target: 'n7' },
                        { source: 'n6', target: 'n6' }
                    ]
                })
            )
        });
        const preview = page.getByLabel('Network preview', { exact: true });
        await expect
            .poll(() => preview.evaluate((el) => (el as PreviewTestCanvas).paintedNodes?.length))
            .toBe(8);
        // Let the imported nodes spread before pausing for precise pointer assertions.
        await page.getByRole('tab', { name: 'Motion', exact: true }).click();
        await page.getByRole('slider', { name: 'Link distance', exact: true }).fill('250');
        await expect
            .poll(() =>
                preview.evaluate((el) => {
                    const nodes = (el as PreviewTestCanvas).paintedNodes!;
                    return Math.min(
                        ...[6, 7].map((i) =>
                            Math.hypot(nodes[0]!.x - nodes[i]!.x, nodes[0]!.y - nodes[i]!.y)
                        )
                    );
                })
            )
            .toBeGreaterThan(120);
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await page.getByRole('tab', { name: 'Style', exact: true }).click();
        await clickPreview(page, 7);
        await expect(page.getByRole('tab', { name: 'Custom', exact: true })).toHaveAttribute(
            'aria-selected',
            'true'
        );
        await expect(page.getByLabel('Node name n7', { exact: true })).toBeVisible();
        await expect(
            page.getByLabel('Network nodes').locator('[data-selected=true] input')
        ).toHaveValue('n7');
        await page.getByLabel('Node name n7', { exact: true }).fill('Canvas chosen node');

        await clickPreview(page, [0, 7]);
        await expect(page.getByRole('button', { name: /^Links 2$/ })).toHaveAttribute(
            'aria-pressed',
            'true'
        );
        await expect(page.getByLabel('From node', { exact: true })).toHaveAttribute(
            'data-value',
            'n0'
        );
        await expect(page.getByLabel('To node', { exact: true })).toHaveAttribute(
            'data-value',
            'n7'
        );
        await page.getByLabel('To node', { exact: true }).click();
        await page.getByRole('button', { name: 'n6', exact: true }).click();
        // The revised link is immediately selectable at its new position.
        await clickPreview(page, [0, 6]);
        await expect(page.getByLabel('To node', { exact: true })).toHaveAttribute(
            'data-value',
            'n6'
        );
        await preview.press('Escape');
        await expect(page.getByLabel('To node', { exact: true })).toBeHidden();
        await expect(preview).toBeVisible();
        await clickPreview(page, 7);
        await page.screenshot({ path: test.info().outputPath('canvas-panel-selection.png') });
        await clickPreview(page, 'empty');
        await expect(page.getByLabel('Network nodes').locator('[data-selected=true]')).toHaveCount(
            0
        );

        // A different aspect ratio exercises the canvas's object-contain margins.
        await page.setViewportSize({ width: 980, height: 960 });
        await page.getByRole('tab', { name: 'Style', exact: true }).click();
        await clickPreview(page, 0);
        await expect(page.getByLabel('Node name n0', { exact: true })).toBeVisible();
        await preview.press('Delete');
        await expect(page.getByRole('button', { name: 'Nodes 7', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Links 1', exact: true })).toBeVisible();
        expect(await layerIds()).toEqual(before);
        await expect
            .poll(() => preview.evaluate((el) => (el as PreviewTestCanvas).paintedNodes?.length))
            .toBe(7);
        await dragPreviewLink(page, 0, 1);
        await expect(page.getByRole('button', { name: 'Links 2', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true'
        );
        await expect(page.getByLabel('From node', { exact: true })).toHaveAttribute(
            'data-value',
            'n1'
        );
        await expect(page.getByLabel('To node', { exact: true })).toHaveAttribute(
            'data-value',
            'n2'
        );
        await page.getByRole('button', { name: 'Resume', exact: true }).click();
        await page.getByRole('button', { name: 'Add', exact: true }).click();
        const created = await page.evaluate(() => {
            const state = (window as unknown as RuntimeWindow).__EDITOR_STORE__.getState();
            return state.layers.get(Number(state.selectedLayerIds[0])) as Extract<
                Layer,
                { type: 'graph' }
            >;
        });
        ids.push(created.numericId);
        expect(created.network!.source).toBe('custom');
        expect(created.network!.data.nodes.some((node) => node.id === 'n0')).toBe(false);
        expect(created.network!.data.nodes.find((node) => node.id === 'n7')?.label).toBe(
            'Canvas chosen node'
        );
        expect(created.network!.data.edges).toEqual([
            { source: 'n6', target: 'n6' },
            { source: 'n1', target: 'n2' }
        ]);
        await expectEditorNetworkMotion(page, created.numericId);
    } finally {
        await page.evaluate((ids) => {
            const state = (window as unknown as RuntimeWindow).__EDITOR_STORE__.getState();
            ids.forEach((id) => state.removeLayer(id));
        }, ids);
        await save(page);
    }
});

test('pausing a network keeps the preview layout on the editor stage', async ({ page }) => {
    await observePreviewNodes(page);
    await openEditor(page);
    let numericId: number | undefined;
    try {
        await page
            .locator('#titlebar')
            .getByRole('button', { name: 'Add network', exact: true })
            .click();
        await page.getByRole('button', { name: 'Add', exact: true }).click();
        const created = await page.evaluate(() => {
            const store = (window as unknown as RuntimeWindow).__EDITOR_STORE__.getState();
            return store.layers.get(Number(store.selectedLayerIds[0])) as Extract<
                Layer,
                { type: 'graph' }
            >;
        });
        numericId = created.numericId;
        await expectEditorNetworkMotion(page, numericId);

        await page.getByRole('button', { name: 'Edit network', exact: true }).click();
        const preview = page.getByLabel('Network preview', { exact: true });
        await expect
            .poll(() => preview.evaluate((el) => (el as PreviewTestCanvas).paintedNodes?.length))
            .toBe(created.network!.data.nodes.length);
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
        await expect
            .poll(async () => {
                const before = await preview.evaluate(
                    (el) => (el as PreviewTestCanvas).paintedNodes
                );
                await page.waitForTimeout(120);
                const after = await preview.evaluate(
                    (el) => (el as PreviewTestCanvas).paintedNodes
                );
                return JSON.stringify(before) === JSON.stringify(after);
            })
            .toBe(true);
        const frozen = await preview.evaluate((el) => (el as PreviewTestCanvas).paintedNodes!);
        await page.getByRole('button', { name: 'Apply', exact: true }).click();

        const paused = await page.evaluate((id) => {
            const layer = (window as unknown as RuntimeWindow).__EDITOR_STORE__
                .getState()
                .layers.get(id);
            return layer?.type === 'graph' ? layer.network : undefined;
        }, numericId);
        expect(paused?.settings.paused).toBe(true);
        expect(paused?.positions).toEqual(frozen);
        const key = networkDocumentKey(paused!);
        const stagePositions = () =>
            page.evaluate(
                ({ id, key }) =>
                    (window as unknown as RuntimeWindow).__EDITOR_ENGINE__.networkFrames.sample(
                        id,
                        key
                    )?.view.positions,
                { id: numericId!, key }
            );
        await expect.poll(stagePositions).toBeTruthy();
        expect(
            (await stagePositions())!.every(
                (position, i) =>
                    Math.hypot(position.x - frozen[i]!.x, position.y - frozen[i]!.y) < 0.01
            )
        ).toBe(true);

        await page.getByRole('button', { name: 'Edit network', exact: true }).click();
        await expect
            .poll(async () => preview.evaluate((el) => (el as PreviewTestCanvas).paintedNodes))
            .toEqual(frozen);
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    } finally {
        if (numericId !== undefined)
            await page.evaluate((id) => {
                (window as unknown as RuntimeWindow).__EDITOR_STORE__.getState().removeLayer(id);
            }, numericId);
        await save(page);
    }
});

test('wall tiles share live motion, transparency, crossing edges and reconnect state', async ({
    browser,
    page
}) => {
    const manifest = readHarnessManifest();
    const contexts = [];
    await openEditor(page, true);
    const layer: Extract<Layer, { type: 'graph' }> = {
        numericId: 98765,
        type: 'graph',
        config: {
            cx: 960,
            cy: 540,
            width: 5760,
            height: 3744,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            visible: true,
            zIndex: 999
        },
        network: {
            name: 'Network seam test',
            settings: { ...DEFAULT_NETWORK_SETTINGS, showLabels: true, paused: true },
            source: 'import',
            reheat: 0,
            data: {
                nodes: [
                    { id: 'a' },
                    { id: 'b' },
                    { id: 'seam' },
                    { id: 'caption', label: 'Cross-screen label' }
                ],
                edges: [{ source: 'a', target: 'b' }]
            },
            positions: [
                { x: 50, y: 325 },
                { x: 950, y: 325 },
                { x: 2000 / 3, y: 325 },
                { x: 3760 / 5.76, y: 270 }
            ]
        }
    };
    try {
        const pages: Page[] = [];
        for (const [col, deviceKey] of [
            [0, 'dev_wall_grid_00'],
            [1, 'dev_wall_grid_10']
        ] as const) {
            const context = await browser.newContext({
                baseURL: manifest.baseUrl,
                viewport: { width: 1920, height: 1080 },
                deviceScaleFactor: 1
            });
            contexts.push(context);
            await installDeviceIdentity(context, {
                kind: 'wall',
                device: manifest.devices[deviceKey]!,
                wallId: manifest.fixtures.multiWallId,
                col,
                row: 0
            });
            const wall = await context.newPage();
            pages.push(wall);
            await wall.goto(`/wall?w=${manifest.fixtures.multiWallId}&c=${col}&r=0`);
            await waitForWallBusReady(wall);
        }
        await page.evaluate(
            ({ graph, f }) => {
                const w = window as unknown as RuntimeWindow;
                w.__EDITOR_ENGINE__.bindWall(
                    f.multiWallId,
                    f.multiWallProjectId,
                    f.multiWallCommitId,
                    f.multiWallSlideId
                );
                w.__EDITOR_STORE__.getState().upsertLayer(graph);
                w.__EDITOR_ENGINE__.sendJSON({
                    type: 'upsert_layer',
                    origin: 'editor:network_test',
                    layer: graph
                });
            },
            { graph: layer, f: manifest.fixtures }
        );
        for (const wall of pages) {
            const canvas = wall.getByLabel('Network seam test', { exact: true });
            await expect(canvas).toBeVisible();
            expect(
                await canvas.evaluate((element) => [
                    (element as HTMLCanvasElement).width,
                    (element as HTMLCanvasElement).height
                ])
            ).toEqual([1920, 1080]);
        }
        const pixel = (wall: Page, x: number) =>
            wall
                .getByLabel('Network seam test', { exact: true })
                .evaluate(
                    (element, column) => [
                        ...(element as HTMLCanvasElement)
                            .getContext('2d')!
                            .getImageData(column, 540, 1, 1).data
                    ],
                    x
                );
        // Left tile sees neither endpoint, yet its middle must contain the edge.
        await expect.poll(() => pixel(pages[0]!, 1000)).toEqual([255, 255, 255, 255]);
        await expect.poll(() => pixel(pages[0]!, 1919)).toEqual([255, 255, 255, 255]);
        await expect.poll(() => pixel(pages[1]!, 0)).toEqual([255, 255, 255, 255]);
        // The label starts on the left tile and continues on the right; the
        // right tile must draw text even though its node is entirely offscreen.
        for (const [wall, x, width] of [
            [pages[0]!, 1909, 11],
            [pages[1]!, 0, 150]
        ] as const) {
            const countTextPixels = () =>
                wall.getByLabel('Network seam test', { exact: true }).evaluate(
                    (element, crop) => {
                        const pixels = (element as HTMLCanvasElement)
                            .getContext('2d')!
                            .getImageData(crop.x, 190, crop.width, 65).data;
                        let count = 0;
                        for (let i = 0; i < pixels.length; i += 4) {
                            if (pixels[i]! > 210 && pixels[i + 1]! > 210 && pixels[i + 2]! > 210)
                                count++;
                        }
                        return count;
                    },
                    { x, width }
                );
            await expect.poll(countTextPixels).toBeGreaterThan(10);
        }
        await pages[1]!.reload();
        await expect.poll(() => pixel(pages[1]!, 0)).toEqual([255, 255, 255, 255]);
        // No rectangular backplate: another layer can show through empty pixels.
        expect(
            await pages[0]!
                .getByLabel('Network seam test', { exact: true })
                .evaluate(
                    (element) =>
                        (element as HTMLCanvasElement).getContext('2d')!.getImageData(10, 10, 1, 1)
                            .data[3]
                )
        ).toBe(0);
        const broadcast = async () =>
            page.evaluate((graph) => {
                const w = window as unknown as RuntimeWindow;
                w.__EDITOR_STORE__.getState().upsertLayer(graph);
                w.__EDITOR_ENGINE__.sendJSON({
                    type: 'upsert_layer',
                    origin: 'editor:network_test',
                    layer: graph
                });
            }, layer);
        const sample = (wall: Page, key: string) =>
            wall.evaluate(
                ({ id, key }) => {
                    const frames = (
                        window as unknown as {
                            __WALL_ENGINE__: { networkFrames: NetworkFrameBuffer };
                        }
                    ).__WALL_ENGINE__?.networkFrames;
                    return frames?.sample(id, key);
                },
                { id: layer.numericId, key }
            );
        layer.network!.settings.paused = false;
        await broadcast();
        const liveKey = networkDocumentKey(layer.network!);
        for (const wall of pages)
            await expect
                .poll(async () => (await sample(wall, liveKey))?.view.data.nodes.length)
                .toBe(4);
        const moving = await sample(pages[0]!, liveKey);
        await expect
            .poll(async () => (await sample(pages[0]!, liveKey))?.view.positions)
            .not.toEqual(moving?.view.positions);
        // Freeze the shared simulation: both tiles must have exactly the same world.
        layer.network!.settings.paused = true;
        await broadcast();
        const pausedKey = networkDocumentKey(layer.network!);
        for (const wall of pages)
            await expect.poll(async () => !!(await sample(wall, pausedKey))).toBe(true);
        await expect
            .poll(async () => {
                const left = await sample(pages[0]!, pausedKey),
                    right = await sample(pages[1]!, pausedKey);
                return JSON.stringify(left?.view) === JSON.stringify(right?.view);
            })
            .toBe(true);
        const frozen = (await sample(pages[0]!, pausedKey))!.view;
        await pages[1]!.reload();
        await expect.poll(async () => (await sample(pages[1]!, pausedKey))?.view).toEqual(frozen);
        // Runtime nodes and positions never replace the authored project data.
        expect(
            await page.evaluate((id) => {
                const network = (window as unknown as RuntimeWindow).__EDITOR_STORE__
                    .getState()
                    .layers.get(id);
                return network?.type === 'graph' ? network.network?.data.nodes.length : 0;
            }, layer.numericId)
        ).toBe(4);
    } finally {
        await page.evaluate(
            (id) =>
                (window as unknown as RuntimeWindow).__EDITOR_STORE__.getState().removeLayer(id),
            layer.numericId
        );
        await save(page);
        await Promise.all(contexts.map((context) => context.close()));
    }
});
