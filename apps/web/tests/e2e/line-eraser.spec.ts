import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from 'playwright/test';
import sharp from 'sharp';

import type { EditorEngine } from '../../src/lib/editorEngine';
import type { EditorStateCreator } from '../../src/lib/editorStore';
import type { GSMessage, Layer, LayerWithEditorState } from '../../src/lib/types';
import type { WallEngine } from '../../src/lib/wallEngine';

interface SeedManifest {
    baseUrl: string;
    fixtures: {
        wallId: string;
        multiWallId: string;
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
const PERFORMANCE_LAYER_ID = 60_010;
const PARTIAL_PERFORMANCE_LAYER_ID = 60_020;
const FAILURE_LAYER_ID = 60_030;
const WALL_SEAM_LAYER_ID = 60_040;
const MAX_GESTURE_DISPATCH_MS = 1_000;
const MAX_MOVE_P95_MS = 8;
const MAX_SINGLE_MOVE_MS = 150;
const MAX_MOUSE_UP_MS = 500;
const MAX_LOCAL_COMPLETION_MS = 2_000;
const MAX_SERVER_ROUND_TRIP_MS = 2_000;
const originalLine = [800, 600, 1_200, 600];
const erasedLinePaths = [
    [800, 600, 990, 600],
    [1_010, 600, 1_200, 600]
];
const originalWallPolylinePoints = ['0,1 400,1'];
const wallSeamLine = [1_800, 600, 2_040, 600];
type EditorLineLayer = Extract<LayerWithEditorState, { type: 'line' }>;

function readManifest(): SeedManifest {
    const filePath = resolve(process.cwd(), 'apps/web/tests/.fixtures/seed-manifest.json');
    return JSON.parse(readFileSync(filePath, 'utf8')) as SeedManifest;
}

function editorUrl(projectId: string, commitId: string, slideId: string): string {
    return `/quarry/editor/${projectId}/${commitId}/${slideId}`;
}

function makeLineLayer(numericId: number): EditorLineLayer {
    return {
        numericId,
        type: 'line',
        config: {
            cx: 1_000,
            cy: 600,
            width: 400,
            height: 10,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            zIndex: numericId,
            visible: true
        },
        line: originalLine,
        linePaths: [originalLine],
        strokeColor: '#ff0000',
        strokeWidth: 10,
        strokeDash: []
    };
}

function makeWallSeamLineLayer(): EditorLineLayer {
    return {
        ...makeLineLayer(WALL_SEAM_LAYER_ID),
        config: {
            ...makeLineLayer(WALL_SEAM_LAYER_ID).config,
            cx: 1_920,
            width: 240
        },
        line: wallSeamLine,
        linePaths: [wallSeamLine]
    };
}

function makeMalformedLineLayer(): EditorLineLayer {
    const malformedPath = [800, 600, 1_200];
    return {
        ...makeLineLayer(FAILURE_LAYER_ID),
        line: malformedPath,
        linePaths: [malformedPath]
    };
}

function makeDenseLineLayer(numericId: number): EditorLineLayer {
    const pointCount = 16_384;
    const line = new Array<number>(pointCount * 2);
    for (let index = 0; index < pointCount; index += 1) {
        line[index * 2] = 600 + (index * 5_900) / (pointCount - 1);
        line[index * 2 + 1] = 2_000 + Math.sin(index / 40) * 20;
    }

    return {
        numericId,
        type: 'line',
        config: {
            cx: 3_550,
            cy: 2_000,
            width: 5_900,
            height: 40,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            zIndex: numericId,
            visible: true
        },
        line,
        linePaths: [line],
        strokeColor: '#ff0000',
        strokeWidth: 10,
        strokeDash: []
    };
}

type GestureMetrics = {
    totalDispatchMs: number;
    maxMoveMs: number;
    p95MoveMs: number;
    mouseUpMs: number;
    scale: number;
    moveCount: number;
};

async function dispatchMeasuredEraserGesture(
    page: Page,
    path: { startX: number; startY: number; endX: number; endY: number; moveCount: number }
): Promise<GestureMetrics> {
    return page.evaluate((gesturePath) => {
        const target = document.querySelector<HTMLDivElement>('#slate .konvajs-content');
        if (!target) throw new Error('Editor canvas is unavailable');

        const rect = target.getBoundingClientRect();
        const scale = rect.height / (1_080 * 4);
        const dispatchMouse = (
            type: 'mousedown' | 'mousemove' | 'mouseup',
            logicalX: number,
            logicalY: number,
            buttons: number
        ) => {
            target.dispatchEvent(
                new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    clientX: rect.left + logicalX * scale,
                    clientY: rect.top + logicalY * scale,
                    button: 0,
                    buttons
                })
            );
        };

        const moveDurations: number[] = [];
        const startedAt = performance.now();
        dispatchMouse('mousedown', gesturePath.startX, gesturePath.startY, 1);
        for (let index = 1; index <= gesturePath.moveCount; index += 1) {
            const progress = index / gesturePath.moveCount;
            const logicalX =
                gesturePath.startX + (gesturePath.endX - gesturePath.startX) * progress;
            const logicalY =
                gesturePath.startY + (gesturePath.endY - gesturePath.startY) * progress;
            const moveStartedAt = performance.now();
            dispatchMouse('mousemove', logicalX, logicalY, 1);
            moveDurations.push(performance.now() - moveStartedAt);
        }
        const mouseUpStartedAt = performance.now();
        dispatchMouse('mouseup', gesturePath.endX, gesturePath.endY, 0);
        const mouseUpMs = performance.now() - mouseUpStartedAt;
        const totalDispatchMs = performance.now() - startedAt;
        const sortedMoveDurations = [...moveDurations].sort((a, b) => a - b);

        return {
            totalDispatchMs,
            maxMoveMs: sortedMoveDurations.at(-1) ?? 0,
            p95MoveMs: sortedMoveDurations[Math.floor(sortedMoveDurations.length * 0.95)] ?? 0,
            mouseUpMs,
            scale,
            moveCount: gesturePath.moveCount
        };
    }, path);
}

