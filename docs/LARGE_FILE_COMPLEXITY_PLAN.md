# Large File Complexity Plan

Last updated: 2026-04-08

## Why this doc exists

Backlog plan to reduce complexity in very large files while preserving behaviour.
This version is based on reading the actual file contents — not estimates.

---

## Current line counts

> Files that have been split are shown with their new barrel size and the largest sibling.
> Original monolith sizes are preserved in the per-file plans below for reference.

| File                                        | Lines | Notes                                       |
| ------------------------------------------- | ----- | ------------------------------------------- |
| `apps/web/src/components/EditorSlate.tsx`   | 1297  |                                             |
| `apps/web/src/routes/controller/index.tsx`  | 1099  |                                             |
| `apps/web/src/components/EditorToolbar.tsx` | 918   |                                             |
| `apps/web/src/routes/wall/index.tsx`        | 764   |                                             |
| `apps/web/src/routes/bus.handlers.ts`       | 783   | largest sibling of bus split                |
| `apps/web/src/routes/bus.ts`                | 584   | hooks + loops + bridges                     |
| `apps/web/src/routes/yjs/yjs.session.ts`    | 471   | largest sibling of yjs split                |
| `apps/web/src/lib/editorStore.layers.ts`    | ~510  | largest sibling of editorStore split        |
| `apps/web/src/lib/editorStore.ts`           | ~120  | assembly: state, helpers, slices, HMR guard |
| `apps/web/src/routes/yjs/$.ts`              | 36    | singleton + hooks + bridge + Route          |
| `apps/web/src/lib/busState.state.ts`        | 348   | largest sibling of busState split           |
| `apps/web/src/lib/busState.ts`              | 109   | barrel only                                 |
| `apps/web/src/routeTree.gen.ts`             | ~1149 | generated — do not touch                    |

---

## Cross-cutting observations (found during analysis)

Before per-file plans, these span multiple files and should be resolved first:

### A. Shared stage constants

`SCREEN_W`, `SCREEN_H`, `COLS`, `ROWS` are copy-pasted into `EditorSlate.tsx`,
`wall/index.tsx`, and `controller/index.tsx`. Extract to `lib/stageConstants.ts`.

### B. Shared geometry utilities

`snapToGrid`, `getDistance`, `getAngle`, `touchToStagePoint` exist in `EditorSlate.tsx`;
similar geometry helpers are in `wall/index.tsx`. Extract to `lib/stageGeometry.ts`.

### C. Wall/controller HTML layer renderer

`wall/index.tsx` and `controller/index.tsx` each have ~200 lines of near-identical
HTML/CSS layer rendering (`<div>`/`<img>`/`<iframe>`/`<video>` with `commonProps`
pattern). Extract to `components/WallLayerRenderer.tsx`.

> **`EditorSlate.tsx` is NOT a candidate for this shared renderer.**
> It renders via Konva (canvas) with a completely different component tree
> (`KonvaStaticImage`, `KonvaVideo`, Transformer) and editor-specific interaction props.

### D. Slide name generation

`"Slide ${order + 1}"` default-naming is repeated across `editorStore.ts`,
`controller/index.tsx`, and `wall/index.tsx`. Trivial: move to a one-liner in
`lib/stageConstants.ts` or `lib/types.ts`.

### E. `generateSlideId()` in editorStore

`editorStore.ts:18` implements a custom ObjectId-mimicking hex generator.
Now that server-side slide creation uses `crypto.randomUUID()`, this should
be replaced for consistency.

---

## Per-file split plans

---

### 1. `apps/web/src/routes/bus.ts` (2418 lines)

**What it actually contains (from code):**

