import { spawn, spawnSync } from 'node:child_process';
import { mkdir, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import type { FrameSample, MediaEvent } from './client';
type ScreenTrace = { frames: FrameSample[]; events: MediaEvent[] };

/** Real Chromium media test. Run: bun run test:video-sync [--label baseline]. */
import { chromium, type BrowserContext, type Page } from 'playwright';

const root = resolve(import.meta.dir, '../../../..');
// Idle sleep invalidates frame timing. Explicit lid closure can still suspend macOS.
const keepAwake =
    process.platform === 'darwin'
        ? spawn('/usr/bin/caffeinate', ['-di', '-w', String(process.pid)], { stdio: 'ignore' })
        : null;
keepAwake?.unref();
const output = resolve(process.env.VIDEO_SYNC_OUTPUT || join(tmpdir(), 'vizzy-video-sync'));
await mkdir(output, { recursive: true });
const clip = join(output, 'wall-50mb-60fps.mp4');
if (!(await Bun.file(clip).exists())) {
    console.log('Generating 40s / 60fps / 1280x720 / ~50MB real H.264 fixture...');
    const generated = spawnSync(
        process.env.FFMPEG_PATH || 'ffmpeg',
        [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=1280x720:rate=60',
            '-t',
            '40',
            '-c:v',
            'libx264',
            '-preset',
            'fast',
            '-pix_fmt',
            'yuv420p',
            '-b:v',
            '10M',
            '-minrate',
            '10M',
            '-maxrate',
            '10M',
            '-bufsize',
            '20M',
            '-x264-params',
            'nal-hrd=cbr',
            '-g',
            '60',
            '-keyint_min',
            '60',
            '-sc_threshold',
            '0',
            '-an',
            '-movflags',
            '+faststart',
            clip
        ],
        { stdio: 'inherit' }
    );
    if (generated.status !== 0) throw new Error('FFmpeg fixture generation failed');
}
const size = (await stat(clip)).size;
if (size < 47_000_000 || size > 53_000_000) throw new Error(`Expected ~50MB, got ${size}`);
const built = await Bun.build({
    entrypoints: [join(import.meta.dir, 'client.ts')],
    target: 'browser',
    tsconfig: join(root, 'apps/web/tsconfig.json'),
    plugins: process.argv.includes('--baseline')
        ? [
              {
                  name: 'pr174-baseline',
                  setup(build) {
                      build.onLoad({ filter: /\/wallEngine\.ts$/ }, () => ({
                          contents: spawnSync(
                              'git',
                              ['show', '994ff69:apps/web/src/lib/wallEngine.ts'],
                              { cwd: root, encoding: 'utf8' }
                          ).stdout,
                          loader: 'ts'
                      }));
                  }
              }
          ]
        : [],
    define: { __APP_COMMIT_SHA__: '"video-test"', __APP_BUILD_TIMESTAMP__: '"video-test"' }
});
if (!built.success) throw new Error(built.logs.map((log) => log.message).join('\n'));
const js = await built.outputs[0].text();
const peers = new Map<string, Bun.ServerWebSocket<{ id: string }>>();
const held = new Set<string>();
const activeMediaRequests = new Set<() => void>();
const requests: Array<{
    id: string;
    start: number;
    end: number;
    sent: number;
    at: number;
    status: number;
    ifNoneMatch: string | null;
}> = [];
let anchor = 0;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const server = Bun.serve<{ id: string }>({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === '/bus') {
            if (server.upgrade(req, { data: { id: '' } })) return;
        }
        if (url.pathname === '/client.js')
            return new Response(js, { headers: { 'Content-Type': 'text/javascript' } });
        if (url.pathname === '/clip.mp4') {
            const id = url.searchParams.get('id')!;
            const range = /bytes=(\d+)-(\d*)/.exec(req.headers.get('range') || '');
            const start = range ? Number(range[1]) : 0;
            const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
            const etag = '"wall-50mb-60fps-v1"';
            const cacheControl = 'private, max-age=31536000, immutable';
            const ifNoneMatch = req.headers.get('if-none-match');
            const status = ifNoneMatch === etag ? 304 : range ? 206 : 200;
            const entry = { id, start, end, sent: 0, at: Date.now(), status, ifNoneMatch };
            requests.push(entry);
            // Match the asset route's conditional response as well as Range support.
            if (status === 304)
                return new Response(null, {
                    status,
                    headers: { ETag: etag, 'Cache-Control': cacheControl }
                });
            // Different initial fetch latencies and paced data, no fake media element.
            await delay([0, 250, 750, 1500][Number(id)] || 0);
            const reader = Bun.file(clip)
                .slice(start, end + 1)
                .stream()
                .getReader();
            let cancelled = false;
            const cancel = () => {
                cancelled = true;
                activeMediaRequests.delete(cancel);
                req.signal.removeEventListener('abort', cancel);
                void reader.cancel().catch(() => {});
            };
            activeMediaRequests.add(cancel);
            req.signal.addEventListener('abort', cancel, { once: true });
            if (req.signal.aborted) cancel();
            const stream = new ReadableStream({
                async pull(controller) {
                    while (held.has(id) && !cancelled) await delay(25);
                    if (cancelled) return;
                    const chunk = await reader.read();
                    if (cancelled) return;
                    if (chunk.done) {
                        activeMediaRequests.delete(cancel);
                        req.signal.removeEventListener('abort', cancel);
                        controller.close();
                        return;
                    }
                    await delay(chunk.value.byteLength / 1600); // 1.6 MB/s per screen
                    if (cancelled) return;
                    entry.sent += chunk.value.byteLength;
                    controller.enqueue(chunk.value);
                },
                cancel
            });
            return new Response(stream, {
                status,
                headers: {
                    'Content-Type': 'video/mp4',
                    'Content-Length': String(end - start + 1),
                    ETag: etag,
                    'Accept-Ranges': 'bytes',
                    'Cache-Control': cacheControl,
                    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
                }
            });
        }
        return new Response(
            '<!doctype html><body style="margin:0;background:black"><script type="module" src="/client.js"></script>',
            { headers: { 'Content-Type': 'text/html' } }
        );
    },
    websocket: {
        message(ws, raw) {
            if (typeof raw === 'string') {
                const data = JSON.parse(raw);
                if (data.type === 'hello') {
                    ws.data.id = data.wallId;
                    peers.set(data.wallId, ws);
                    ws.send(JSON.stringify({ type: 'hello_authenticated' }));
                }
            } else {
                const data = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
                if (data.getUint8(0) !== 8) return;
                const pong = new ArrayBuffer(25);
                const view = new DataView(pong);
                view.setUint8(0, 9);
                view.setFloat64(1, data.getFloat64(1, true), true);
                view.setFloat64(9, Date.now(), true);
                view.setFloat64(17, Date.now(), true);
                ws.send(pong);
            }
        },
        close(ws) {
            if (peers.get(ws.data.id) === ws) peers.delete(ws.data.id);
        }
    }
});
const url = `http://127.0.0.1:${server.port}`;
const browsers: BrowserContext[] = [];
const profiles: string[] = [];
const pages: Page[] = [];
const failures: string[] = [];
const results: Array<Record<string, unknown>> = [];
let collected: ScreenTrace[] | null = null;
const check = (condition: boolean, message: string) => {
    if (!condition) failures.push(message);
};
const waitUntil = async (fn: () => Promise<boolean>, timeout: number, description: string) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await fn()) return;
        await delay(100);
    }
    throw new Error(`Timed out: ${description}`);
};
const snapshots = () =>
    Promise.all(
        pages.map((p) =>
            p.evaluate(() => ({ frames: window.probe.frames, events: window.probe.events }))
        )
    );