async function getCanvasClientPoint(
    page: Page,
    point: { x: number; y: number }
): Promise<{ x: number; y: number }> {
    return page.locator('#slate .konvajs-content').evaluate((target, logicalPoint) => {
        const rect = target.getBoundingClientRect();
        const scale = rect.height / (1_080 * 4);
        return {
            x: rect.left + logicalPoint.x * scale,
            y: rect.top + logicalPoint.y * scale
        };
    }, point);
}

async function selectLineFromLayerList(page: Page, layer: EditorLineLayer): Promise<void> {
    const isSelected = await page.evaluate(
        (id) =>
            (window as EditorWindow).__EDITOR_STORE__?.getState().selectedLayerIds[0] ===
            id.toString(),
        layer.numericId
    );
    if (!isSelected) {
        await page.locator(`[data-editor-layer-id="${layer.numericId}"]`).click();
    }

    await page.waitForFunction((id) => {
        const state = (window as EditorWindow).__EDITOR_STORE__?.getState();
        return state?.selectedLayerIds[0] === id.toString();
    }, layer.numericId);
}

async function dispatchMouseEraserGesture(
    page: Page,
    path: { startX: number; startY: number; endX: number; endY: number; moveCount: number }
): Promise<void> {
    const start = await getCanvasClientPoint(page, { x: path.startX, y: path.startY });
    const end = await getCanvasClientPoint(page, { x: path.endX, y: path.endY });

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let index = 1; index <= path.moveCount; index += 1) {
        const progress = index / path.moveCount;
        await page.mouse.move(
            start.x + (end.x - start.x) * progress,
            start.y + (end.y - start.y) * progress
        );
    }
    await page.mouse.up();
}

async function dispatchTouchEraserGesture(
    page: Page,
    path: { startX: number; startY: number; endX: number; endY: number; moveCount: number }
): Promise<void> {
    if (page.context().browser()?.browserType().name() === 'chromium') {
        const start = await getCanvasClientPoint(page, { x: path.startX, y: path.startY });
        const end = await getCanvasClientPoint(page, { x: path.endX, y: path.endY });
        const session = await page.context().newCDPSession(page);
        try {
            await session.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: [{ x: start.x, y: start.y }]
            });
            for (let index = 1; index <= path.moveCount; index += 1) {
                const progress = index / path.moveCount;
                await session.send('Input.dispatchTouchEvent', {
                    type: 'touchMove',
                    touchPoints: [
                        {
                            x: start.x + (end.x - start.x) * progress,
                            y: start.y + (end.y - start.y) * progress
                        }
                    ]
                });
            }
            await session.send('Input.dispatchTouchEvent', {
                type: 'touchEnd',
                touchPoints: []
            });
        } finally {
            await session.detach();
        }
        return;
    }

    await page.locator('#slate .konvajs-content').evaluate((target, gesturePath) => {
        const rect = target.getBoundingClientRect();
        const scale = rect.height / (1_080 * 4);
        const pointAt = (progress: number) => ({
            clientX:
                rect.left +
                (gesturePath.startX + (gesturePath.endX - gesturePath.startX) * progress) * scale,
            clientY:
                rect.top +
                (gesturePath.startY + (gesturePath.endY - gesturePath.startY) * progress) * scale
        });
        const dispatchTouch = (type: 'touchstart' | 'touchmove' | 'touchend', progress: number) => {
            const point = pointAt(progress);
            const touch = new Touch({
                identifier: 1,
                target,
                clientX: point.clientX,
                clientY: point.clientY
            });
            const activeTouches = type === 'touchend' ? [] : [touch];
            target.dispatchEvent(
                new TouchEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    touches: activeTouches,
                    targetTouches: activeTouches,
                    changedTouches: [touch]
                })
            );
        };

        dispatchTouch('touchstart', 0);
        for (let index = 1; index <= gesturePath.moveCount; index += 1) {
            dispatchTouch('touchmove', index / gesturePath.moveCount);
        }
        dispatchTouch('touchend', 1);
    }, path);
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