| Lines     | Group                              | What it does                                                                                                                                 |
| --------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–106     | Imports + setup                    | All busState imports, Zod schemas, binary opcodes                                                                                            |
| 107–200   | Playback dedup                     | `lastPlaybackCommandAt` map, temporal conflict avoidance for video commands                                                                  |
| 201–449   | Auth + rate limiting               | Permission cache, `isWsMessageAuthorized`, strike-based WS rate limits, handshake rate limits                                                |
| 450–741   | Wall binding orchestration         | `performLiveBind`, bind override lifecycle, wall/gallery broadcast helpers, gallery state snapshot                                           |
| 742–797   | ECDSA device verification          | `verifyDeviceSignature`, `base64UrlToBytes`, `asArrayBuffer`                                                                                 |
| 799–1127  | Peer registration                  | `registerEditorPeer`, `completeHelloRegistration` (routes by device kind), device enrollment                                                 |
| 1128–1218 | Scope vacancy                      | `handleEditorScopeVacated`, `recomputePeerAuthContexts`                                                                                      |
| 1220–1461 | Message handlers (state)           | `rehydrate_please`, `clear_stage`, `upsert_layer`, `delete_layer`, `seed_scope`, `update_slides`, `stage_dirty`, `leave_scope`, `stage_save` |
| 1463–1851 | Message handlers (control)         | `bind_wall`, `request_bind_wall`, `bind_override_decision`, `unbind_wall`, `video_play/pause/seek`, `hello`, `hello_auth`, `switch_scope`    |
| 1884–2020 | Binary + WS lifecycle              | `handleBinary` (clock ping-pong, spatial move relay), `onopen`, `onclose`                                                                    |
| 2020–2200 | Close fallthrough                  | Wall node grace period, scope cleanup scheduling, DB persist on last editor                                                                  |
| 2200–2418 | Background loops + process bridges | JSON/binary router, VSYNC loop, AUTO_SAVE loop, REAPER loop, all `process.__XXX__` bridges                                                   |

**Key couplings:**

- All 30+ message handlers depend on busState (broadcast + state mutations) — this is intentional
- `performLiveBind` calls `dbCol.walls`, `dbCol.projects` directly (orchestration, not state)
- Process bridges (lines 2200+) each call exactly one handler or busState function — they are fan-in from external modules, not an independent concern

**Circular dependency risk:** None. `bus.ts` → `busState.ts` is one-way.
`busState.ts` does not and must not import `bus.ts`.

**Target structure:**

```
apps/web/src/routes/bus/
  index.ts                  — route export + crossws hook assembly (~100 lines)
  constants.ts              — opcodes, message-type classification sets (~80 lines)
  authz.ts                  — isWsMessageAuthorized, permission cache, rate limit enforcement (~250 lines)
  crypto.ts                 — verifyDeviceSignature, base64UrlToBytes (~60 lines)
  peers.ts                  — registerEditorPeer, completeHelloRegistration,
                              handleEditorScopeVacated, recomputePeerAuthContexts (~420 lines)
  binding.ts                — performLiveBind, bind override lifecycle,
                              wall/gallery broadcast helpers (~400 lines)
  handlers/
    state.ts                — rehydrate_please, clear_stage, upsert_layer, delete_layer,
                              seed_scope, update_slides, stage_dirty, leave_scope, stage_save (~250 lines)
    control.ts              — bind_wall, request_bind_wall, bind_override_decision,
                              unbind_wall, video_*, hello, hello_auth, switch_scope (~400 lines)
  lifecycle.ts              — onopen, onclose (including grace period + DB flush logic),
                              binary handler, background loops (VSYNC/AUTO_SAVE/REAPER) (~400 lines)
```

Process bridges: each lives at the bottom of the module that owns the relevant function
(e.g. `process.__REBOOT_DEVICE__` lives in `peers.ts`, `process.__UPSERT_TEXT_LAYER__`
lives in `handlers/state.ts`). `index.ts` registers any bridges that span modules.

---

### 2. `apps/web/src/lib/busState.ts` (1474 lines)

**What it actually contains (from code):**

