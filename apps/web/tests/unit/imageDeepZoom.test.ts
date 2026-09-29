import { describe, expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';

import { OrthographicViewport } from '@deck.gl/core';
import { ImageDeepZoomAsset, type ImageDeepZoomLayer } from '@repo/db/schema';
import sharp from 'sharp';

import { createPastedLayers, snapshotCopyableLayers } from '../../src/lib/editorClipboard';
import {
    createEditorPlacementSession,
    createImagePlacementDraft,
    waitForImageReady
} from '../../src/lib/editorPlacementSession';
import {
    createImageRequestBudget,
    ImageTileset,
    imageTileTransform,
    tileGridBounds,
    MAX_TILE_ATLAS_PIXELS,
    MAX_TILE_ATLAS_SIDE,
    type ImageAffine
} from '../../src/lib/imageTiles';
import {
    canPreviewImageLocally,
    createImageDeepZoomLayerDescriptor,
    assetPickerFilename,
    assetPreviewFilename,
    canPlaceAsset,
    isAssetProcessing,
    toLibraryAsset,
    type AssetLibraryAsset,
    prepareMediaAsset,
    preserveImageDeepZoom
} from '../../src/lib/mediaUtils';
import {
    imagePinchWheelFactor,
    pinchImageTransform,
    scaleImageAroundPoint
} from '../../src/lib/stageGeometry';
import { GSMessageSchema, type Layer, type LayerWithEditorState } from '../../src/lib/types';

describe('Deep Zoom resource contract', () => {
    const dimensions = { schemaVersion: 1 as const, width: 1200, height: 650 };

    const tiles = {
        sourceId: 'img_fixture_v1',
        tileSize: 512 as const,
        maxZoom: 2,
        format: 'webp' as const
    };

    const asset = {
        id: '507f1f77bcf86cd799439011',
        previewUrl: 'img_fixture_v1.webp',
        deepZoom: { ...dimensions, status: 'ready' as const, tiles }
    };

    const oldLayer: Layer = {
        type: 'image',
        numericId: 12,
        url: '/api/assets/original.png',
        blurhash: 'existing',
        config: {
            cx: 40,
            cy: 20,
            width: 800,
            height: 600,
            rotation: 10,
            scaleX: 1,
            scaleY: 2,
            zIndex: 3,
            visible: true
        }
    };

    function roundTrip(layer: Layer): Layer {
        const upsert = GSMessageSchema.parse({
            type: 'upsert_layer',
            origin: 'editor:asset_library',
            layer
        });
        if (upsert.type !== 'upsert_layer') throw new Error('Unexpected message');
        // Commits store JSON layers; reopening sends them through the hydrate schema.
        const stored = JSON.parse(JSON.stringify(upsert.layer));
        const seed = GSMessageSchema.parse({ type: 'seed_scope', layers: [stored] });
        if (seed.type !== 'seed_scope') throw new Error('Unexpected message');
        const hydrate = GSMessageSchema.parse({ type: 'hydrate', layers: seed.layers });
        if (hydrate.type !== 'hydrate') throw new Error('Unexpected message');
        return hydrate.layers[0]!;
    }

    test('legacy assets/layers gain no fields and do not need metadata or file access', () => {
        expect(createImageDeepZoomLayerDescriptor({ id: asset.id })).toBeUndefined();
        const restored = roundTrip(oldLayer);
        expect(restored).toEqual(oldLayer);
        expect('deepZoom' in restored).toBe(false);
    });

    test('only a ready asset with a preview can produce a layer descriptor', () => {
        for (const status of ['queued', 'processing'] as const) {
            expect(() =>
                createImageDeepZoomLayerDescriptor({
                    ...asset,
                    deepZoom: { ...dimensions, status }
                })
            ).toThrow('not ready');
        }
        expect(() =>
            createImageDeepZoomLayerDescriptor({
                ...asset,
                deepZoom: { ...dimensions, status: 'failed', error: 'decode failed' }
            })
        ).toThrow('not ready');
        expect(() =>
            createImageDeepZoomLayerDescriptor({ ...asset, previewUrl: undefined })
        ).toThrow();
        expect(() => createImageDeepZoomLayerDescriptor({ ...asset, previewUrl: '' })).toThrow();
    });

    test('ready resource data survives upsert, JSON storage, seed and hydrate', () => {
        const deepZoom = createImageDeepZoomLayerDescriptor(asset)!;
        const layer: Layer = { ...oldLayer, deepZoom };
        expect(roundTrip(layer)).toEqual(layer);
        expect(roundTrip(layer).config).toEqual(oldLayer.config);
        expect(deepZoom).toEqual({
            ...dimensions,
            assetId: asset.id,
            previewUrl: asset.previewUrl,
            tiles
        });
        expect('status' in deepZoom).toBe(false);
    });

    test('a placed snapshot does not change when asset processing data changes', () => {
        const mutable = structuredClone(asset);
        const snapshot = createImageDeepZoomLayerDescriptor(mutable)!;
        mutable.deepZoom.tiles.sourceId = 'img_fixture_v2';
        mutable.deepZoom.width = 600;
        mutable.previewUrl = 'img_fixture_v2.webp';
        expect(snapshot.tiles.sourceId).toBe('img_fixture_v1');
        expect(snapshot.width).toBe(1200);
        expect(snapshot.previewUrl).toBe('img_fixture_v1.webp');
    });

    test('asset_added preserves new state while accepting old asset messages', () => {
        const oldAsset = {
            id: asset.id,
            name: 'original.png',
            url: 'original.png',
            size: 123,
            createdAt: '0',
            createdBy: 'test@example.com'
        };
        const projectId = '507f1f77bcf86cd799439012';
        const legacy = GSMessageSchema.parse({ type: 'asset_added', projectId, asset: oldAsset });
        if (legacy.type !== 'asset_added') throw new Error('Unexpected message');
        expect('deepZoom' in legacy.asset).toBe(false);
        const message = {
            type: 'asset_added' as const,
            projectId,
            asset: { ...oldAsset, previewUrl: asset.previewUrl, deepZoom: asset.deepZoom }
        };
        expect(GSMessageSchema.parse(message)).toEqual(message);
    });

    test('rejects incomplete ready results, unsafe source IDs and invalid dimensions', () => {
        expect(ImageDeepZoomAsset.safeParse({ ...dimensions, status: 'ready' }).success).toBe(
            false
        );
        expect(ImageDeepZoomAsset.safeParse({ ...asset.deepZoom, width: 0 }).success).toBe(false);
        expect(ImageDeepZoomAsset.safeParse({ ...asset.deepZoom, schemaVersion: 2 }).success).toBe(
            false
        );
        const descriptor = createImageDeepZoomLayerDescriptor(asset)!;
        const badTiles: ImageDeepZoomLayer['tiles'][] = [
            { ...tiles, sourceId: '../escape' },
            { ...tiles, sourceId: 'https://host/source' },
            { ...tiles, maxZoom: -1 },
            { ...tiles, maxZoom: 1.5 }
        ];
        for (const invalid of badTiles) {
            expect(
                GSMessageSchema.safeParse({
                    type: 'upsert_layer',
                    origin: 'test',
                    layer: { ...oldLayer, deepZoom: { ...descriptor, tiles: invalid } }
                }).success
            ).toBe(false);
        }
    });
});

describe('Image placement and scope', () => {
    const ready: AssetLibraryAsset = {
        id: '507f1f77bcf86cd799439011',
        name: 'large.tiff',
        url: 'original.tiff',
        previewUrl: 'img_fixture_v1.webp',
        deepZoom: {
            schemaVersion: 1,
            status: 'ready',
            width: 24000,
            height: 12000,
            tiles: { sourceId: 'img_fixture_v1', format: 'webp', tileSize: 512, maxZoom: 6 }
        }
    };

    const queued: AssetLibraryAsset = {
        ...ready,
        previewUrl: undefined,
        deepZoom: { schemaVersion: 1, status: 'queued', width: 24000, height: 12000 }
    };

    const failed: AssetLibraryAsset = {
        ...ready,
        deepZoom: { ...queued.deepZoom!, status: 'failed', error: 'decode failed' }
    };

    test('library mapping preserves processing state and never substitutes a Deep Zoom original for a missing preview', () => {
        expect(toLibraryAsset(ready).deepZoom).toEqual(ready.deepZoom);
        expect(assetPreviewFilename(ready)).toBe('img_fixture_v1.webp');
        expect(assetPickerFilename(ready)).toBe('img_fixture_v1.webp');
        expect(assetPreviewFilename(queued)).toBeUndefined();
        expect(canPlaceAsset(queued)).toBe(false);
        expect(canPlaceAsset(failed)).toBe(false);
        expect(canPlaceAsset({ ...ready, previewUrl: undefined })).toBe(false);
        expect(isAssetProcessing(queued)).toBe(true);
        const legacy = toLibraryAsset({ id: 'old', name: 'old.png', url: 'old.png', public: null });
        expect('deepZoom' in legacy).toBe(false);
        expect(assetPreviewFilename(legacy)).toBe('old.png');
        expect(canPlaceAsset(legacy)).toBe(true);
    });

    test('editor placement accepts processing previews while pickers and finalization still require ready', async () => {
        for (const status of ['queued', 'processing'] as const) {
            const preview = { ...ready, deepZoom: { ...queued.deepZoom!, status } };
            expect(canPlaceAsset(preview, { allowProcessing: true })).toBe(true);
            expect(canPlaceAsset(preview)).toBe(false);
            expect(
                canPlaceAsset({ ...preview, previewUrl: undefined }, { allowProcessing: true })
            ).toBe(false);
            let reads = 0;
            const result = await waitForImageReady({
                read: async () => (++reads === 1 ? preview : ready),
                signal: new AbortController().signal,
                intervalMs: 1
            });
            expect(reads).toBe(2);
            expect(result).toBe(ready);
        }
        expect(canPlaceAsset(failed, { allowProcessing: true })).toBe(false);
        expect(canPlaceAsset({ ...ready, previewUrl: '' }, { allowProcessing: true })).toBe(false);
    });

    test('ready tiled placement uses source dimensions without decoding media; ordinary assets retain their loader', async () => {
        let reads = 0;
        const loader = async () => {
            reads++;
            return { width: 600, height: 400, duration: 0 };
        };
        const media = await prepareMediaAsset(ready, loader);
        expect(media).toMatchObject({
            width: 24000,
            height: 12000,
            isVideo: false,
            deepZoom: { assetId: ready.id }
        });
        expect(reads).toBe(0);
        await rejects(prepareMediaAsset(queued, loader));
        await rejects(prepareMediaAsset(failed, loader));
        await rejects(prepareMediaAsset({ ...ready, previewUrl: undefined }, loader));
        expect(reads).toBe(0);
        expect(
            await prepareMediaAsset({ id: 'old', name: 'old.png', url: 'old.png' }, loader)
        ).toMatchObject({ width: 600, height: 400 });
        expect(reads).toBe(1);
    });

    test('legacy videos keep filename detection when MIME and URL extensions are absent', async () => {
        const media = await prepareMediaAsset(
            { id: 'legacy-video', name: 'existing.MP4', url: 'stored-without-extension' },
            async (isVideo) => {
                expect(isVideo).toBe(true);
                return { width: 1920, height: 1080, duration: 12 };
            }
        );
        expect(media).toEqual({
            isVideo: true,
            width: 1920,
            height: 1080,
            duration: 12,
            deepZoom: undefined
        });
    });

    test('upload completion waits through processing; failures and deletion never return a placeable asset', async () => {
        const states = [
            queued,
            { ...queued, deepZoom: { ...queued.deepZoom!, status: 'processing' as const } },
            ready
        ];
        const result = await waitForImageReady({
            read: async () => states.shift(),
            signal: new AbortController().signal,
            intervalMs: 1
        });
        expect(result).toEqual(ready);
        await rejects(
            waitForImageReady({
                read: async () => failed,
                signal: new AbortController().signal
            }),
            /decode failed/
        );
        let reads = 0;
        await rejects(
            waitForImageReady({
                read: async () => (++reads === 1 ? queued : undefined),
                signal: new AbortController().signal,
                intervalMs: 1
            }),
            /no longer available/
        );
    });

    test('cancelling a pending status request cannot produce a late placement result', async () => {
        const controller = new AbortController();
        let resolveStatus!: (asset: AssetLibraryAsset) => void;
        const pending = waitForImageReady({
            read: () =>
                new Promise((resolve) => {
                    resolveStatus = resolve;
                }),
            signal: controller.signal
        });
        controller.abort();
        await rejects(pending, { name: 'AbortError' });
        resolveStatus(ready);
    });

    test('status waiting has a deadline even if the network request never completes', async () => {
        await rejects(
            waitForImageReady({
                read: () => new Promise(() => {}),
                signal: new AbortController().signal,
                timeoutMs: 10
            }),
            { name: 'TimeoutError' }
        );
    });

    function sessionFixture() {
        let state = {
            projectId: 'project',
            commitId: 'commit',
            activeSlideId: 'slide',
            loading: false,
            placementEpoch: 0,
            insertionCenter: { x: 10, y: 20 },
            insertionViewport: { width: 1920, height: 1080 }
        };
        const listeners = new Set<(value: typeof state) => void>();
        const store = {
            getState: () => state,
            subscribe: (listener: (value: typeof state) => void) => {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            }
        };
        return {
            store,
            listeners,
            update(patch: Partial<typeof state>) {
                state = { ...state, ...patch };
                for (const listener of listeners) listener(state);
            }
        };
    }

    describe('asynchronous placement scope', () => {
        for (const field of ['projectId', 'commitId', 'activeSlideId'] as const) {
            test(`changing ${field} and returning cancels the old intent`, () => {
                const fixture = sessionFixture();
                const session = createEditorPlacementSession(fixture.store);
                const original = fixture.store.getState()[field];
                fixture.update({ [field]: 'other' });
                fixture.update({ [field]: original });
                expect(() => session.assertCurrent()).toThrow();
                session.dispose();
                expect(fixture.listeners.size).toBe(0);
            });
        }
        test('clearing the stage cancels pending work; ordinary edits keep the original insertion point', () => {
            const fixture = sessionFixture();
            const session = createEditorPlacementSession(fixture.store);
            fixture.update({ insertionCenter: { x: 999, y: 999 } });
            session.assertCurrent();
            expect(session.insertionCenter).toEqual({ x: 10, y: 20 });
            fixture.update({ placementEpoch: 1 });
            expect(() => session.assertCurrent()).toThrow();
            session.dispose();
        });
    });

    test('publishes processing previews before returning the ready resource', async () => {
        const processing = { ...queued, previewUrl: ready.previewUrl };
        const sequence = [queued, processing, ready];
        const updates: AssetLibraryAsset[] = [];
        expect(
            await waitForImageReady({
                read: async () => sequence.shift(),
                signal: new AbortController().signal,
                intervalMs: 1,
                onUpdate: (asset) => updates.push(asset)
            })
        ).toBe(ready);
        expect(updates).toEqual([queued, processing, ready]);
    });

    function uploadFixture() {
        const fixture = sessionFixture();
        const layers = new Map<number, LayerWithEditorState>();
        const store = {
            getState: () => ({
                ...fixture.store.getState(),
                layers,
                upsertLayer(layer: LayerWithEditorState) {
                    layers.set(layer.numericId, layer);
                    fixture.update({});
                }
            }),
            subscribe: fixture.store.subscribe
        };
        const start = (numericId = 50) => {
            const session = createEditorPlacementSession(store);
            const draft = createImagePlacementDraft(store, session, {
                numericId,
                type: 'image',
                url: '',
                isUploading: true,
                name: 'upload',
                config: {
                    cx: 10,
                    cy: 20,
                    width: 800,
                    height: 600,
                    scaleX: 1,
                    scaleY: 1,
                    rotation: 0,
                    zIndex: 7,
                    visible: true
                }
            });
            return { session, draft };
        };
        return { ...fixture, store, layers, start };
    }

    test('local preview, server preview and tiles retain one id and the latest edits', () => {
        const f = uploadFixture();
        const { session, draft } = f.start();
        draft.update({ url: 'blob:local' }, { width: 1200, height: 650 });
        // Match live drag/pinch's shadow state, including a mirror and rotation.
        const latest = draft.current();
        latest.name = 'Renamed while uploading';
        latest.config = {
            ...latest.config,
            cx: 345,
            cy: 678,
            width: 700,
            height: 330,
            scaleX: -2,
            scaleY: 1.5,
            rotation: 38,
            zIndex: 99,
            visible: false,
            locked: true
        };
        const config = { ...latest.config };
        draft.update({ url: '/api/assets/preview.webp' }, { width: 24000, height: 12000 });
        expect(draft.current().config).toEqual(config);
        expect(snapshotCopyableLayers(f.layers.values())).toEqual([]);
        const final = draft.update(
            {
                url: '/api/assets/original.tiff',
                deepZoom: createImageDeepZoomLayerDescriptor(ready)
            },
            undefined,
            true
        );
        expect(f.layers.size).toBe(1);
        expect(final.numericId).toBe(50);
        expect(final.name).toBe('Renamed while uploading');
        expect(final.config).toEqual(config);
        expect(final.isUploading).toBe(false);
        expect(final.deepZoom?.assetId).toBe(ready.id);
        expect(snapshotCopyableLayers(f.layers.values())).toHaveLength(1);
        session.assertCurrent();
        session.dispose();
        expect(f.listeners.size).toBe(0);
    });

    test('resizing the placeholder before metadata arrives is never overwritten', () => {
        const f = uploadFixture();
        const { session, draft } = f.start();
        draft.current().config.width = 999;
        draft.current().config.height = 123;
        draft.update({ url: '/api/assets/preview.webp' }, { width: 24000, height: 12000 });
        expect(draft.current().config).toMatchObject({ width: 999, height: 123 });
        draft.dispose();
        session.dispose();
    });

    test('deleting one of two concurrent uploads cancels only that placement', () => {
        const f = uploadFixture();
        const first = f.start(50),
            second = f.start(51);
        f.layers.delete(50);
        f.update({});
        expect(first.session.signal.aborted).toBe(true);
        expect(() => first.draft.update({ url: '/api/assets/late.webp' })).toThrow();
        expect(f.layers.has(50)).toBe(false);
        second.draft.update({ url: 'blob:second' });
        expect(second.draft.current().numericId).toBe(51);
        for (const item of [first, second]) {
            item.draft.dispose();
            item.session.dispose();
        }
        expect(f.listeners.size).toBe(0);
    });

    test('a ready remote layer reusing a draft id cancels the upload instead of overwriting it', () => {
        const f = uploadFixture();
        const { session, draft } = f.start();
        const remote = { ...draft.current(), url: '/api/assets/peer.png', isUploading: false };
        f.store.getState().upsertLayer(remote);
        expect(session.signal.aborted).toBe(true);
        expect(() => draft.update({ url: '/api/assets/late.webp' })).toThrow();
        expect(f.layers.get(50)).toBe(remote);
        draft.dispose();
        session.dispose();
    });

    test('upsert, copy and hydrate retain the immutable resource while accepting new geometry', async () => {
        const media = await prepareMediaAsset(ready, async () => {
            throw new Error('must not decode');
        });
        const layer: Layer = {
            type: 'image',
            numericId: 1,
            url: '/api/assets/original.tiff',
            deepZoom: media.deepZoom,
            config: {
                cx: 0,
                cy: 0,
                width: 100,
                height: 50,
                scaleX: 1,
                scaleY: 1,
                rotation: 0,
                zIndex: 1,
                visible: true
            }
        };
        const { deepZoom: _resource, ...oldClient } = layer;
        const updated = preserveImageDeepZoom<typeof layer>(layer, {
            ...oldClient,
            config: { ...layer.config, cx: 900, rotation: 35 }
        });
        expect(updated.deepZoom).toEqual(layer.deepZoom);
        expect(updated.config.cx).toBe(900);
        expect(updated.deepZoom).not.toBe(layer.deepZoom);
        expect(
            preserveImageDeepZoom<typeof layer>(layer, {
                ...oldClient,
                url: '/api/assets/different.png'
            }).deepZoom
        ).toBeUndefined();
        expect(preserveImageDeepZoom<typeof layer>(undefined, oldClient).deepZoom).toBeUndefined();
        const copied = createPastedLayers(
            snapshotCopyableLayers([updated]),
            1,
            () => 20,
            () => 30
        )[0]!;
        const hydrate = GSMessageSchema.parse({
            type: 'hydrate',
            layers: JSON.parse(JSON.stringify([copied]))
        });
        if (hydrate.type !== 'hydrate' || hydrate.layers[0]?.type !== 'image')
            throw new Error('Unexpected schema');
        expect(hydrate.layers[0].deepZoom).toEqual(layer.deepZoom);
        expect(hydrate.layers[0].numericId).toBe(20);
        expect(hydrate.layers[0].config.cx).toBe(920);
    });
});

describe('Image pinch geometry', () => {
    const base = { cx: 100, cy: 200, scaleX: 2, scaleY: 0.5, rotation: 37 };

    test('anchors the same image point under the cursor and keeps stretch/rotation', () => {
        const result = scaleImageAroundPoint(base, { x: 140, y: 180 }, 1.5);
        expect(result).toEqual({ cx: 80, cy: 210, scaleX: 3, scaleY: 0.75, rotation: 37 });
        expect((140 - result.cx) / result.scaleX).toBe((140 - base.cx) / base.scaleX);
        expect((180 - result.cy) / result.scaleY).toBe((180 - base.cy) / base.scaleY);
    });

    test('mirrored images retain their signs and both axes hit limits together', () => {
        const mirrored = { ...base, scaleX: -2 };
        expect(scaleImageAroundPoint(mirrored, { x: 100, y: 200 }, 1e9)).toMatchObject({
            scaleX: -1000,
            scaleY: 250
        });
        expect(scaleImageAroundPoint(mirrored, { x: 100, y: 200 }, 1e-9)).toMatchObject({
            scaleX: -0.4,
            scaleY: 0.1
        });
        for (const invalid of [0, -1, NaN, Infinity])
            expect(scaleImageAroundPoint(base, { x: 0, y: 0 }, invalid)).toEqual(base);
    });

    test('horizontal fingers work, moving midpoint pans, twist is preserved', () => {
        const result = pinchImageTransform(
            base,
            [
                { x: 0, y: 200 },
                { x: 200, y: 200 }
            ],
            [
                { x: 120, y: 10 },
                { x: 120, y: 410 }
            ]
        );
        expect(result.cx).toBeCloseTo(120);
        expect(result.cy).toBeCloseTo(210);
        expect(result.scaleX).toBe(4);
        expect(result.scaleY).toBe(1);
        expect(result.rotation).toBe(127);
    });

    test('touch pinch uses a fixed baseline and handles coincident fingers', () => {
        expect(
            pinchImageTransform(
                base,
                [
                    { x: 1, y: 1 },
                    { x: 1, y: 1 }
                ],
                [
                    { x: 0, y: 0 },
                    { x: 100, y: 100 }
                ]
            )
        ).toEqual(base);
        const start: [{ x: number; y: number }, { x: number; y: number }] = [
            { x: 0, y: 200 },
            { x: 200, y: 200 }
        ];
        expect(pinchImageTransform(base, start, start)).toEqual(base);
    });

    test('trackpad wheel normalizes delta units and bounds a single event', () => {
        expect(imagePinchWheelFactor(-20, 0, 800)).toBeCloseTo(Math.exp(0.2));
        expect(imagePinchWheelFactor(-1, 1, 800)).toBeCloseTo(Math.exp(0.16));
        expect(imagePinchWheelFactor(-0.1, 2, 800)).toBeCloseTo(Math.exp(0.8));
        expect(imagePinchWheelFactor(-1e6, 0, 800)).toBe(Math.E);
    });
});

describe('Tile selection and request limits', () => {
    function select(
        width: number,
        height: number,
        affine: ImageAffine,
        viewportX = 0,
        pixelRatio = 1
    ) {
        const maxZoom = Math.max(0, Math.ceil(Math.log2(Math.max(width, height) / 512)));
        const { matrix, zoomOffset } = imageTileTransform(affine);
        const tileset = new ImageTileset({
            width,
            height,
            tileSize: 512,
            extent: [0, 0, width, height],
            getTileData: () => null,
            zoomOffset
        });
        try {
            return tileset.getTileIndices({
                viewport: new OrthographicViewport({
                    width: 1920 * pixelRatio,
                    height: 1080 * pixelRatio,
                    target: [viewportX + 960, 540, 0],
                    zoom: Math.log2(pixelRatio),
                    flipY: true
                }),
                minZoom: -maxZoom,
                maxZoom: 0,
                zRange: null,
                modelMatrix: matrix,
                modelMatrixInverse: matrix.clone().invert()
            });
        } finally {
            tileset.finalize();
        }
    }

    test('adjacent wall viewports select different source tiles without requesting an entire panorama', () => {
        const first = select(16000, 4000, [1, 0, 0, 1, 0, 0]);
        const second = select(16000, 4000, [1, 0, 0, 1, 0, 0], 1920);
        expect(first.length).toBeGreaterThan(0);
        expect(second.length).toBeGreaterThan(0);
        expect(Math.max(...first.map((t) => t.x))).toBeLessThan(
            Math.max(...second.map((t) => t.x))
        );
        expect(first.length + second.length).toBeLessThan(32 * 8);
    });

    test('rotation, mirroring, independent scale and high DPR keep source bounds and bounded mosaics', () => {
        for (const [width, height, matrix] of [
            [8192, 3072, [0.5, 0.2, -0.4, 1, 800, -500]],
            [8192, 3072, [-0.5, 0, 0, 1, 4000, 0]],
            [131072, 1024, [4096 / 131072, 0, 0, 1, -1200, 0]]
        ] as const) {
            for (const dpr of [1, 2]) {
                const selected = select(width, height, matrix, 0, dpr);
                const bounds = tileGridBounds(selected, 512)!;
                expect(selected.length).toBeGreaterThan(0);
                expect(bounds.width).toBeLessThanOrEqual(MAX_TILE_ATLAS_SIDE);
                expect(bounds.height).toBeLessThanOrEqual(MAX_TILE_ATLAS_SIDE);
                expect(bounds.width * bounds.height).toBeLessThanOrEqual(MAX_TILE_ATLAS_PIXELS);
                expect(selected.length).toBe((bounds.width * bounds.height) / 512 ** 2);
                for (const tile of selected) {
                    expect(tile.x).toBeGreaterThanOrEqual(0);
                    expect(tile.y).toBeGreaterThanOrEqual(0);
                    expect(tile.x * 512 * 2 ** -tile.z).toBeLessThan(width);
                    expect(tile.y * 512 * 2 ** -tile.z).toBeLessThan(height);
                }
            }
        }
    });

    test('a shared request budget bounds multiple layers and cancelled queued work never starts', async () => {
        const run = createImageRequestBudget(2);
        let active = 0,
            peak = 0,
            queuedStarted = false;
        const releases: Array<() => void> = [];
        const pending = [0, 1].map(() =>
            run(new AbortController().signal, async () => {
                active++;
                peak = Math.max(peak, active);
                await new Promise<void>((resolve) => releases.push(resolve));
                active--;
            })
        );
        const cancel = new AbortController();
        const aborted = run(cancel.signal, async () => {
            queuedStarted = true;
        });
        cancel.abort();
        await rejects(aborted);
        for (const release of releases) release();
        await Promise.all(pending);
        expect(peak).toBe(2);
        expect(queuedStarted).toBe(false);
        await run(new AbortController().signal, async () => expect(active).toBe(0));
    });
});

describe('Bounded local upload previews', () => {
    test('reads PNG, JPEG and WebP headers, keeping TIFF and oversized images on the server', async () => {
        for (const format of ['png', 'jpeg', 'webp'] as const) {
            const bytes = await sharp({
                create: { width: 120, height: 65, channels: 3, background: '#ff0000' }
            })
                [format]()
                .toBuffer();
            expect(await canPreviewImageLocally(new Blob([bytes]))).toBe(true);
        }
        expect(await canPreviewImageLocally(new Blob(['II*\0']))).toBe(false);
        expect(await canPreviewImageLocally(new Blob(['broken']))).toBe(false);
        const header = new Uint8Array(24);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x89504e47);
        view.setUint32(4, 0x0d0a1a0a);
        view.setUint32(16, 50000);
        view.setUint32(20, 50000);
        expect(await canPreviewImageLocally(new Blob([header]))).toBe(false);
        view.setUint32(16, 5000);
        view.setUint32(20, 4000);
        expect(await canPreviewImageLocally(new Blob([header]))).toBe(false);
        const huge = new Blob([header]);
        Object.defineProperty(huge, 'size', { value: 108 * 1024 * 1024 });
        expect(await canPreviewImageLocally(huge)).toBe(false);
    });
});
