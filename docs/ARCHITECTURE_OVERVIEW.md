# Architecture Overview

## Purpose

This document gives a high-level map of the Vizzy Studio runtime, boundaries, and entry points.

For transport and state-flow detail, see [BUS_PIPING.md](./BUS_PIPING.md).

## System At A Glance

Vizzy Studio is a collaborative slide platform with four realtime roles:

- `editor`: authoring and stage editing
- `wall`: rendering node endpoint
- `controller`: wall control and playback/navigation
- `gallery`: public wall-binding and project display surface

Core capabilities:

- realtime collaboration over `/bus`
- scope-based state (`projectId + commitId + slideId`)
- commit-backed persistence and autosave
- upload/transcode pipeline with live asset events
- Yjs co-bus for text collaboration

## Main Runtime Components

## 1) Realtime Bus

- route: `apps/web/src/routes/bus.ts`
- runtime state: `apps/web/src/lib/busState.ts`
- handler modules: `apps/web/src/server/bus/*.ts`

Responsibilities:

- peer handshake and registration
- authorization/rate-limit enforcement
- scope hydration and layer fanout
- wall bind/unbind orchestration
- playback synchronization (JSON + binary)
- process bridges for cross-route/server-function fanout

## 2) YJS Co-Bus (Text Collaboration)

- route: `apps/web/src/routes/yjs.$.ts`
- orchestration: `apps/web/src/server/yjs/yjs.session.ts`
- shared doc/persistence: `apps/web/src/server/yjs/yjs.doc.ts`

Responsibilities:

- CRDT sync and awareness per text-layer doc
- persistence to `ydocs`
- Yjs->HTML conversion
- bridge updates into `/bus` via `__YJS_UPSERT_LAYER__`

## 3) Editor Domain

- engine: `apps/web/src/lib/editorEngine.ts`
- store: `apps/web/src/lib/editorStore.ts`
- primary UI routes: `apps/web/src/routes/_auth/quarry/editor/*`

Responsibilities:

- emits authoring commands (`upsert_layer`, `delete_layer`, `seed_scope`, `update_slides`)
- joins/leaves scopes
- handles hydrate, playback, and bind-override result events

## 4) Wall Domain

- engine: `apps/web/src/lib/wallEngine.ts`
- route: `apps/web/src/routes/wall/index.tsx`

Responsibilities:

- render hydrated layer state
- apply movement/playback updates with clock sync
- reflect custom render configuration from binding state

## 5) Controller Domain

- engine: `apps/web/src/lib/controllerEngine.ts`
- route: `apps/web/src/routes/controller/index.tsx`

Responsibilities:

- wall-aware bind/navigation commands
- playback control and slide snapshots
- transient draw overlays (`controller:add_line_layer`)

## 6) Gallery Domain

- engine: `apps/web/src/lib/galleryEngine.ts`
- route: `apps/web/src/routes/gallery/index.tsx`

Responsibilities:

- consume `gallery_state` and incremental wall/project events
- initiate/observe gallery-source binding actions
- approve/deny editor takeover requests (`bind_override_*`)
- keep project cards in sync with wall binding changes

## 7) Upload and Asset Pipeline

- route: `apps/web/src/routes/api/uploads/$.ts`

Responsibilities:

- upload ingestion and processing
- asset metadata persistence
- realtime progress and `asset_added` events via bus bridges

## 8) Server/Persistence Domain

- server modules: `apps/web/src/server/*.ts`
- db package: `packages/db`

Key collections:

- `projects`
- `commits`
- `assets`
- `walls`
- `devices`
- `ydocs`

## Scope Model (Short)

- canonical scope label: `e:${projectId}:${commitId}:${slideId}`
- runtime scope key: interned numeric `ScopeId`
- wall binding: `wallId -> scopeId` (+ `boundSource: live|gallery`)
- commit fanout index: `commitId -> Set<ScopeId>`
- Yjs doc key: `${projectId}_${commitId}_${slideId}_${layerId}`

## Runtime Boundaries

- bus state is in-memory and process-local
- HTTP/server-function calls and websocket handlers must share runtime affinity (or externalize state) for strong cross-path consistency

## Where To Start

1. Read [BUS_PIPING.md](./BUS_PIPING.md) for protocol and lifecycle details.
2. Validate message contracts in `apps/web/src/lib/types.ts`.
3. Trace role-specific behavior from engines (`editorEngine`, `wallEngine`, `controllerEngine`, `galleryEngine`) into `/bus` handlers.
4. For text sync issues, start with Yjs route/session and the `__YJS_UPSERT_LAYER__` bridge.