| Lines     | Group                        | What it does                                                                                                                              |
| --------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1–58      | HMR preservation             | `_hmr` singleton, conditional re-init for new fields added post-deploy                                                                    |
| 60–110    | Telemetry                    | `markIncomingJson/Binary/VideoSync`, `getBusRuntimeTelemetry`                                                                             |
| 113–250   | Core indexes                 | `internScope`, `scopeLabel`, `addToIndex`/`removeFromIndex` generics, master index exports                                                |
| 253–381   | Peer register/unregister     | `registerPeer`, `unregisterPeer`, specimen routing into allEditors/wallsByWallId/etc.                                                     |
| 383–509   | Scope + controller transient | `getOrCreateScope`, hydrate cache invalidation, YDoc cleanup, controller transient layer CRUD                                             |
| 511–582   | Wall binding state           | `bindWall`, `unbindWall`, scopeWatchers, wallPeersByScope, portal token revocation                                                        |
| 586–751   | Broadcast                    | `sendJSON`, all `broadcastTo*` variants (JSON + binary), `broadcastToEditorsByCommit`, `notifyControllersByCommit`                        |
| 753–825   | Wall hydration               | `hydrateWallNodes`, `updateProjectCustomRenderSettings`, `notifyControllers`                                                              |
| 828–992   | Video sync                   | `registerActiveVideo`, `unregisterActiveVideo`, `sendVideoSyncToRelevantWalls`, `broadcastVideoSyncBatchToWalls`, `encodeVideoSyncBinary` |
| 995–1073  | Timers                       | `scheduleWallUnbindGrace`, `cancelWallUnbindGrace`, `scheduleScopeCleanup`, `cancelScopeCleanup`                                          |
| 1074–1136 | Scope GC + persistence       | `executeScopeCleanup`, `seedScopeFromDb`                                                                                                  |
| 1139–1256 | Scope resolution + reaping   | `resolveScopeId`, `setEditorScope`, `touchPing`, `reapStalePeers`, `logPeerCounts`                                                        |
| 1259–1406 | Save + slide persistence     | `buildSlidesSnapshot`, `saveScope`, `persistSlideMetadata`                                                                                |
| 1411–1474 | Asset stream                 | `broadcastAssetToEditorsByProject`, `startAssetChangeStream`                                                                              |

**Key coupling — the HMR singleton is the root:**
All exported maps (`scopedState`, `peers`, `editorsByScope`, etc.) are properties of
the `_hmr` object. Any module that imports them gets a reference to the live object.
This means splits are safe at the **function** level — you can move functions to new
files as long as they import the map references from a single `state.ts` root.

**Circular dependency risk:**

- `persistence.ts` (saveScope) calls broadcast functions → `broadcast.ts` calls
  `getOrCreateScope` from `scopes.ts` → all import from `state.ts`.
  Safe as long as `state.ts` has no imports from siblings.
- `binding.ts` (`bindWall`) calls `scheduleScopeCleanup` from timers + `revokePortalTokens`
  (external) — no circle.

**Target structure:**

```
apps/web/src/lib/busState/
  index.ts          — re-exports everything public; call sites unchanged
  state.ts          — _hmr singleton, all raw maps, telemetry, internScope
                      ⚠ imports NOTHING from siblings — strict root
  peers.ts          — registerPeer, unregisterPeer, peerCounts
                      imports: state.ts
  scopes.ts         — getOrCreateScope, hydrate payloads, YDoc cleanup,
                      controller transient layers, resolveScopeId, setEditorScope
                      imports: state.ts, peers.ts
  binding.ts        — bindWall, unbindWall, hydrateWallNodes, updateProjectCustomRenderSettings,
                      notifyControllers, scheduleWallUnbindGrace, scheduleScopeCleanup
                      imports: state.ts, scopes.ts
  broadcast.ts      — sendJSON, all broadcastTo* variants, broadcastToEditorsByCommit,
                      notifyControllersByCommit, backpressure helpers
                      imports: state.ts, scopes.ts
  video.ts          — registerActiveVideo, unregisterActiveVideo, sendVideoSyncToRelevantWalls,
                      broadcastVideoSyncBatchToWalls, encodeVideoSyncBinary
                      imports: state.ts, broadcast.ts
  persistence.ts    — buildSlidesSnapshot, saveScope, persistSlideMetadata,
                      seedScopeFromDb, executeScopeCleanup, reapStalePeers, logPeerCounts
                      imports: state.ts, scopes.ts, broadcast.ts, binding.ts
  assets.ts         — startAssetChangeStream, broadcastAssetToEditorsByProject
                      imports: state.ts, broadcast.ts
```

Dependency order (no cycles): `state → peers → scopes → binding / broadcast → video → persistence → assets`

---

### 3. `apps/web/src/lib/editorStore.ts` (1187 lines → ~120 lines assembly) ✅ Done

**What it actually contains (from code):**

