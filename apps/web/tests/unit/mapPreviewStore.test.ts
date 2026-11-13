import { expect, test } from 'bun:test';

import {
    removeMapPreview,
    subscribeMapCanvasFrame,
    updateMapCanvas,
    useMapCanvasStore
} from '../../src/lib/mapPreviewStore';

test('every map frame redraws Konva without rerendering React', () => {
    const key = 'map-preview-frame-test';
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    let draws = 0;
    let redraws = 0;
    let storeUpdates = 0;
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ clearRect: () => {}, drawImage: () => draws++ })
    } as unknown as HTMLCanvasElement;
    const source = { width: 800, height: 400 } as HTMLCanvasElement;
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: { createElement: () => canvas }
    });
    const unsubscribeStore = useMapCanvasStore.subscribe(() => storeUpdates++);
    const unsubscribeFrame = subscribeMapCanvasFrame(key, () => redraws++);

    try {
        updateMapCanvas(key, source);
        expect(useMapCanvasStore.getState()[key]?.canvas).toBe(canvas);
        expect([draws, redraws, storeUpdates]).toEqual([1, 1, 1]);

        updateMapCanvas(key, source);
        expect([draws, redraws, storeUpdates]).toEqual([2, 2, 1]);

        updateMapCanvas(key, source);
        expect([draws, redraws, storeUpdates]).toEqual([3, 3, 1]);

        source.width = 900;
        updateMapCanvas(key, source);
        expect(canvas.width).toBe(900);
        expect([draws, redraws, storeUpdates]).toEqual([4, 4, 1]);
    } finally {
        unsubscribeFrame();
        unsubscribeStore();
        removeMapPreview(key);
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
        else Reflect.deleteProperty(globalThis, 'document');
    }
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
});