async function waitForLine(page: Page, numericId: number, paths: number[][]) {
    await expect
        .poll(
            () =>
                page.evaluate((expectedId) => {
                    const layer = (window as EditorWindow).__EDITOR_STORE__
                        ?.getState()
                        .layers.get(expectedId);
                    return layer?.type === 'line'
                        ? (layer.linePaths ?? (layer.line.length === 0 ? [] : [layer.line]))
                        : null;
                }, numericId),
            { timeout: 10_000 }
        )
        .toEqual(paths);
}

async function waitForSplitLine(page: Page, numericId: number): Promise<number[][]> {
    const readPaths = () =>
        page.evaluate((expectedId) => {
            const layer = (window as EditorWindow).__EDITOR_STORE__
                ?.getState()
                .layers.get(expectedId);
            return layer?.type === 'line'
                ? (layer.linePaths ?? (layer.line.length === 0 ? [] : [layer.line]))
                : null;
        }, numericId);

    await expect.poll(async () => (await readPaths())?.length, { timeout: 10_000 }).toBe(2);
    const paths = await readPaths();
    if (!paths) throw new Error('Expected a split line');
    return paths;
}

function toWallPolylinePoints(paths: number[][]): string[] {
    const xs = paths.flatMap((path) => path.filter((_, index) => index % 2 === 0));
    const ys = paths.flatMap((path) => path.filter((_, index) => index % 2 === 1));
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const width = Math.max(1, Math.round(maxX - minX));
    const height = Math.max(1, Math.round(maxY - minY));
    const cx = minX + (maxX - minX) / 2;
    const cy = minY + (maxY - minY) / 2;

    return paths.map((path) => {
        const points: string[] = [];
        for (let index = 0; index < path.length; index += 2) {
            points.push(
                `${Math.round(path[index] - cx + width / 2)},${Math.round(path[index + 1] - cy + height / 2)}`
            );
        }
        return points.join(' ');
    });
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

async function seedLocalLine(page: Page, layer: LayerWithEditorState): Promise<void> {
    await page.evaluate((nextLayer) => {
        (window as EditorWindow).__EDITOR_STORE__?.getState().upsertLayer(nextLayer);
    }, layer);
}

async function prepareEraserGesture(
    page: Page,
    layer: EditorLineLayer,
    width: 'minimum' | 'maximum'
): Promise<void> {
    await page.evaluate(() => {
        const editorWindow = window as EditorWindow & {
            __ERASER_TEST_MESSAGES__?: GSMessage[];
        };
        const store = editorWindow.__EDITOR_STORE__?.getState();
        const engine = editorWindow.__EDITOR_ENGINE__;
        if (!store || !engine) throw new Error('Editor test hooks are unavailable');

        if (!editorWindow.__ERASER_TEST_MESSAGES__) {
            editorWindow.__ERASER_TEST_MESSAGES__ = [];
            const sendJSON = engine.sendJSON.bind(engine);
            engine.sendJSON = (message: GSMessage) => {
                editorWindow.__ERASER_TEST_MESSAGES__?.push(message);
                return sendJSON(message);
            };
        } else {
            editorWindow.__ERASER_TEST_MESSAGES__.length = 0;
        }
    });

    const isAlreadyErasing = await page.evaluate(() =>
        Boolean((window as EditorWindow).__EDITOR_STORE__?.getState().isErasing)
    );
    if (isAlreadyErasing) await page.getByRole('button', { name: 'Eraser' }).click();

    await selectLineFromLayerList(page, layer);
    await page.getByRole('button', { name: 'Eraser' }).click();
    await page.getByRole('slider').press(width === 'maximum' ? 'End' : 'Home');
    await page.waitForFunction(
        (expectedWidth) => {
            const state = (window as EditorWindow).__EDITOR_STORE__?.getState();
            return state?.isErasing && state.eraserWidth === expectedWidth;
        },
        width === 'maximum' ? 1_000 : 10
    );
}

async function waitForServerLine(page: Page, numericId: number, paths: number[][]): Promise<void> {
    await page.evaluate(
        ({ expectedId, expectedPaths }) =>
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
                    const actualPaths =
                        layer?.type === 'line'
                            ? (layer.linePaths ?? (layer.line.length === 0 ? [] : [layer.line]))
                            : null;
                    if (
                        layer?.type !== 'line' ||
                        JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)
                    ) {
                        return;
                    }

                    window.clearTimeout(timeout);
                    unsubscribe();
                    resolvePromise();
                });
                engine.sendJSON({ type: 'rehydrate_please' });
            }),
        { expectedId: numericId, expectedPaths: paths }
    );
}