| Lines     | Group               | What it does                                                                                                                                                                |
| --------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–19      | Imports + helpers   | `generateSlideId` (now `crypto.randomUUID()`), `SaveStatus` type                                                                                                            |
| 21–118    | `EditorState` iface | 40+ fields + every action signature                                                                                                                                         |
| 120–146   | Module-level state  | `_nextId`, `_nextZIndex`, `sendLayerUpdate` (throttled), `broadcastSlides` helper                                                                                           |
| 148–259   | Project loading     | `loadProject` (fetch project + commit, join scope, wait hydrate, seed from commit), `switchSlide`                                                                           |
| 297–458   | Layer state         | `hydrate`, `upsertLayer`, `removeLayer`, `updateProgress`, `updateLayerConfig`, `toggleLayerVisibility`, `deselectAllLayers`, `toggleLayerSelection`                        |
| 460–558   | Pure setters        | `setSlides`, `setActiveSlideId`, `setSelectedSlides`, `setStroke*`, `setShapeFill`, `setInsertionCenter/Viewport`                                                           |
| 560–582   | Save + allocators   | `markDirty`, `saveProject`, `allocateId`, `allocateZIndex`                                                                                                                  |
| 584–928   | Layer actions       | `deleteSelectedLayer`, `bringToFront`, `sendToBack`, `addTextLayer`, `addMapLayer`, `addWebLayer`, `addShapeLayer`, `addLineLayer`, `clearStage`, `reboot`, `reorderLayers` |
| 930–1054  | Slide operations    | `addSlide`, `copySlide`, `deleteSlide`, `renameSlide`, `reorderSlides`, `toggleSlideSelection`, tool toggles, text edit state                                               |
| 1057–1166 | Engine wiring       | `subscribeToJson` (hydrate/upsert/delete/progress/slides/assets/wall msgs), `onConnectionStatusChange`, `subscribeToSaveResponse`                                           |
| 1168–1187 | HMR + store export  | `window.__EDITOR_STORE__` singleton guard, `import.meta.hot` state preservation                                                                                             |

**Key coupling — the zustand `create` closure:**
Every action from line 148 to 1054 is defined inside `create<EditorState>()((set, get) => { ... })`.
They all close over `set` and `get`. The standard zustand pattern for splitting this is
**slices**: each sibling exports a factory `(set, get, helpers) => actions-object` that the
main creator spreads in. `set` and `get` are passed down, not imported — no circular deps.

The engine subscription block (lines 1057–1166) is entirely outside the `create` call and
runs once at module load — it's a natural extraction boundary.

**Actual structure (as built):**

```
apps/web/src/lib/editorStore.types.ts    — EditorState interface, SaveStatus, SliceHelpers, EditorStateCreator
apps/web/src/lib/editorStore.project.ts  — createProjectSlice(set, get, helpers): loadProject, switchSlide
apps/web/src/lib/editorStore.layers.ts   — createLayerSlice(set, get, helpers): hydrate, upsertLayer,
                                           removeLayer, updateProgress, updateLayerConfig,
                                           toggleLayerVisibility, deselectAllLayers, toggleLayerSelection,
                                           deleteSelectedLayer, bringToFront, sendToBack,
                                           addTextLayer/Map/Web/Shape/Line, clearStage, reboot,
                                           reorderLayers (~510 lines, largest sibling)
apps/web/src/lib/editorStore.slides.ts   — createSlideSlice(set, get, helpers): addSlide, copySlide,
                                           deleteSlide, renameSlide, reorderSlides, toggleSlideSelection
apps/web/src/lib/editorStore.ui.ts       — createUiSlice(set, get, helpers): all pure setters, markDirty,
                                           saveProject, allocateId/ZIndex, tool toggles,
                                           startTextEditing, stopTextEditing
apps/web/src/lib/editorStore.engine.ts   — wireEngineSubscriptions(store): engine → store bindings
                                           for hydrate/upsert/delete/progress/slides/assets/wall events
apps/web/src/lib/editorStore.ts          — assembly: _nextId/_nextZIndex, single throttled sendLayerUpdate,
                                           broadcastSlides, SliceHelpers object, create<EditorState>()
                                           spreading all slices, HMR singleton guard (~120 lines)
```

**`SliceHelpers`** threads `{ sendLayerUpdate, broadcastSlides, allocateId, allocateZIndex, setNextId, setNextZIndex, peekNextId, peekNextZIndex }` into each slice — avoids multiple throttle instances and keeps allocator state in one place.

---

### 4. `apps/web/src/components/EditorSlate.tsx` (1331 lines)

**What it actually contains (from code):**

