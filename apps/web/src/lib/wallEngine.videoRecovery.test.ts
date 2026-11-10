import { afterEach, describe, expect, mock, test } from 'bun:test';

import type { LayerWithWallComponentState } from './types';
import type { WallEngine as WallEngineType } from './wallEngine';

mock.module('./buildInfo', () => ({ buildInfo: { commitSha: 'test', builtAt: 'test' } }));
const { WallEngine } = await import('./wallEngine');

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

afterEach(() => {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
});

function makeHarness() {
    let elapsed = 0;
    const serverAnchor = 100_000;
    let nextId = 0;
    const animationFrames = new Map<number, FrameRequestCallback>();
    globalThis.requestAnimationFrame = (callback) => {
        const id = ++nextId;
        animationFrames.set(id, callback);
        return id;
    };
    globalThis.cancelAnimationFrame = (id) => {
        animationFrames.delete(id);
    };

    const engine = Object.create(WallEngine.prototype) as WallEngineType;
    Object.assign(engine, {
        layers: new Map(),
        playbackStartRafs: new Map(),
        playbackDriftRafs: new Map(),
        videoRecovery: new Map(),
        monotonicNow: () => elapsed,
        getServerTime: () => serverAnchor + elapsed
    });

    function makeVideo(numericId: number) {
        let currentTime = 0;
        let nextFrameId = 0;
        let loadCount = 0;
        let playCount = 0;
        const seeks: number[] = [];
        const frameCallbacks = new Map<number, VideoFrameRequestCallback>();
        const loadListeners = new Set<EventListenerOrEventListenerObject>();
        const video = {
            get currentTime() {
                return currentTime;
            },
            set currentTime(value: number) {
                seeks.push(value);
                currentTime = value;
            },
            readyState: 4,
            isConnected: true,
            playbackRate: 1,
            play: () => {
                playCount++;
                return Promise.resolve();
            },
            pause: () => {},
            load: () => {
                loadCount++;
                video.readyState = 0;
            },
            requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => {
                const id = ++nextFrameId;
                frameCallbacks.set(id, callback);
                return id;
            },
            cancelVideoFrameCallback: (id: number) => {
                frameCallbacks.delete(id);
            },
            addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
                if (type === 'loadeddata') loadListeners.add(listener);
            },
            removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
                if (type === 'loadeddata') loadListeners.delete(listener);
            }
        };
        const layer = {
            numericId,
            type: 'video',
            url: '/clip.mp4',
            loop: true,
            duration: 10,
            rvfcActive: false,
            playback: {
                status: 'playing',
                anchorMediaTime: 0,
                anchorServerTime: serverAnchor
            },
            config: {
                cx: 0,
                cy: 0,
                width: 100,
                height: 100,
                scaleX: 1,
                scaleY: 1,
                rotation: 0,
                zIndex: 0,
                visible: true
            }
        } as LayerWithWallComponentState;
        engine.registerLayer(layer, video as unknown as HTMLVideoElement);
        return {
            video,
            layer,
            seeks,
            get pendingFrameCount() {
                return frameCallbacks.size;
            },
            get loadCount() {
                return loadCount;
            },
            get playCount() {
                return playCount;
            },
            emitFrame() {
                const [id, callback] = frameCallbacks.entries().next().value ?? [];
                if (id === undefined || !callback)
                    throw new Error('No pending video frame callback');
                frameCallbacks.delete(id);
                callback(elapsed, {} as VideoFrameCallbackMetadata);
            },
            finishLoad() {
                video.readyState = 4;
                for (const listener of [...loadListeners]) {
                    loadListeners.delete(listener);
                    if (typeof listener === 'function') listener(new Event('loadeddata'));
                    else listener.handleEvent(new Event('loadeddata'));
                }
            }
        };
    }

    return {
        engine,
        makeVideo,
        setElapsed(value: number) {
            elapsed = value;
        },
        runAnimationFrames() {
            const callbacks = [...animationFrames.values()];
            animationFrames.clear();
            callbacks.forEach((callback) => callback(elapsed));
        },
        checkStalls() {
            engine['checkForStalledVideos']();
        }
    };
}

