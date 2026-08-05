# Browser and integration test harness

## Purpose

This harness records the application's observable posture before broader product changes are made.
It prioritises rendering, editor behaviour, runtime convergence, and user-visible workflows over a
line-coverage target. Complete coverage would be expensive and brittle, and would still not prove
that a presentation system renders correctly.

The supported CI contract is a single application server backed by a replica-set MongoDB. Exact
video-frame synchronisation, scheduler timing, multi-server propagation, long-running soak tests,
and arbitrary third-party network availability are deliberately outside the pull-request gate.

## Harness shape

`docker-compose.test.yml` starts the application, MongoDB, and a deterministic second-origin page.
The preparation script waits for health, resets and seeds the database, enrols test devices, and
writes Playwright storage states plus a fixture manifest.

Chromium runs the complete suite with one worker and deterministic locale, timezone, viewport,
device scale, colour scheme, and reduced-motion settings. Firefox and WebKit run a small tagged
public-surface smoke. Visual CSS removes animation, caret, and clock noise. CI retains traces,
screenshots, video, and the HTML report when a test fails.

The canonical rendering fixture covers solid backgrounds, shapes, strokes, rotation, opacity,
lines, rich text, an embedded SVG image, and the empty web-layer placeholder. Mutable editor,
convergence, capture, media, interaction, and runtime fixtures are separate so one workflow cannot
silently invalidate another test's baseline.

Small accessible labels on icon-only controls are intentional harness instrumentation. They provide
stable user-facing selectors and improve the real accessibility tree without exposing test-only
production behaviour.

## Async gate design

Elapsed time is not a correctness condition. Timeouts are diagnostic ceilings; tests wait for an
observable state transition rather than sleeping and assuming work completed.

- Runtime tests wait for an authenticated engine and open application WebSocket before acting.
- Wall convergence checks binding source, exact foreground-layer count, and transition-overlay state.
- Screenshots wait for fonts and two animation frames after application state converges.
- Multi-wall coverage connects all four wall peers before binding, then checks exact transforms,
  culling, seam continuation, overlap order, and per-panel screenshots.
- Gallery/controller tests first establish an idle wall, then require binding, slide selection,
  reconnect recovery, fresh-client recovery, and user-visible unbinding.
- Editor convergence uses two independent browser contexts and checks eventual agreement in both
  directions; it does not impose a latency target.
- Ownership coverage observes gallery state, editor takeover, abrupt final-editor disconnect, and
  the resulting wall lifecycle independently.
- Media coverage waits for finalised metadata and authenticated asset responses. Video assertions
  stop at metadata and play/pause posture rather than claiming frame-perfect synchronisation.
- External capture retries only the server's explicit browser-not-ready response. Success requires
  deterministic output dimensions and pixels, editor rendering, save completion, and fresh-viewer
  recovery.
- Project lifecycle gates use visible UI state and fresh gallery reads instead of guessed propagation
  delays.

Dedicated walls keep delayed events from one runtime workflow from satisfying another workflow's
assertion.

## Current coverage

| Area                                 | Required observation                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit and HTTP integration            | Existing isolated suites remain separate from Playwright; seeded actor and protected-route behaviour runs against the stack.                             |
| Public and authenticated surfaces    | Home, login, gallery, projects, administration, and wall administration render for the appropriate posture.                                              |
| Application posture                  | Narrow viewport, history/reload, console/page errors, structural accessibility, and a small Firefox/WebKit smoke are checked.                            |
| Editor workflow                      | A seeded layer can be selected, moved on the active grid, marked dirty, and saved.                                                                       |
| Text toolbar                         | Colour and size fields retain input focus until valid Enter/Tab commit, preserve the Lexical selection affordance, and match reviewed baselines.         |
| Editor interaction                   | Rich-text line breaks render, pointer-down selects before drag, and Backspace deletes once and persists after reload.                                    |
| Editor convergence and ownership     | Two editors converge after authoritative changes and reconnect; gallery/editor ownership transitions reach an observable final state.                    |
| Visual rendering                     | Editor, immutable viewer, wall, controller, and four wall panels compare against Windows and Linux baselines.                                            |
| Gallery and controller               | Natural project ordering, bind/unbind, slide control, reconnect, and fresh-client recovery are exercised.                                                |
| Project lifecycle and administration | Create/publish/rename/archive visibility plus custom-render navigation and wall-form reactivity are covered.                                             |
| Media                                | Deterministic image/video upload, processing metadata, authorisation, wall/viewer rendering, removal, and access revocation are exercised.               |
| External capture                     | A controlled page that refuses iframe embedding is captured and persisted as a still image.                                                              |
| Device posture                       | Pending enrolment is required; revoked-device and cross-assigned-controller checks remain narrow expected-failure probes until their product fixes land. |

## Product intent versus defects

The harness must distinguish the software's target function from an apparent gap.

Expected constraints include:

- a wall must be enrolled and participate in the server's live binding state;
- a requested wall slug does not itself grant device scope;
- the gallery controller can be unavailable while an editor owns a live session;
- public gallery content is published content, while private editing requires an actor;
- third-party sites may refuse iframe embedding;
- an empty web-layer URL renders the explicit unavailable-content posture; and
- frame-perfect video timing is not a stable CI assertion.

Those constraints do not cancel broader product requirements. If users are promised screenshot
capture regardless of the site they visit, an iframe restriction is not a reason to abandon the
feature; the implementation needs a capture service, proxy, or suitable fallback. The harness uses a
controlled second-origin page which rejects embedding but permits capture. It proves the intended
path without pretending every public site is permanently available.

A failure is a product regression when, under the supported single-server setup, it removes
canonical visible content, breaks an editor action or save transition, violates an actor/device
boundary, prevents a valid enrolled wall from hydrating, or makes a promised feature unavailable for
content the contract says must be supported.

Known product defects may be kept as `test.fail` probes when the scenario is valuable but the fix is
outside this branch. Such a probe must be narrow and must fail unexpectedly if the application starts
passing or changes in a different way. This branch does not carry the corresponding product fix.

The current `main` posture includes probes for revoked/cross-assigned devices, keyboard-driven editor
convergence, rich-text line-break rendering, pointer/Backspace behaviour, durable external capture,
finalised media convergence, controller reconnect recovery, Firefox onboarding hydration, and WebKit
public-gallery hydration. Unauthenticated TUS creation is skipped because `main` currently accepts the
creation request before authentication; the skipped integration test documents the required status
without making this harness branch carry the server fix.

## Commands

Install browsers once:

```sh
bunx playwright install chromium firefox webkit
```

Run the gates:

```sh
bun run test:unit
bun run test:e2e:full
bun run test:all
bun run test:e2e:smoke
bun run test:visual
bun run test:e2e:update
```

For interactive debugging:

```sh
bun run test:harness:up
bun run test:harness:prepare
bun run test:e2e
bun run test:harness:down
```

Baseline updates must be reviewed as images and generated for both the local Windows Chromium target
and the CI Linux Chromium target.

## Remaining gaps

Useful follow-ups are a reviewed contrast/theme-token correction, a small supported-codec matrix,
role-specific sharing and restore behaviour, and targeted mobile interaction checks. Exact video
synchronisation and multi-server behaviour remain outside the current deployment contract.