| Lines     | Group                    | What it does                                                                                                          |
| --------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 1–70      | Imports + geometry utils | Constants, `snapToGrid`, `getDistance`, `getAngle`, `normalizeRotationToQuadrant`, `touchToStagePoint`                |
| 72–244    | Stage setup              | Engine instance, layer shadow ref, store subscriptions, insertion viewport sync, ResizeObserver, HMR rehydrate signal |
| 246–330   | Binary fast-path         | `subscribeToBinary` for position/rotation — direct Konva node mutation, no React re-render                            |
| 332–450   | Upload (Uppy TUS)        | Uppy config, token fetch, scrub insecure resume entries, `onSuccess` → `upsertLayer`                                  |
| 452–550   | Mouse/touch drag         | `dragStart`/`dragEnd`/`dragMove` — selection box + layer drag + grid snap + auto-scroll                               |
| 552–680   | Drawing mode             | Draw event listeners, point accumulation, live line preview, save on finish                                           |
| 682–800   | Konva layer render loop  | Map store layers → Konva nodes (`KonvaStaticImage`, `KonvaTextLayer`, `KonvaVideo`, `MapWrapper`)                     |
| 802–1050  | Transform + text edit    | Transformer attach/detach, `onTransform` binary broadcast, double-click text edit, keyboard shortcuts                 |
| 1100–1331 | Viewport + render output | Stage zoom/pan, fit-to-viewport, full JSX (Stage → Group → layers → Transformer → toolbar overlay)                    |

**Key coupling:**

- The binary fast-path (lines 246–330) directly mutates Konva nodes via refs and also
  updates `layersRef` shadow state for text reflow. This is an intentional optimization
  that bypasses React — splitting it out would require exposing the Konva node refs.
- The Konva render loop (682–800) is tightly coupled to the store's layer map and Konva
  component types — it's already well-factored for its purpose.

**Most valuable extraction: geometry utils + shared constants (cross-cutting items A/B above).**
The rest of the file is a single-concern Konva editor — splitting it further would
create components that have nothing to say on their own without the surrounding context.

**Target structure:**

```
apps/web/src/lib/stageConstants.ts    — SCREEN_W, SCREEN_H, COLS, ROWS (shared with wall/controller)
apps/web/src/lib/stageGeometry.ts     — snapToGrid, getDistance, getAngle,
                                        normalizeRotation, touchToStagePoint (shared)
apps/web/src/lib/editorUpload.ts      — Uppy + TUS configuration factory (~120 lines)
apps/web/src/components/EditorSlate.tsx — reduced to ~900 lines after extractions
```

Further split of EditorSlate into sub-components is **not recommended** without a clear
UI reason. The binary fast-path, Konva refs, and React state are too intertwined to
benefit from mechanical separation.

---

### 5. `apps/web/src/components/EditorToolbar.tsx` (918 lines)

**What it actually contains (from code):**

| Lines   | Group                    | What it does                                                                                                |
| ------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 64–210  | State subscriptions      | 8 separate `useEditorStore` calls (project header, layer, tool state, actions)                              |
| 211–282 | Web layer controls       | Local `webUrl` state, throttled URL/proxy/filter broadcasts, screenshot capture                             |
| 284–380 | Wall binding UI          | Pending bind state, override result listener, wall picker popover, disconnect                               |
| 382–511 | Title + content buttons  | Close/back button, add content buttons (image/shape/text/map/web/draw), project name + save status          |
| 512–642 | Layer tools              | Ordering (front/back), filter presets grid + sliders, text edit button                                      |
| 643–888 | Media appearance + video | `AppearanceToolbar` (stroke/fill for drawing/shapes), `PlaybackControls` + `VideoScrubber` for video layers |
| 889–918 | Dialogs                  | `SlidesJsonDialog`, clear stage confirmation                                                                |

**Key coupling:** All sections read from `useEditorStore`. Splitting into sub-components
is sound but they all still need store access — pass as props or keep store calls in the
parent.

**Observation:** `PlaybackControls` and `VideoScrubber` are already separate components
(imported at line 44/45). `AppearanceToolbar` is also separate. The remaining large
sections are the web layer panel (~120 lines) and the filter panel (~130 lines).

**Target structure:**

```
apps/web/src/components/editor-toolbar/
  EditorToolbar.tsx         — composition root, state subscriptions, layout (~250 lines)
  WebLayerPanel.tsx         — URL input, proxy toggle, screenshot capture (~120 lines)
  FilterPanel.tsx           — filter presets, brightness/contrast/hue/sat/blur sliders (~130 lines)
  WallBindingBar.tsx        — pending bind, override listener, picker popover, disconnect (~100 lines)
  LayerOrderingBar.tsx      — bring to front/back buttons, layer-specific tool buttons (~80 lines)
```

