# Same-video, four-browser synchronization regression

Run from the repository root with Bun, FFmpeg (libx264), and Google Chrome installed:

```sh
bun test --conditions=production apps/web/src/lib/wallEngine.videoRecovery.test.ts apps/web/src/lib/busState.presentation.test.ts
bun run test:video-sync --label current
bun run test:video-sync --baseline --label pr174-original
```

`--baseline` bundles `wallEngine.ts` from PR 174's original head, `994ff69`, into the
same browser harness. It does not change the checkout. A failed assertion exits
with status 1. No database, credentials, application server, or existing browser
profile is used. Four temporary profiles are removed after the run. Chrome is
launched with a 1 GiB disk-cache budget so the 51 MB entry can fit for the
explicit cache-hit case; ordinary browser defaults are not an offline guarantee.
On macOS the runner temporarily uses `caffeinate` to prevent idle sleep. Keep the
lid open; explicit suspension still interrupts decoding. A ≥100 ms change between
the browser wall and monotonic clocks fails the continuous case as an environment
discontinuity, rather than being silently excluded from the results.

Optional environment variables: `FFMPEG_PATH`, `VIDEO_SYNC_CHROME` (Chrome executable),
and `VIDEO_SYNC_OUTPUT` (defaults to `vizzy-video-sync` under the OS temporary directory).
The output directory contains the generated MP4, `<label>-report.json` and
`<label>-frames.json`. The roughly 51 MB MP4 is generated once, outside the repository.

## What runs

Four independent Chrome processes decode the same real 40-second, 1280×720,
60 fps H.264 MP4. The fixture uses a one-second GOP and faststart, matching the
production encoder's frame cadence and seek interval. Its fixed 10 Mbps bitrate
makes its size reproducibly about 50 MB; it is not a small file with dummy padding.
Production uploads use CRF, so their bitrate varies with content.

The page imports the production `WallEngine` and `BusClient`. A small test server
supplies a single video hydrate, binary clock pongs, and media with the production
asset route's Range, strong ETag, conditional 304, and immutable HTTP cache behavior.
This is an engine/browser integration test, not an end-to-end test of the React wall,
authentication, database, media worker, or deployment proxy. It sends no slide-switch
messages and changes no presentation or transition behavior.

| Case                    | Stimulus                                                                                                                   | Assertion                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold load               | Four empty caches, request latencies 0/250/750/1500 ms, each capped at 1.6 MB/s; local clocks skewed 0/+1500/−2300/+700 ms | Every browser produces more than 90 decoded-frame callbacks within 25 s; after 5 s settling, measure all four for 5 s                                                      |
| Drift correction        | Move two playheads by −120/+120 ms                                                                                         | After 5 s settling, measure all four for 5 s                                                                                                                               |
| Single-screen buffering | Stop actual response bytes for screen 3 until its media buffer empties, hold for another 1.2 s, then release               | Real `waiting` event required; decoded frames resume within 15 s; the other three have no `waiting`/`pause` events during the outage; measure all four after 10 s settling |
| Cache reload            | Release active media requests, fully fetch the same URL, then reload with the same profiles and timeline                   | Four browsers decode again, no new media body bytes transferred, then measure for 5 s                                                                                      |
| Sustained playback      | Continue for another 60 s, across the 40 s video's loop boundaries                                                         | Measure the entire interval, with no buffering interval longer than 250 ms                                                                                                 |

The shared timeline keeps advancing while a screen loads or buffers. A slow screen
joins that timeline once its buffer permits. The tests do **not** assert simultaneous
first pixels on a cold load. Small playback drift does not trigger a group pause.
The report records first moving-frame delays and the stalled screen's first decoded
frame after network recovery, separately from the settled synchronization error.

## Measurement and gates

Every browser records `requestVideoFrameCallback` metadata: the presented frame's
`mediaTime`, its `expectedDisplayTime`, playback rate, buffered seconds, and the
browser's dropped-frame counter. The independent measurement clock is
`performance.timeOrigin + expectedDisplayTime`; it does not use the engine's
server-clock estimate or the deliberately skewed `Date.now()`.