async function waitForServerLineStyle(
    page: Page,
    numericId: number,
    paths: number[][],
    strokeColor: string
): Promise<void> {
    await page.evaluate(
        ({ expectedId, expectedPaths, expectedStrokeColor }) =>
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
                    rejectPromise(new Error('Timed out waiting for styled server hydrate'));
                }, 10_000);

                unsubscribe = engine.subscribeToJson((message: GSMessage) => {
                    if (message.type !== 'hydrate') return;
                    const layer = message.layers.find(
                        (candidate: Layer) => candidate.numericId === expectedId
                    );
                    const actualPaths =
                        layer?.type === 'line'
                            ? (layer.linePaths ?? (layer.line.length === 0 ? [] : [layer.line]))
                            : null;
                    if (
                        layer?.type !== 'line' ||
                        layer.strokeColor !== expectedStrokeColor ||
                        JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)
                    ) {
                        return;
                    }

                    window.clearTimeout(timeout);
                    unsubscribe();
                    resolvePromise();
                });
                engine.sendJSON({ type: 'rehydrate_please' });
            }),
        {
            expectedId: numericId,
            expectedPaths: paths,
            expectedStrokeColor: strokeColor
        }
    );
}

async function waitForServerLineRemoved(page: Page, numericId: number): Promise<void> {
    await page.evaluate(
        (expectedId) =>
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
                    if (message.layers.some((layer: Layer) => layer.numericId === expectedId))
                        return;

                    window.clearTimeout(timeout);
                    unsubscribe();
                    resolvePromise();
                });
                engine.sendJSON({ type: 'rehydrate_please' });
            }),
        numericId
    );
}

async function sendLegacyLineUpsert(
    page: Page,
    numericId: number,
    strokeColor = '#00ff00'
): Promise<void> {
    await page.evaluate(
        ({ id, nextStrokeColor }) => {
            const editorWindow = window as EditorWindow;
            const layer = editorWindow.__EDITOR_STORE__?.getState().layers.get(id);
            const engine = editorWindow.__EDITOR_ENGINE__;
            if (!layer || layer.type !== 'line' || !engine) {
                throw new Error('Line or editor engine is unavailable');
            }

            const { linePaths: _linePaths, ...legacyLayer } = layer;
            engine.sendJSON({
                type: 'upsert_layer',
                origin: 'editor:legacy_line_upsert',
                layer: { ...legacyLayer, strokeColor: nextStrokeColor }
            });
        },
        { id: numericId, nextStrokeColor: strokeColor }
    );
}

async function removeTestLayer(page: Page, numericId: number): Promise<void> {
    await page.evaluate((id) => {
        const state = (window as EditorWindow).__EDITOR_STORE__?.getState();
        if (state?.layers.has(id)) state.removeLayer(id);
    }, numericId);
}