`PlaybackControls`, `VideoScrubber`, and `AppearanceToolbar` are already extracted —
no action needed there.

---

### 6. `apps/web/src/routes/wall/index.tsx` (813 lines)

**What it actually contains (from code):**

| Lines   | Group                   | What it does                                                                                          |
| ------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| 1–124   | Route + enrollment      | Route def, device enrollment check, viewport calc (COLS/ROWS), engine init/cleanup                    |
| 126–248 | Hydrate fade            | `iframeGateCycle`, fade overlay, `markIframeReady`, `WallEngine` hydrate callback                     |
| 250–518 | rAF loop + AABB culling | Animation loop, per-layer transform + culling math, layer visibility updates                          |
| 519–781 | HTML layer renderer     | `<div>`/`<img>`/`<iframe>`/`<video>` per layer type with `commonProps` pattern (see cross-cutting §C) |
| 746–781 | Custom render iframe    | `customRenderUrl` compat mode for multi-screen layouts                                                |
| 783–813 | DOM root + HMR          | Top-level div, visual debugger overlay, fade overlay, HMR disposal                                    |

**Clearest split:**

- Extract HTML layer renderer to shared `WallLayerRenderer.tsx` (cross-cutting §C)
- Extract AABB culling + rAF loop into `useWallAnimationLoop.ts` hook

```
apps/web/src/routes/wall/
  index.tsx                     — route shell, enrollment, engine lifecycle, DOM root (~250 lines)
  hooks/useWallAnimationLoop.ts — rAF loop, AABB culling, layer visibility updates (~200 lines)
  hooks/useWallHydration.ts     — hydrate fade, iframeGateCycle, markIframeReady (~120 lines)
```

Shared `WallLayerRenderer.tsx` used by both wall and controller (see below).

---

### 7. `apps/web/src/routes/controller/index.tsx` (1102 lines)

**What it actually contains (from code):**

| Lines    | Group                   | What it does                                                                                |
| -------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| 1–118    | Route + line builder    | Route def, line layer factory, drawing state (startLine/appendLinePoint/consumeCurrentLine) |
| 120–380  | Session state           | Binding signal timeout, hydrate handler with slide binding, layer upsert/delete             |
| 382–583  | Drawing handlers        | `addLineLayer`, `getStagePoint`, `handleDrawStart/Move/End`                                 |
| 587–720  | HTML layer renderer     | Near-identical to wall's layer renderer (see cross-cutting §C)                              |
| 722–849  | Touch/pinch + slide nav | Two-finger scroll for stage panning, `handleTouchMove`                                      |
| 852–1102 | UI overlay + JSX        | Toolbar, binding signal badge, slide navigator, drawing toolbar, Konva Stage                |

**Drawing state (`startLine`/`appendLinePoint`/`consumeCurrentLine`) is a reusable hook.**
It appears only in controller but would benefit from extraction for testability.

```
apps/web/src/routes/controller/
  index.tsx                           — route shell, hydrate handler, JSX (~300 lines)
  hooks/useControllerDrawing.ts       — line state machine, draw event handlers (~200 lines)
  hooks/useControllerSession.ts       — binding signal, layer state, slide sync (~200 lines)
```

Shared `WallLayerRenderer.tsx` replaces the duplicated HTML layer renderer block.

---

### 8. `apps/web/src/routes/yjs/$.ts` (669 lines — lexical.ts already extracted)

**What it actually contains (from code):**

| Lines   | Group                  | What it does                                                                                                                                                                                                  |
| ------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–49    | Imports + constants    | crossws, Y.js, lib0, `messageSync`/`messageAwareness`/`SYNC_INTERVAL_MS`, type aliases                                                                                                                        |
| 50–154  | Peer state utils       | `YjsPeerState`, `getYjsPeerState`/`set`/`clear`, `waitForOpenCompletion`, `getDocName`, `parseScope`, `binaryToUint8Array`                                                                                    |
| 155–209 | `MongoYDocPersistence` | `Persistence` interface, `bindState` (load binary from MongoDB), `writeState` (upsert binary)                                                                                                                 |
| 210–273 | `SharedDoc` class      | Y.Doc subclass, awareness, peer tracking, sync loop timer, `onAwarenessUpdate`                                                                                                                                |
| 274–634 | `YCrossws` class       | `onOpen` (auth + scope + sync_step1), `onMessage` (sync/awareness relay), `onClose` (cleanup + flush), `onDocUpdate`, `flushDoc` (HTML delta + bus bridge), `createDoc`/`getDoc`, `recomputePeerAuthContexts` |
| 635–669 | Route + process bridge | `YCrossws` singleton, `defineHooks`, `process.__YJS_RECOMPUTE_AUTH_CONTEXT__`, `Route` export                                                                                                                 |