const clockOffsets = () =>
    Promise.all(
        pages.map((p) =>
            p.evaluate(() => Date.now() - (performance.timeOrigin + performance.now()))
        )
    );
function measure(name: string, data: ScreenTrace[], from: number, to: number) {
    const indices = data.map(() => 0);
    const skews: number[] = [];
    let missing = 0;
    for (let t = from; t < to; t += 1000 / 60) {
        const frames = data.map((screen, i) => {
            while (indices[i] + 1 < screen.frames.length && screen.frames[indices[i] + 1].at <= t)
                indices[i]++;
            return screen.frames[indices[i]];
        });
        if (frames.some((f) => !f || f.at > t || t - f.at > 250)) {
            missing++;
            continue;
        }
        // Compare phase at each frame's own display timestamp. RVFC can omit
        // intermediate callbacks even while the compositor displays those frames;
        // holding the last reported mediaTime would invent a cross-screen lag.
        // A frozen screen is still rejected by the 250ms age gate above.
        const media = frames.map((f) => f.media - (f.at - anchor) / 1000);
        const ref = media[0];
        const relative = media.map((m) => ((m - ref + 60) % 40) - 20);
        skews.push((Math.max(...relative) - Math.min(...relative)) * 1000);
    }
    skews.sort((a, b) => a - b);
    const result = {
        name,
        metric: 'displayed-frame phase spread',
        from,
        to,
        samples: skews.length,
        missing,
        p50Ms: skews[Math.floor(skews.length * 0.5)],
        p95Ms: skews[Math.floor(skews.length * 0.95)],
        maxMs: skews.at(-1),
        frameDelivery: data.map((screen) => {
            const frames = screen.frames.filter((f) => f.at >= from && f.at < to);
            const gaps = frames
                .slice(1)
                .map((f, i) => f.at - frames[i].at)
                .sort((a, b) => a - b);
            return {
                callbacksPerSecond: (frames.length * 1000) / (to - from),
                p95CallbackGapMs: gaps[Math.floor(gaps.length * 0.95)],
                maxCallbackGapMs: gaps.at(-1),
                droppedFrames: frames.length ? frames.at(-1)!.dropped - frames[0].dropped : null
            };
        })
    };
    results.push(result);
    console.log(JSON.stringify(result));
    check(skews.length >= 180 && missing === 0, `${name}: missing displayed frames (${missing})`);
    check((result.p95Ms ?? Infinity) <= 34, `${name}: p95 skew ${result.p95Ms}ms exceeds 2 frames`);
    check((result.maxMs ?? Infinity) <= 51, `${name}: max skew ${result.maxMs}ms exceeds 3 frames`);
}
try {
    for (let i = 0; i < 4; i++) {
        const profile = await mkdtemp(join(tmpdir(), 'vizzy-video-screen-'));
        profiles.push(profile);
        const browser = await chromium.launchPersistentContext(profile, {
            viewport: { width: 640, height: 360 },
            headless: true,
            ...(process.env.VIDEO_SYNC_CHROME
                ? { executablePath: process.env.VIDEO_SYNC_CHROME }
                : { channel: 'chrome' }),
            args: [
                // Ensure a 51 MB entry fits. This is a cache-hit test precondition,
                // not a cache-retention guarantee made by the application.
                '--disk-cache-size=1073741824',
                '--autoplay-policy=no-user-gesture-required',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding'
            ]
        });
        browsers.push(browser);
        console.log(`Launched screen ${i}`);
        const page = browser.pages()[0] ?? (await browser.newPage());
        await page.addInitScript((offset) => {
            const now = Date.now.bind(Date);
            Date.now = () => now() + offset;
        }, [0, 1500, -2300, 700][i]);
        page.on('pageerror', (e: Error) => failures.push(`screen ${i}: ${e.message}`));
        await page.goto(`${url}/?id=${i}`);
        pages.push(page);
    }
    console.log('Waiting for four authenticated engines');
    await waitUntil(async () => peers.size === 4, 10_000, 'four engines authenticated');
    anchor = Date.now() + 1000;
    const hydrate = () => {
        for (const [id, peer] of peers)
            peer.send(
                JSON.stringify({
                    type: 'hydrate',
                    layers: [
                        {
                            numericId: 1,
                            type: 'video',
                            url: `${url}/clip.mp4?id=${id}`,
                            duration: 40,
                            loop: true,
                            rvfcActive: false,
                            playback: {
                                status: 'playing',
                                anchorMediaTime: 0,
                                anchorServerTime: anchor
                            },
                            config: {
                                visible: true,
                                cx: 640,
                                cy: 360,
                                width: 1280,
                                height: 720,
                                scaleX: 1,
                                scaleY: 1,
                                rotation: 0,
                                zIndex: 1
                            }
                        }
                    ]
                })
            );
    };
    hydrate();
    await waitUntil(
        async () => (await snapshots()).every((s) => s.frames.length > 90),
        25_000,
        'all screens actually decoding'
    );
    await delay(5000);
    let from = Date.now();
    await delay(5000);
    measure('cold-load-different-latencies-and-clocks', await snapshots(), from, Date.now());
    await pages[1].evaluate(() => window.probe.drift(-0.12));
    await pages[2].evaluate(() => window.probe.drift(0.12));
    await delay(5000);
    from = Date.now();
    await delay(5000);
    measure('recover-plus-minus-120ms-drift', await snapshots(), from, Date.now());
    // Real buffering interruption: stop network bytes until the screen drains its buffer.
    console.log('Starving screen 3 of network bytes');
    const holdAt = Date.now();
    held.add('3');
    await waitUntil(
        async () =>
            (await snapshots())[3].events.some(
                (e: MediaEvent) => e.type === 'waiting' && e.at > holdAt
            ),
        35_000,
        'screen 3 runs out of media bytes'
    );
    const stalledAt = Date.now();
    await delay(1200);
    held.delete('3');
    const recoveryAt = Date.now();
    await waitUntil(
        async () => ((await snapshots())[3].frames.at(-1)?.at ?? 0) > recoveryAt,
        15_000,
        'screen 3 resumes decoded frames'
    );
    await delay(10000);
    from = Date.now();
    await delay(5000);
    const data = await snapshots();
    results.push({
        name: 'loading-and-recovery-timing',
        firstMovingFrameAfterAnchorMs: data.map(
            (s) => s.frames.find((f) => f.at >= anchor && f.media > 0)!.at - anchor
        ),
        stalledScreenFirstFrameAfterNetworkRestoredMs:
            data[3].frames.find((f) => f.at > recoveryAt)!.at - recoveryAt,
        stalledAt,
        recoveryAt
    });
    measure('network-starvation-recovery', data, from, Date.now());
    check(
        data
            .slice(0, 3)
            .every(
                (s) =>
                    !s.events.some(
                        (e: MediaEvent) =>
                            ['pause', 'waiting'].includes(e.type) &&
                            e.at > stalledAt &&
                            e.at < recoveryAt
                    )
            ),
        'Healthy screens paused or buffered during single-screen starvation'
    );
    console.log('Priming complete HTTP cache entries before a warm reload');
    await Promise.all(
        pages.map((p) =>
            p.evaluate(async () => {
                const src = window.probe.video.src;
                // Release the media loader's active cache entry before priming it.
                // A concurrent fetch may bypass the entry held by the video request.
                window.probe.stop();
                const response = await fetch(src);
                if (!response.ok) throw new Error('Cache prime failed');
                await response.arrayBuffer();
            })
        )
    );
    const beforeWarm = requests.length;
    await Promise.all(pages.map((p) => p.reload()));
    await Promise.all(
        pages.map((p) => p.waitForFunction(() => window.probe && window.probe.ready))
    );
    hydrate();
    await waitUntil(
        async () => (await snapshots()).every((s) => s.frames.length > 90),
        15000,
        'warm cache decoding'
    );
    await delay(3000);
    from = Date.now();
    await delay(5000);
    const warm = await snapshots();
    measure('warm-http-cache-reload', warm, from, Date.now());
    const warmBytes = requests.slice(beforeWarm).reduce((n, r) => n + r.sent, 0);
    results.push({ name: 'warm-cache-transfer', bytes: warmBytes });
    check(warmBytes === 0, `Warm reload transferred ${warmBytes} media bytes`);
    console.log('Measuring 60 seconds of continuous playback, including loop boundaries');
    const clocksBefore = await clockOffsets();
    from = Date.now();
    await delay(60_000);
    const continuous = await snapshots();
    measure('continuous-playback-60s', continuous, from, Date.now());
    const clocksAfter = await clockOffsets();
    const clockDiscontinuityMsByScreen = clocksAfter.map((offset, i) => offset - clocksBefore[i]);
    results.push({ name: 'host-clock-continuity', clockDiscontinuityMsByScreen });
    check(
        clockDiscontinuityMsByScreen.every((ms) => Math.abs(ms) < 100),
        'Host suspend or wall-clock discontinuity invalidated the continuous measurement'
    );
    const maxWaitingMsByScreen = continuous.map((screen) =>
        Math.max(
            0,
            ...screen.events
                .filter((event) => event.type === 'waiting' && event.at > from)
                .map((event) => {
                    const resumed = screen.events.find(
                        (next) => next.type === 'playing' && next.at > event.at
                    );
                    return (resumed?.at ?? Date.now()) - event.at;
                })
        )
    );
    results.push({ name: 'continuous-buffering', maxWaitingMsByScreen });
    check(
        // Native looping emits waiting/playing even for a sub-frame decoder reset.
        // Keep the phase-error gates above and reject real, sustained buffering.
        maxWaitingMsByScreen.every((ms) => ms <= 250),
        'Continuous cached playback buffered for more than 250ms'
    );
    console.log('Clearing HTTP caches and rejoining the still-running shared timeline');
    await Promise.all(
        pages.map(async (page) => {
            const session = await page.context().newCDPSession(page);
            await session.send('Network.clearBrowserCache');
            await session.detach();
        })
    );
    const beforeMiss = requests.length;
    await Promise.all(pages.map((p) => p.reload()));
    await Promise.all(
        pages.map((p) => p.waitForFunction(() => window.probe && window.probe.ready))
    );
    const rejoinAt = Date.now();
    hydrate();
    await waitUntil(
        async () => (await snapshots()).every((s) => s.frames.length > 90),
        25_000,
        'cache-miss late join decoding'
    );
    let alignedSince: number | null = null;
    await waitUntil(
        async () => {
            const now = Date.now();
            const recent = (await snapshots()).map((s) =>
                s.frames.filter((f) => f.at <= now).at(-1)
            );
            if (recent.some((f) => !f || now - f.at > 250)) {
                alignedSince = null;
                return false;
            }
            const phases = recent.map((f) => {
                const phase = f!.media - (f!.at - anchor) / 1000;
                return ((((phase + 20) % 40) + 40) % 40) - 20;
            });
            const aligned =
                Math.max(...phases) - Math.min(...phases) <= 0.034 &&
                phases.every((p) => Math.abs(p) <= 0.051);
            if (!aligned) alignedSince = null;
            else alignedSince ??= now;
            return alignedSince !== null && now - alignedSince >= 1000;
        },
        Math.max(1, 30_000 - (Date.now() - rejoinAt)),
        'cache-miss join aligns for a full second'
    );
    results.push({ name: 'cache-miss-alignment-time', milliseconds: Date.now() - rejoinAt });
    from = Date.now();
    await delay(5000);
    const cacheMiss = await snapshots();
    measure('cache-miss-late-join', cacheMiss, from, Date.now());
    const missBytes = requests.slice(beforeMiss).reduce((n, r) => n + r.sent, 0);
    results.push({ name: 'cache-miss-transfer', bytes: missBytes });
    check(missBytes > 0, 'Cache-miss case did not fetch any media bytes');
    for (let i = 0; i < data.length; i++) {
        data[i].frames.push(...continuous[i].frames, ...cacheMiss[i].frames);
        data[i].events.push(...continuous[i].events, ...cacheMiss[i].events);
    }
    collected = data;
} catch (error) {
    failures.push(String(error));
} finally {
    held.clear();
    const label = process.argv.includes('--label')
        ? process.argv[process.argv.indexOf('--label') + 1]
        : 'current';
    await Bun.write(
        join(output, `${label}-frames.json`),
        JSON.stringify(collected ?? (await snapshots().catch(() => [])))
    );
    const report = {
        label,
        engine: process.argv.includes('--baseline') ? '994ff69' : 'working-tree',
        revision: spawnSync('git', ['rev-parse', 'HEAD'], {
            cwd: root,
            encoding: 'utf8'
        }).stdout.trim(),
        anchor,
        fixture: { path: clip, size, fps: 60, duration: 40 },
        screens: 4,
        results,
        failures,
        requests
    };
    await Bun.write(join(output, `${label}-report.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ label, results, failures }));
    // Stop throttled responses before closing the browsers. Pending response
    // writers can otherwise leave persistent-context shutdown waiting forever.
    for (const cancel of activeMediaRequests) cancel();
    server.stop(true);
    keepAwake?.kill();
    console.log('Closing temporary browsers');
    await Promise.all(browsers.map((b) => b.close()));
    console.log('Removing temporary browser profiles');
    await Promise.all(profiles.map((p) => rm(p, { recursive: true, force: true })));
}
if (failures.length) process.exitCode = 1;