async function prepareWall(
    page: Page,
    manifest: SeedManifest,
    cell: { col: number; row: number; deviceKey?: string; wallId?: string } = {
        col: 0,
        row: 0
    }
): Promise<void> {
    const device = manifest.devices[cell.deviceKey ?? 'dev_wall_active'];
    if (!device) throw new Error('Active wall device is missing from the seed manifest');

    const wallId = cell.wallId ?? manifest.fixtures.wallId;
    const storageKey = `vizzy_device_identity_wall_c${cell.col}r${cell.row}_${wallId}_default`;
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

    await page.goto(`/wall?w=${encodeURIComponent(wallId)}&c=${cell.col}&r=${cell.row}`);
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

async function bindWall(
    page: Page,
    manifest: SeedManifest,
    wallId = manifest.fixtures.wallId
): Promise<void> {
    await page.evaluate(
        ({ wallId, projectId, commitId, slideId }) => {
            const engine = (window as EditorWindow).__EDITOR_ENGINE__;
            if (!engine) throw new Error('Editor engine is unavailable');
            engine.bindWall(wallId, projectId, commitId, slideId);
        },
        {
            wallId,
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

async function waitForWallLine(page: Page, numericId: number, paths: number[][]) {
    await page.waitForFunction(
        ({ expectedId, expectedPaths }) =>
            (window as WallWindow).__LINE_ERASER_MESSAGES__?.some((message) => {
                if (
                    message.type !== 'upsert_layer' ||
                    message.layer.numericId !== expectedId ||
                    message.layer.type !== 'line'
                ) {
                    return false;
                }
                const actualPaths =
                    message.layer.linePaths ??
                    (message.layer.line.length === 0 ? [] : [message.layer.line]);
                return JSON.stringify(actualPaths) === JSON.stringify(expectedPaths);
            }),
        { expectedId: numericId, expectedPaths: paths }
    );
}

async function waitForWallLineStyle(
    page: Page,
    numericId: number,
    paths: number[][],
    strokeColor: string
) {
    await page.waitForFunction(
        ({ expectedId, expectedPaths, expectedStrokeColor }) =>
            (window as WallWindow).__LINE_ERASER_MESSAGES__?.some((message) => {
                if (
                    message.type !== 'upsert_layer' ||
                    message.layer.numericId !== expectedId ||
                    message.layer.type !== 'line' ||
                    message.layer.strokeColor !== expectedStrokeColor
                ) {
                    return false;
                }
                const actualPaths = message.layer.linePaths ?? [message.layer.line];
                return JSON.stringify(actualPaths) === JSON.stringify(expectedPaths);
            }),
        {
            expectedId: numericId,
            expectedPaths: paths,
            expectedStrokeColor: strokeColor
        }
    );
}

async function expectWallRenderedLine(
    page: Page,
    numericId: number,
    expectedPolylinePoints: string[],
    dimensions: { width: number; height: number } = { width: 400, height: 1 }
): Promise<void> {
    const layer = page.locator(`[data-layer-id="${numericId}"]`);
    await expect(layer).toHaveCount(1);
    await expect(layer.locator('svg')).toHaveAttribute('width', dimensions.width.toString());
    await expect(layer.locator('svg')).toHaveAttribute('height', dimensions.height.toString());

    const polylines = layer.locator('polyline');
    await expect(polylines).toHaveCount(expectedPolylinePoints.length);
    for (let index = 0; index < expectedPolylinePoints.length; index += 1) {
        await expect(polylines.nth(index)).toHaveAttribute(
            'data-line-path-index',
            index.toString()
        );
        await expect(polylines.nth(index)).toHaveAttribute('points', expectedPolylinePoints[index]);
    }
}

function expectResponsiveGesture(metrics: GestureMetrics): void {
    expect(metrics.totalDispatchMs).toBeLessThan(MAX_GESTURE_DISPATCH_MS);
    expect(metrics.p95MoveMs).toBeLessThan(MAX_MOVE_P95_MS);
    expect(metrics.maxMoveMs).toBeLessThan(MAX_SINGLE_MOVE_MS);
    expect(metrics.mouseUpMs).toBeLessThan(MAX_MOUSE_UP_MS);
}

async function countRedPixels(
    page: Page,
    clip: { x: number; y: number; width: number; height: number }
): Promise<number> {
    const png = await page.screenshot({ clip });
    const { data, info } = await sharp(png)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    let count = 0;
    for (let offset = 0; offset < data.length; offset += info.channels) {
        if (
            data[offset] > 150 &&
            data[offset + 1] < 100 &&
            data[offset + 2] < 100 &&
            data[offset + 3] > 100
        ) {
            count += 1;
        }
    }
    return count;
}

async function waitForWallVisualReady(page: Page): Promise<void> {
    await expect(page.locator('div.pointer-events-none.absolute.inset-0.bg-black')).toHaveCSS(
        'opacity',
        '0'
    );
    await page.evaluate(
        () =>
            new Promise<void>((resolvePromise) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolvePromise()));
            })
    );
}

test.use({ storageState: 'apps/web/tests/.auth/user_editor.json' });
test.describe.configure({ mode: 'serial' });

test('erased line survives a legacy upsert, keyboard save, and reload @webkit-touch', async ({
    page
}) => {
    const manifest = readManifest();
    const { privateProjectId, privateCommitId, privateSlideId } = manifest.fixtures;
    const layer = makeLineLayer(SAVE_RELOAD_LAYER_ID);

    await page.goto(editorUrl(privateProjectId, privateCommitId, privateSlideId));
    await waitForEditor(page, privateSlideId);

    try {
        await seedLine(page, layer);
        await waitForServerLine(page, layer.numericId, [originalLine]);
        await prepareEraserGesture(page, layer, 'minimum');
        await dispatchTouchEraserGesture(page, {
            startX: 1_000,
            startY: 500,
            endX: 1_000,
            endY: 700,
            moveCount: 20
        });
        await Promise.all([
            waitForLine(page, layer.numericId, erasedLinePaths),
            waitForServerLine(page, layer.numericId, erasedLinePaths)
        ]);

        await sendLegacyLineUpsert(page, layer.numericId);
        await waitForServerLineStyle(page, layer.numericId, erasedLinePaths, '#00ff00');

        await page.keyboard.press('ControlOrMeta+s');
        await page.waitForFunction(
            () => (window as EditorWindow).__EDITOR_STORE__?.getState().saveStatus === 'saved'
        );

        await page.reload();
        await waitForEditor(page, privateSlideId);
        await waitForLine(page, layer.numericId, erasedLinePaths);
        await expect
            .poll(() =>
                page.evaluate((id) => {
                    const currentLayer = (window as EditorWindow).__EDITOR_STORE__
                        ?.getState()
                        .layers.get(id);
                    return currentLayer?.type === 'line' ? currentLayer.strokeColor : null;
                }, layer.numericId)
            )
            .toBe('#00ff00');
    } finally {
        await removeTestLayer(page, layer.numericId);
    }
});

test('invalid line geometry shows an error and rolls back the entire real gesture', async ({
    page
}) => {
    const manifest = readManifest();
    const { privateProjectId, privateCommitId, privateSlideId } = manifest.fixtures;
    const layer = makeMalformedLineLayer();
    const warnings: string[] = [];

    page.on('console', (message) => {
        if (message.text().includes('[LineEraser]')) warnings.push(message.text());
    });

    await page.goto(editorUrl(privateProjectId, privateCommitId, privateSlideId));
    await waitForEditor(page, privateSlideId);

    try {
        await seedLocalLine(page, layer);
        await prepareEraserGesture(page, layer, 'minimum');
        await dispatchMouseEraserGesture(page, {
            startX: 1_000,
            startY: 500,
            endX: 1_000,
            endY: 700,
            moveCount: 20
        });

        await expect(
            page.locator('[data-sonner-toast]').filter({
                hasText: 'Eraser stopped because this line contains invalid geometry'
            })
        ).toBeVisible();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('invalid_line_paths');

        const outcome = await page.evaluate((id) => {
            const editorWindow = window as EditorWindow & {
                __ERASER_TEST_MESSAGES__?: GSMessage[];
            };
            const currentLayer = editorWindow.__EDITOR_STORE__?.getState().layers.get(id);
            const writes = (editorWindow.__ERASER_TEST_MESSAGES__ ?? []).filter(
                (message) =>
                    (message.type === 'upsert_layer' && message.layer.numericId === id) ||
                    (message.type === 'delete_layer' && message.numericId === id)
            );
            return {
                paths:
                    currentLayer?.type === 'line'
                        ? (currentLayer.linePaths ?? [currentLayer.line])
                        : null,
                writeCount: writes.length
            };
        }, layer.numericId);

        expect(outcome).toEqual({ paths: layer.linePaths, writeCount: 0 });
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
            waitForLine(secondEditor, layer.numericId, [originalLine]),
            waitForWallLine(wall, layer.numericId, [originalLine])
        ]);
        await expectWallRenderedLine(wall, layer.numericId, originalWallPolylinePoints);

        await prepareEraserGesture(page, layer, 'minimum');
        await dispatchMouseEraserGesture(page, {
            startX: 1_000,
            startY: 500,
            endX: 1_000,
            endY: 700,
            moveCount: 20
        });
        const actualErasedPaths = await waitForSplitLine(page, layer.numericId);
        expect(actualErasedPaths[0].slice(0, 2)).toEqual(originalLine.slice(0, 2));
        expect(actualErasedPaths[1].slice(-2)).toEqual(originalLine.slice(-2));
        expect(actualErasedPaths[0].at(-2)).toBeLessThan(actualErasedPaths[1][0]);

        await Promise.all([
            waitForLine(secondEditor, layer.numericId, actualErasedPaths),
            waitForWallLine(wall, layer.numericId, actualErasedPaths)
        ]);
        await expectWallRenderedLine(
            wall,
            layer.numericId,
            toWallPolylinePoints(actualErasedPaths)
        );

        await sendLegacyLineUpsert(secondEditor, layer.numericId);
        await Promise.all([
            expect
                .poll(() =>
                    page.evaluate((id) => {
                        const currentLayer = (window as EditorWindow).__EDITOR_STORE__
                            ?.getState()
                            .layers.get(id);
                        return currentLayer?.type === 'line'
                            ? {
                                  paths: currentLayer.linePaths ?? [currentLayer.line],
                                  strokeColor: currentLayer.strokeColor
                              }
                            : null;
                    }, layer.numericId)
                )
                .toEqual({ paths: actualErasedPaths, strokeColor: '#00ff00' }),
            waitForWallLineStyle(wall, layer.numericId, actualErasedPaths, '#00ff00')
        ]);
        await waitForServerLineStyle(page, layer.numericId, actualErasedPaths, '#00ff00');
        await expect(
            wall.locator(`[data-layer-id="${layer.numericId}"] polyline`).first()
        ).toHaveAttribute('stroke', '#00ff00');
    } finally {
        await cleanUpCollaboration(page, layer.numericId);
        await wallContext.close();
    }
});