**Key couplings:**

- `SharedDoc` back-references `YCrossws` via constructor arg for `onDocUpdate`/`flushDoc` — the two classes are co-dependent by design.
- `flushDoc` calls `yDocToHtml` (from `lexical.ts`) and `process.__YJS_UPSERT_LAYER__` (bus bridge) — only external dependencies.
- `loadTextLayer` reads `dbCol.commits` — pure DB, no WS state.

**Target structure:**

```
apps/web/src/routes/yjs/
  $.ts            — slimmed: YCrossws singleton, defineHooks, process bridge, Route export (~55 lines)
  lexical.ts      — already extracted ✅
  yjs.doc.ts      — SharedDoc class, MongoYDocPersistence, Persistence interface,
                    loadTextLayer, binaryToUint8Array (~200 lines)
  yjs.session.ts  — YCrossws class (onOpen/onMessage/onClose/onDocUpdate/flushDoc/
                    createDoc/getDoc/recomputePeerAuthContexts),
                    peer state utils (getYjsPeerState/set/clear/waitForOpenCompletion),
                    parseScope, getDocName (~385 lines)
```

**Why not split YCrossws further:** all `YCrossws` methods share `this.docs`, `this.peers`, `this.initializing`, and `this.persistence`. Extracting handlers as free functions would require threading `YCrossws` as a parameter — noise with no readability gain. The natural seam is data structures (`yjs.doc.ts`) vs. orchestration (`yjs.session.ts`).

**Dep order:** `lexical.ts` → `yjs.doc.ts` → `yjs.session.ts` → `$.ts`

---

## Priority and milestone order

| #   | Action                                                    | Files                         | Status   | Reason                                                                                               |
| --- | --------------------------------------------------------- | ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| 0a  | Extract `lib/stageConstants.ts`                           | wall, controller, EditorSlate | ✅ Done  | 5-minute win; unblocks later splits                                                                  |
| 0b  | Extract `lib/stageGeometry.ts`                            | EditorSlate, wall             | ✅ Done  | Shared pure utils; enables EditorSlate reduction                                                     |
| 0c  | Replace `generateSlideId()` with `crypto.randomUUID()`    | editorStore                   | ✅ Done  | Consistency with server side                                                                         |
| 1   | Extract `WallLayerRenderer.tsx`                           | wall, controller              | ⏭ Skip  | Controller now uses Konva — HTML renderer no longer shared                                           |
| 2   | Extract `yjs/lexical.ts`                                  | yjs                           | ✅ Done  | Most self-contained extraction in the codebase                                                       |
| 3   | Split `bus.ts` → flat `bus.*.ts` siblings                 | bus                           | ✅ Done  | Highest risk file; split into 6 files (authz/crypto/binding/peers/handlers/ts)                       |
| 4   | Split `busState.ts` → flat `busState.*.ts` siblings       | busState                      | ✅ Done  | 8 siblings + barrel; strict dep order: state→persistence→binding→scopes→peers→broadcast→video→assets |
| 5   | Full `yjs/$.ts` split                                     | yjs                           | ✅ Done  | Split into `$.ts` (36), `yjs.doc.ts` (178), `yjs.session.ts` (471)                                   |
| 6   | Split `editorStore.ts` → flat `editorStore.*.ts` siblings | editorStore                   | ✅ Done  | 6 siblings: types/project/layers/slides/ui/engine + slimmed assembly (~120 lines)                    |
| 7   | Extract `EditorToolbar` sub-panels                        | EditorToolbar                 | **Next** | Independent UI panels; low risk                                                                      |
| 8   | Extract `useWallAnimationLoop` + `useWallHydration`       | wall                          |          | Self-contained hooks                                                                                 |
| 9   | Extract `useControllerDrawing` + `useControllerSession`   | controller                    |          | After wall hooks done                                                                                |
| 10  | Reduce `EditorSlate.tsx` with extracted utils             | EditorSlate                   |          | After stageGeometry + editorUpload extracted                                                         |