For each frame, compute its timeline phase:

```
phase = mediaTime − (expectedDisplayTimestamp − sharedAnchor) / 1000
```

At a 60 Hz sampling grid, compare the latest phases across all four browsers, with
wraparound for the 40 s loop. This measures media timeline alignment using actual
decoded frames. It does not substitute `video.currentTime` for displayed frames.
Frame callbacks can omit intermediate frames; projecting phase avoids inventing
skew by holding the last reported frame's media timestamp constant. A callback
older than 250 ms is a missing sample and fails the case. Reports also retain frame
callback cadence and dropped-frame counts so the phase metric cannot be mistaken
for a guarantee of 60 displayed frames per second.

Every measured interval must have zero missing samples, at least 180 samples,
P95 spread ≤34 ms (about two 60 fps frames), and maximum spread ≤51 ms (about three
frames). Native loops can emit brief `waiting`/`playing` pairs while resetting the decoder;
these intervals are reported and must be ≤250 ms, while the ≤51 ms phase-spread
maximum still applies throughout. These are regression gates, not a promise of
zero-frame difference.
Loading and recovery transients before the stated settling periods are retained
in the raw traces but are not included in those steady-state gates.

## Cache and hardware limits

This implementation uses the browser's ordinary HTTP/media cache. It does not pin
an offline file or introduce Cache Storage, blobs, or a service worker. Cache
retention and eviction remain browser decisions. Cache priming is a test precondition, not a new application download policy. The
cache test verifies actual body bytes transferred; sending cache headers alone is not considered a cache hit.
The buffered-range check concerns the media element's currently available data,
which is different from having a complete file in persistent storage.

The local test uses four browsers on one machine, headless rendering, a generated
clip, and a controlled network. It cannot establish simultaneous physical panel
scanout, identical GPU scheduling across computers, or performance under sustained
bandwidth below the video bitrate. Physical wall acceptance still needs the actual
players, displays, network and target clip, with an external camera or equivalent
measurement for visible frame differences. No change here guarantees hardware
frame lock or tests video switching.

## Measured result (2026-11-26)

See [the machine-readable report](./results-2026-11-26.json). The run used macOS
arm64, Chrome 158.0.8127.88 headless, Bun 1.3.14, FFmpeg 8.1.2, and a 50,956,913-byte
fixture. All six browser cases and the 15 focused unit tests passed. Type checking,
scoped lint, formatting and `git diff --check` also passed.

| Measured interval                        | P95 phase spread | Maximum phase spread |
| ---------------------------------------- | ---------------: | -------------------: |
| cold-load-different-latencies-and-clocks |         21.77 ms |             21.87 ms |
| recover-plus-minus-120ms-drift           |         21.77 ms |             21.87 ms |
| network-starvation-recovery              |         21.73 ms |             23.73 ms |
| warm-http-cache-reload                   |         21.60 ms |             21.73 ms |
| continuous-playback-60s                  |         21.57 ms |             28.57 ms |
| cache-miss-late-join                     |         21.33 ms |             21.47 ms |

The cold-load first moving frames arrived 41–1,335 ms after the shared anchor.
After restoring the stalled screen's network, its first decoded frame arrived in
168 ms; the reported synchronization interval starts after a separate 10-second
settling period. Healthy screens did not pause or buffer during the isolated outage.
Warm reload transferred zero media body bytes. Clearing the caches and rejoining
the advancing timeline took 12.983 s to meet the alignment gate under the specified
latency/bandwidth limits. Native loop decoder waits were 16.8–21.5 ms. All measured
intervals had zero missing-frame samples.

The continuous run delivered about 47–58 frame callbacks/s per browser, with
browser-reported dropped frames; this is not evidence of a guaranteed physical
60 Hz output. The source is 60 fps. Host wall/monotonic clock discontinuity was
less than 1 ms in the accepted run.

The original PR head (`994ff69`) fails the same cold-load test: after 25 seconds,
the slowest screen has only 9 frame callbacks and 10 seek events, while the other
three have 1,093–1,322 frame callbacks. This reproduces the repeated unbuffered-seek
problem rather than relying solely on mocked media tests.