test('one eraser gesture produces the same cut across two adjacent Wall screens', async ({
    browser,
    page
}) => {
    test.setTimeout(90_000);
    const manifest = readManifest();
    const { publicProjectId, publicCommitId, publicSlideId } = manifest.fixtures;
    const layer = makeWallSeamLineLayer();
    const leftContext = await browser.newContext({
        baseURL: manifest.baseUrl,
        viewport: { width: 1_920, height: 1_080 },
        deviceScaleFactor: 1
    });
    const rightContext = await browser.newContext({
        baseURL: manifest.baseUrl,
        viewport: { width: 1_920, height: 1_080 },
        deviceScaleFactor: 1
    });
    const leftWall = await leftContext.newPage();
    const rightWall = await rightContext.newPage();
    const wallId = manifest.fixtures.multiWallId;

    try {
        await Promise.all([
            page.goto(editorUrl(publicProjectId, publicCommitId, publicSlideId)),
            prepareWall(leftWall, manifest, {
                col: 0,
                row: 0,
                deviceKey: 'dev_wall_grid_00',
                wallId
            }),
            prepareWall(rightWall, manifest, {
                col: 1,
                row: 0,
                deviceKey: 'dev_wall_grid_10',
                wallId
            })
        ]);
        await waitForEditor(page, publicSlideId);
        await bindWall(page, manifest, wallId);
        await Promise.all([
            waitForWallHydrate(leftWall, manifest),
            waitForWallHydrate(rightWall, manifest)
        ]);

        await seedLine(page, layer);
        await Promise.all([
            waitForWallLine(leftWall, layer.numericId, [wallSeamLine]),
            waitForWallLine(rightWall, layer.numericId, [wallSeamLine])
        ]);
        await Promise.all([
            expectWallRenderedLine(leftWall, layer.numericId, ['0,1 240,1'], {
                width: 240,
                height: 1
            }),
            expectWallRenderedLine(rightWall, layer.numericId, ['0,1 240,1'], {
                width: 240,
                height: 1
            })
        ]);
        await Promise.all([waitForWallVisualReady(leftWall), waitForWallVisualReady(rightWall)]);
        await expect
            .poll(() =>
                leftWall
                    .locator(`[data-layer-id="${layer.numericId}"]`)
                    .evaluate((element) => (element as HTMLElement).style.transform)
            )
            .toBe('translate3d(1800px, 595px, 0px) rotate(0deg) scale(1, 1)');
        await expect
            .poll(() =>
                rightWall
                    .locator(`[data-layer-id="${layer.numericId}"]`)
                    .evaluate((element) => (element as HTMLElement).style.transform)
            )
            .toBe('translate3d(-120px, 595px, 0px) rotate(0deg) scale(1, 1)');

        expect(
            await countRedPixels(leftWall, { x: 1_916, y: 594, width: 4, height: 12 })
        ).toBeGreaterThan(0);
        expect(
            await countRedPixels(rightWall, { x: 0, y: 594, width: 4, height: 12 })
        ).toBeGreaterThan(0);

        await prepareEraserGesture(page, layer, 'minimum');
        await dispatchMouseEraserGesture(page, {
            startX: 1_920,
            startY: 500,
            endX: 1_920,
            endY: 700,
            moveCount: 20
        });
        const finalPaths = await waitForSplitLine(page, layer.numericId);

        await Promise.all([
            waitForWallLine(leftWall, layer.numericId, finalPaths),
            waitForWallLine(rightWall, layer.numericId, finalPaths)
        ]);
        const expectedPoints = toWallPolylinePoints(finalPaths);
        await Promise.all([
            expectWallRenderedLine(leftWall, layer.numericId, expectedPoints, {
                width: 240,
                height: 1
            }),
            expectWallRenderedLine(rightWall, layer.numericId, expectedPoints, {
                width: 240,
                height: 1
            })
        ]);

        expect(await countRedPixels(leftWall, { x: 1_916, y: 594, width: 4, height: 12 })).toBe(0);
        expect(await countRedPixels(rightWall, { x: 0, y: 594, width: 4, height: 12 })).toBe(0);
        expect(
            await countRedPixels(leftWall, { x: 1_880, y: 594, width: 20, height: 12 })
        ).toBeGreaterThan(0);
        expect(
            await countRedPixels(rightWall, { x: 20, y: 594, width: 20, height: 12 })
        ).toBeGreaterThan(0);
    } finally {
        await cleanUpCollaboration(page, layer.numericId);
        await Promise.all([leftContext.close(), rightContext.close()]);
    }
});