describe('wall video recovery', () => {
    test('detects a missing first frame without waiting for a frame callback', () => {
        const harness = makeHarness();
        const video = harness.makeVideo(1);
        harness.runAnimationFrames();

        harness.setElapsed(4_999);
        harness.checkStalls();
        expect(video.seeks).toEqual([]);

        harness.setElapsed(5_000);
        harness.checkStalls();
        expect(video.seeks).toEqual([5]);
        expect(video.loadCount).toBe(0);

        harness.setElapsed(6_000);
        harness.checkStalls();
        expect(video.seeks).toEqual([5]);

        harness.setElapsed(7_000);
        harness.checkStalls();
        expect(video.loadCount).toBe(1);
    });

    test('recovers only the stalled wall and resumes at the current shared time', () => {
        const harness = makeHarness();
        const stalled = harness.makeVideo(1);
        const healthy = harness.makeVideo(2);
        harness.runAnimationFrames();

        harness.setElapsed(100);
        stalled.emitFrame();
        healthy.emitFrame();
        harness.setElapsed(1_500);
        healthy.video.currentTime = 1.5;
        healthy.emitFrame();
        const healthySeekCount = healthy.seeks.length;
        harness.setElapsed(1_600);
        harness.checkStalls();
        expect(stalled.seeks.at(-1)).toBe(1.6);
        expect(healthy.seeks).toHaveLength(healthySeekCount);

        harness.setElapsed(1_800);
        stalled.emitFrame();
        harness.setElapsed(3_600);
        harness.checkStalls();
        expect(stalled.loadCount).toBe(1);
        expect(healthy.loadCount).toBe(0);

        harness.setElapsed(3_700);
        stalled.finishLoad();
        harness.runAnimationFrames();
        expect(stalled.seeks.at(-1)).toBe(3.7);
        stalled.emitFrame();
        harness.setElapsed(3_800);
        stalled.emitFrame();
        harness.setElapsed(5_000);
        harness.checkStalls();
        expect(stalled.loadCount).toBe(1);
    });

    test('does not duplicate frame callbacks after registration and ignores paused video', () => {
        const harness = makeHarness();
        const video = harness.makeVideo(1);
        harness.runAnimationFrames();
        expect(video.pendingFrameCount).toBe(1);

        const playCount = video.playCount;
        harness.engine.registerLayer(video.layer, video.video as unknown as HTMLVideoElement);
        harness.runAnimationFrames();
        expect(video.pendingFrameCount).toBe(1);
        expect(video.playCount).toBe(playCount);

        const registeredLayer = harness.engine.layers.get(1);
        if (registeredLayer?.type !== 'video') throw new Error('Expected video layer');
        registeredLayer.playback.status = 'paused';
        harness.engine['handlePlaybackStateChange'](registeredLayer);
        expect(video.pendingFrameCount).toBe(0);

        harness.setElapsed(10_000);
        harness.checkStalls();
        expect(video.loadCount).toBe(0);
    });

    test('a React ref update cannot restore stale playback over a live sync', () => {
        const harness = makeHarness();
        const video = harness.makeVideo(1);
        if (video.layer.type !== 'video') throw new Error('Expected video layer');
        const live = harness.engine.layers.get(1);
        if (live?.type !== 'video') throw new Error('Expected video layer');
        live.playback = { status: 'playing', anchorMediaTime: 4, anchorServerTime: 100_000 };

        harness.engine.registerLayer(
            {
                ...video.layer,
                playback: { status: 'paused', anchorMediaTime: 0, anchorServerTime: 0 }
            },
            video.video as unknown as HTMLVideoElement
        );
        expect(live.playback).toMatchObject({
            status: 'playing',
            anchorMediaTime: 4
        });
    });

    test('corrects both late and early screens without seeking across a loop boundary', () => {
        const harness = makeHarness();
        const video = harness.makeVideo(1);
        harness.runAnimationFrames();
        const layer = harness.engine.layers.get(1);
        if (layer?.type !== 'video') throw new Error('Expected video layer');

        harness.setElapsed(1_000);
        video.video.currentTime = 0.6;
        harness.engine['driftController'](undefined, layer);
        expect(video.seeks.at(-1)).toBe(1);

        video.video.currentTime = 1.4;
        harness.engine['driftController'](undefined, layer);
        expect(video.seeks.at(-1)).toBe(1);

        harness.setElapsed(10_100);
        video.video.currentTime = 9.9;
        const seekCount = video.seeks.length;
        harness.engine['driftController'](undefined, layer);
        expect(video.seeks).toHaveLength(seekCount);
        expect(video.video.playbackRate).toBeGreaterThan(1);
    });

    test('uses the frame about to be displayed instead of the element playhead', () => {
        const harness = makeHarness();
        const video = harness.makeVideo(1);
        const layer = harness.engine.layers.get(1);
        if (layer?.type !== 'video') throw new Error('Expected video layer');

        harness.setElapsed(1_000);
        video.video.currentTime = 1;
        const seekCount = video.seeks.length;
        harness.engine['driftController'](
            { mediaTime: 0.5, expectedDisplayTime: 1_000 } as VideoFrameCallbackMetadata,
            layer
        );
        expect(video.seeks).toHaveLength(seekCount + 1);
        expect(video.seeks.at(-1)).toBe(1);
    });
});
