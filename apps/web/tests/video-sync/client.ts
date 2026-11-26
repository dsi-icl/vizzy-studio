import { WallEngine } from '../../src/lib/wallEngine';

export type FrameSample = {
    at: number;
    media: number;
    rate: number;
    ahead: number;
    dropped: number;
};
export type MediaEvent = { type: string; at: number };
declare global {
    interface Window {
        probe: {
            frames: FrameSample[];
            events: MediaEvent[];
            video: HTMLVideoElement;
            ready: boolean;
            engine: WallEngine;
            drift(seconds: number): void;
            stop(): void;
        };
    }
}

const id = new URLSearchParams(location.search).get('id')!;
const engine = WallEngine.getInstance(id, { x: 0, y: 0, w: 1280, h: 720 });
const video = document.createElement('video');
video.muted = true;
video.loop = true;
video.preload = 'auto';
video.style.width = '640px';
document.body.append(video);
const frames: FrameSample[] = [];
const events: MediaEvent[] = [];
let observing = false;
const observe = (_now: number, frame: VideoFrameCallbackMetadata) => {
    const end = Array.from({ length: video.buffered.length }, (_, i) =>
        video.buffered.start(i) <= video.currentTime && video.currentTime <= video.buffered.end(i)
            ? video.buffered.end(i)
            : 0
    ).reduce((a, b) => Math.max(a, b), 0);
    frames.push({
        // Independent of the engine's clock estimate and injected Date.now skew.
        at: performance.timeOrigin + frame.expectedDisplayTime,
        media: frame.mediaTime,
        rate: video.playbackRate,
        ahead: Math.max(0, end - video.currentTime),
        dropped: video.getVideoPlaybackQuality().droppedVideoFrames
    });
    video.requestVideoFrameCallback(observe);
};
for (const name of ['waiting', 'playing', 'seeking', 'seeked', 'pause', 'error']) {
    video.addEventListener(name, () =>
        events.push({ type: name, at: performance.timeOrigin + performance.now() })
    );
}
engine.subscribeToLayoutUpdates((message) => {
    if (message.type !== 'hydrate') return;
    const layer = message.layers[0];
    if (layer.type !== 'video') throw new Error('Expected a video layer');
    video.src = layer.url;
    engine.registerLayer(layer, video);
    if (!observing) {
        observing = true;
        video.requestVideoFrameCallback(observe);
    }
});
Object.assign(window, {
    probe: {
        ready: false,
        frames,
        events,
        video,
        engine,
        drift(seconds: number) {
            video.currentTime += seconds;
        },
        stop() {
            engine.destroy();
            video.pause();
            video.removeAttribute('src');
            video.load();
        }
    }
});

engine.onReady(() => {
    window.probe.ready = true;
});