test('maximum-size eraser completes a long real canvas gesture without dropping batches', async ({
    page
}) => {
    const manifest = readManifest();
    const { privateProjectId, privateCommitId, privateSlideId } = manifest.fixtures;
    const url = editorUrl(privateProjectId, privateCommitId, privateSlideId);
    const lineIds = [PERFORMANCE_LAYER_ID, PERFORMANCE_LAYER_ID + 1, PERFORMANCE_LAYER_ID + 2];
    const lineEraserWarnings: string[] = [];

    page.on('console', (message) => {
        if (message.text().includes('[LineEraser]')) lineEraserWarnings.push(message.text());
    });

    await page.goto(url);
    await waitForEditor(page, privateSlideId);

    const samples: Array<
        GestureMetrics & { localCompletionMs: number; serverRoundTripMs: number }
    > = [];

    try {
        for (const numericId of lineIds) {
            const layer = makeDenseLineLayer(numericId);
            await seedLine(page, layer);
            await waitForServerLine(page, numericId, [layer.line]);

            await prepareEraserGesture(page, layer, 'maximum');

            const metrics = await dispatchMeasuredEraserGesture(page, {
                startX: 500,
                startY: 2_000,
                endX: 6_600,
                endY: 2_000,
                moveCount: 2_500
            });
            const localStartedAt = Date.now();
            await page.waitForFunction(
                (id) => !(window as EditorWindow).__EDITOR_STORE__?.getState().layers.has(id),
                numericId
            );
            const localCompletionMs = Date.now() - localStartedAt;
            const finalMessages = await page.evaluate((id) => {
                const messages = (
                    window as EditorWindow & { __ERASER_TEST_MESSAGES__?: GSMessage[] }
                ).__ERASER_TEST_MESSAGES__;
                return (messages ?? []).filter(
                    (message) => message.type === 'delete_layer' && message.numericId === id
                ).length;
            }, numericId);

            expect(finalMessages).toBe(1);
            expectResponsiveGesture(metrics);
            expect(localCompletionMs).toBeLessThan(MAX_LOCAL_COMPLETION_MS);
            const serverStartedAt = Date.now();
            await waitForServerLineRemoved(page, numericId);
            const serverRoundTripMs = Date.now() - serverStartedAt;
            expect(serverRoundTripMs).toBeLessThan(MAX_SERVER_ROUND_TRIP_MS);
            samples.push({ ...metrics, localCompletionMs, serverRoundTripMs });
        }

        expect(lineEraserWarnings).toEqual([]);
        await expect(
            page.locator('[data-sonner-toast]').filter({ hasText: 'Eraser stopped' })
        ).toHaveCount(0);

        console.log(`[line-eraser-performance] ${JSON.stringify(samples)}`);
    } finally {
        for (const numericId of lineIds) await cleanUpCollaboration(page, numericId);
    }
});