---

## Refactor guardrails

- One milestone per PR; no mega-refactors.
- Re-export from `index.ts` so existing call sites do not change.
- After every split: `tsc --noEmit` + smoke-test affected WS flows.
- Do not touch `routeTree.gen.ts` directly.
- `busState/state.ts` must never import from its siblings (root of dep tree).
- Process bridges (`process.__XXX__`) live in the module that owns the handler,
  not in a separate `bridges.ts` fan-in.

---

## Recent progress

### 2026-04-03

- Endpoint auth matrix (`docs/ENDPOINTS_AUDIT.md`) refreshed.
- `/bus` authz tightened (`seed_scope` moved to edit-authorized set).
- `/api/assets/$uri` returns 404 for unauthorized authenticated users.

### 2026-04-06

- Removed all serializers (`project/asset/wall/commit/audit.serializer.ts`).
- Deleted `packages/db/src/schema/` directory; replaced with flat `schema.ts`.
- All foreign keys (`projectId`, `authorId`, `parentId`, etc.) now `string` in document interfaces — ObjectId conversion owned entirely by collection layer.
- `deviceId` removed; MongoDB-generated `id` used everywhere.
- `serialization.ts` deleted.
- `CreateProjectInput` / `UpdateProjectInput` inlined into `projects.fns.ts`; removed from shared schema.

### 2026-04-08

- **Milestone 6 complete**: `editorStore.ts` (1187 lines) split into 6 flat siblings + slimmed assembly:
    - `editorStore.types.ts` — `EditorState`, `SliceHelpers`, `SaveStatus`
    - `editorStore.project.ts` — `createProjectSlice`: `loadProject`, `switchSlide`
    - `editorStore.layers.ts` — `createLayerSlice`: hydrate, upsert/remove, add\* factories, reorder, visibility, selection
    - `editorStore.slides.ts` — `createSlideSlice`: add/copy/delete/rename/reorder, toggle selection
    - `editorStore.ui.ts` — `createUiSlice`: stroke/fill setters, insertion viewport, markDirty, saveProject, tool toggles, allocators
    - `editorStore.engine.ts` — `wireEngineSubscriptions`: all engine→store event bindings (hydrate/upsert/delete/progress/slides/assets/wall)
    - `editorStore.ts` — assembly: module-level `_nextId`/`_nextZIndex`, single throttled `sendLayerUpdate`, `broadcastSlides`, `SliceHelpers`, slice spreads, HMR guard (~120 lines)
- `SliceHelpers` threads shared utilities (throttle instance, allocators, peek/set accessors) into each slice without re-instantiation.
- Zero new TSC errors introduced (pre-existing `$getCommit` return-type drift unrelated to this split).
- **Next**: `EditorToolbar.tsx` (918 lines) — extract sub-panels (`WebLayerPanel`, `FilterPanel`, `WallBindingBar`, `LayerOrderingBar`).

### 2026-04-07 (continued)

- **Milestone 5 complete**: `yjs/$.ts` (669 lines) split into `$.ts` (36) + `yjs.doc.ts` (178) + `yjs.session.ts` (471). `YcRef` interface breaks the would-be circular dep between `SharedDoc` and `YCrossws`.

### 2026-04-07

- **Milestones 3 + 4 complete**: `busState.ts` (1474 lines) and `bus.ts` (2418 lines) both split into flat siblings — no subdirectories, barrel re-exports preserve all existing `~/lib/busState` import sites.
- `busState.ts` → 8 siblings: `busState.state.ts`, `busState.persistence.ts`, `busState.binding.ts`, `busState.scopes.ts`, `busState.peers.ts`, `busState.broadcast.ts`, `busState.video.ts`, `busState.assets.ts` + barrel.
- `bus.ts` → 5 siblings: `bus.authz.ts`, `bus.crypto.ts`, `bus.binding.ts`, `bus.peers.ts`, `bus.handlers.ts` + slimmed `bus.ts` (hooks + loops + bridges).
- Milestone 1 (WallLayerRenderer) marked skip — controller now uses Konva, HTML renderer is no longer shared.
- Milestone 2 (yjs/lexical.ts) confirmed already done.