test('maximum-size eraser persists a large partial linePaths result with one upsert', async ({
    page
}) => {
    const manifest = readManifest();
    const { privateProjectId, privateCommitId, privateSlideId } = manifest.fixtures;
    const url = editorUrl(privateProjectId, privateCommitId, privateSlideId);
    const lineIds = [
        PARTIAL_PERFORMANCE_LAYER_ID,
        PARTIAL_PERFORMANCE_LAYER_ID + 1,
        PARTIAL_PERFORMANCE_LAYER_ID + 2
    ];
    const lineEraserWarnings: string[] = [];

    page.on('console', (message) => {
        if (message.text().includes('[LineEraser]')) lineEraserWarnings.push(message.text());
    });

    await page.goto(url);
    await waitForEditor(page, privateSlideId);

    const samples: Array<
        GestureMetrics & {
            outputPaths: number;
            outputPoints: number;
            localCompletionMs: number;
            serverRoundTripMs: number;
        }
    > = [];

    try {
        for (const numericId of lineIds) {
            const layer = makeDenseLineLayer(numericId);
            await seedLine(page, layer);
            await waitForServerLine(page, numericId, [layer.line]);
            await prepareEraserGesture(page, layer, 'maximum');

            const metrics = await dispatchMeasuredEraserGesture(page, {
                startX: 3_550,
                startY: 1_000,
                endX: 3_550,
                endY: 3_000,
                moveCount: 2_500
            });
            const localStartedAt = Date.now();
            const finalPaths = await waitForSplitLine(page, numericId);
            const localCompletionMs = Date.now() - localStartedAt;

            const outputPoints = finalPaths.reduce(
                (total, linePath) => total + linePath.length / 2,
                0
            );
            const finalMessages = await page.evaluate((id) => {
                const messages = (
                    window as EditorWindow & { __ERASER_TEST_MESSAGES__?: GSMessage[] }
                ).__ERASER_TEST_MESSAGES__;
                return (messages ?? []).filter(
                    (message) =>
                        message.type === 'upsert_layer' &&
                        message.origin === 'editor:erase_line_layer' &&
                        message.layer.numericId === id
                ).length;
            }, numericId);

            expect(finalPaths).toHaveLength(2);
            expect(outputPoints).toBeGreaterThan(5_000);
            expect(outputPoints).toBeLessThan(16_384);
            expect(finalMessages).toBe(1);
            expectResponsiveGesture(metrics);
            expect(localCompletionMs).toBeLessThan(MAX_LOCAL_COMPLETION_MS);
            const serverStartedAt = Date.now();
            await waitForServerLine(page, numericId, finalPaths);
            const serverRoundTripMs = Date.now() - serverStartedAt;
            expect(serverRoundTripMs).toBeLessThan(MAX_SERVER_ROUND_TRIP_MS);
            samples.push({
                ...metrics,
                outputPaths: finalPaths.length,
                outputPoints,
                localCompletionMs,
                serverRoundTripMs
            });
        }

        expect(lineEraserWarnings).toEqual([]);
        await expect(
            page.locator('[data-sonner-toast]').filter({ hasText: 'Eraser stopped' })
        ).toHaveCount(0);

        console.log(`[line-eraser-partial-performance] ${JSON.stringify(samples)}`);
    } finally {
        for (const numericId of lineIds) await cleanUpCollaboration(page, numericId);
    }
});
