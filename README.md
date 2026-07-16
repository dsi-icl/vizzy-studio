# Vizzy Studio

Collaborative, multi-tenant presentation system for large video walls.

Vizzy Studio lets multiple users edit decks in real time and publish synchronized output to distributed wall nodes. The platform is optimized for low-latency editing, fast wall playback, and commit-based versioning.

## Architecture Docs

- [Architecture Overview](./docs/ARCHITECTURE_OVERVIEW.md): high-level system structure, ownership boundaries, and onboarding path.
- [Realtime Protocol](./docs/REALTIME_PROTOCOL.md): `/bus` and `/yjs` transport/message semantics.
- [Bus Piping](./docs/BUS_PIPING.md): detailed topology for the realtime bus, scope model, YJS co-bus integration, and naming/refactor proposals.
- [Gallery State Machine](./docs/GALLERY_STATE_MACHINE.md): current gallery card/dialog transitions, sync semantics, and refactor direction.
- [README.md](./README.md): high-level project overview and contributor onboarding.

## What It Does

- Real-time collaborative editing of slide-based decks
- Multi-endpoint runtime with specialized clients:
    - `editor`: authoring UI
    - `wall`: render node
    - `controller`: wall binding/orchestration
    - `gallery`: presentation-aware public control/listing surface
- Commit graph with mutable head + immutable snapshot history
- Asset pipeline for image/video upload, processing, and live broadcast to editors

## Tech Stack

- [Turborepo](https://turborepo.com/) + [bun](https://bun.sh/)
- [React 19](https://react.dev) + [React Compiler](https://react.dev/learn/react-compiler)
- TanStack [Start](https://tanstack.com/start/latest) + [Router](https://tanstack.com/router/latest) + [Query](https://tanstack.com/query/latest) + [Form](https://tanstack.com/form/latest)
- [Vite 8](https://vite.dev/) + [Nitro v3](https://v3.nitro.build/)
- [Tailwind CSS v4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) + [Base UI](https://base-ui.com/) (base-maia)
- [MongoDB](https://www.mongodb.com/)
- [Better Auth](https://www.better-auth.com/)
- [Oxlint](https://oxc.rs/docs/guide/usage/linter.html) + [Oxfmt](https://oxc.rs/docs/guide/usage/formatter.html)

## Repository Layout

```sh
├── apps
│    ├── web                    # TanStack Start web app + Nitro websocket routes
├── packages
│    ├── auth                   # Better Auth
│    ├── db                     # MongoDB
│    ├── emails                 # Template for emails
│    └── ui                     # shadcn/ui primitives & utils
├── tooling
│    └── tsconfig               # Shared TypeScript configuration
├── turbo.json
├── LICENSE
└── README.md
```

## Core Runtime Architecture

### 1) WebSocket Bus (`apps/web/src/addons/routes/bus.ts` + `apps/web/src/lib/busState.ts`)

- Tracks peers by role (`editor`, `wall`, `controller`, `gallery`)
- Interns `(projectId, commitId, slideId)` into numeric `ScopeId`
- Maintains in-memory scope layer state for fast relay/hydrate
- Runs periodic loops:
    - VSYNC sync loop for active videos
    - Autosave loop for dirty scopes
    - Stale-peer reaper loop
- Broadcast bridges:
    - `__BROADCAST_EDITORS__` for processing progress
    - `__BROADCAST_ASSET_ADDED__` for newly created assets
    - `__BROADCAST_WALL_BINDING_CHANGED__` for server-side bind/unbind mutations
    - `__BROADCAST_PROJECT_PUBLISH_CHANGED__` for publish/unpublish propagation to gallery peers

For full flow maps (bind/unbind, hydrate, scope internals, YJS bridge path), see [PIPING](./docs/BUS_PIPING.md).

### Gallery WS Migration (WIP)

- `gallery` socket scaffolding is now available via `apps/web/src/lib/galleryEngine.ts`.
- Initial `/bus` handshake support for `specimen: 'gallery'` and `gallery_state` snapshots is in place.
- Implemented over WS:
    - bind override approval flow for editor bind requests
    - publish/unpublish live feed
    - admin/gallery wall bind/unbind propagation
- Remaining migration work is mostly UX-level data shaping and removing residual query polling paths.
- Gallery dialog sync uses separate UI intent signals:
    - `forceCloseSignal`: synced close for connected cards on wall unbind (applies to fullscreen/minimized).
    - `forceCloseMinimizedSignal`: live-session transition helper to close minimized cards while fullscreen cards are demoted to expanded.
      These are intentionally separate because unbind and live-transition flows require different state transitions.
- Full transition contract is documented in [Gallery State Machine](./docs/GALLERY_STATE_MACHINE.md).

### Portal API (Controller Tokens)

- Gallery now issues short-lived controller API tokens (`viz_ctrl_*`) when opening a controller session.
- Token is injected into controller URL as `_viz_t=<token>`.
- Tokens are bound to the current wall + bus scope and are revoked automatically when:
    - wall is rebound,
    - wall is unbound,
    - or scope is garbage-collected.
- Current proof-of-concept endpoint:
    - `POST /api/portal/v1/reboot`
    - Auth via `Authorization: Bearer <token>` (query fallback `_viz_t` is also accepted).
    - Optional node targeting using `{ c, r }` in JSON body for wall node coordinates.
- CORS is enabled for `/api/portal/v1/reboot` to support external custom controllers on other domains.
- Compatibility with older `_gem_t=<token>` is conserved

### 2) Editor State (`apps/web/src/lib/editorStore.ts`)

- Zustand store for layers, slides, selection, and tool state
- Handles optimistic updates and server synchronization
- Uses throttled layer update sends to reduce network chatter

### 3) Upload Pipeline (`apps/web/src/routes/api/uploads/$.ts`)

- Tus upload ingestion
- Media type detection and post-processing
- Image path:
    - Copy original
    - Blurhash compute
    - WebP size variant generation
- Video path:
    - FFmpeg transcode to MP4
    - Preview frame extraction
    - Blurhash + variant generation from preview
- Inserts asset metadata and broadcasts to active editors

### Media Processing Isolation Plan (Staged)

- Goal: isolate CPU-heavy media work (`sharp`, `ffmpeg`) from web request handlers, while preserving current UX and protocol behavior.
- Phase 1 contract: `STRICT_BLOCKING=true` by default.
    - Meaning: upload response still waits for processing completion (same behavior as today).
    - Reason: avoids changing editor assumptions about immediate asset readiness during initial isolation rollout.
    - Future direction: optional async mode (`202 Accepted`) once editor/runtime supports pending assets and progressive metadata hydration.
- Job state model: hybrid persistence + signaling.
    - Persistent truth in DB (job lifecycle, retries, recovery after restarts).
    - Pub-sub for low-latency progress/completion events between processes.
    - Rationale: pub-sub alone is fast but not durable; DB alone is durable but noisier for live signaling.
- Timeout policy for long video processing:
    - Use inactivity timeout based on last progress heartbeat, not absolute wall-clock job duration.
    - Long-running transcodes are valid; only fail when no progress has been observed for the configured stale interval.
- Architectural note for async pipeline adoption:
    - Fully asynchronous media processing implies layers may exist before complete asset metadata is ready.
    - We likely need a cleaner separation between layer content and asset metadata/progress state.
    - Potential outcome: keep commit `content.slides[*].layers` lean and fetch/enrich asset metadata via dedicated asset state paths.
- Hardening next steps:
    - Add maintenance controls for `jobs` retention (TTL or scheduled prune) so completed/failed rows do not grow unbounded.
    - Harden retry classification and stale-job recovery policy (transient vs permanent failures, deterministic multi-instance behavior, clearer user-facing errors).
    - Replace direct `url` fields in image/video/web layers with stable asset pointers (for example `assetId`).
    - This prevents metadata duplication across layers (including variant sizing and blurhash concerns), improves file lifecycle management, and keeps commit payloads lean.

### 4) Persistence and Versioning

- Projects, commits, assets in MongoDB
- Mutable HEAD commit used for active editing/autosave
- Manual save creates immutable snapshot and advances chain pointer
- Slide metadata updates persist independently from layer payloads

## Data Model Notes

- `projects`: ownership/collaborators, `headCommitId`, `publishedCommitId`
- `commits`: graph nodes with `parentId`, `content.slides[*].layers`
- `assets`: media metadata, URLs, preview/blurhash, variants, visibility

## Local Development

### Prerequisites

- Bun
- MongoDB replica set
- Environment variables configured in `.env`

### Commands

- Install deps: `bun install`
- Run all dev targets: `bun run dev`
- Run web only: `bun run dev:web`
- Lint: `bun run lint`
- Format: `bun run format`
- Quality checks: `bun run check`
- Build web (generates legal notice artifacts): `bun run --filter=@repo/web build`
- Docker test stack up (build + detached): `bun run docker:test:up`
- Docker test stack status: `bun run docker:test:ps`
- Docker test stack logs (follow): `bun run docker:test:logs`
- Docker test stack down: `bun run docker:test:down`
- Docker test stack reset (remove volumes): `bun run docker:test:reset`

### Container Source Maps (Debug Builds)

- Local debug image with source maps embedded:
  `BUILD_SOURCEMAPS=true KEEP_SOURCE_MAPS=true bun run docker:build`
- Local production-like image without source maps:
  `BUILD_SOURCEMAPS=false KEEP_SOURCE_MAPS=false bun run docker:build`
- CI workflow `Container Image (OCI)` supports a manual `workflow_dispatch` toggle (`include_sourcemaps`) to keep `.map` files in published images.

## Main application entry points

- `/gallery` project listing
- `/quarry` project management
- `/quarry/editor` editor flow
- `/wall` wall node endpoint (query params `c`, `r`, `w`)

## Operational Invariants

- Scope identity is `(projectId, commitId, slideId)` and must remain stable
- Bus cleanup must not delete active scopes (editors/walls present)
- Video sync timestamps are authoritative server-side once playback starts
- Autosave only updates mutable HEAD context

## Third-Party Notices

- Build-time plugin: `apps/web/plugins/thirdPartyNotices.ts`
- Generated artifacts:
    - `/third-party-notices.json`
    - `/THIRD_PARTY_NOTICES.txt`
- In-app page: `/legal/notices`

The notices are generated from tree-shaken modules detected in production bundle chunks.

## Text Rendering Model

- Text styling is authored in Lexical HTML and rendered through both:
    - editor DOM,
    - canvas via SVG `foreignObject`,
    - wall DOM renderer.
- Baseline text context (font family, base font size, line-height, padding) is centralized in `apps/web/src/lib/textRenderConfig.ts` and reused by all renderers to avoid drift.
- Font size in toolbar is displayed as virtual `px` for UX, but stored as `em` in inline styles for scale-safe persistence.
- Canonical text scale for font-size conversion uses `scaleY` by design. Alternative considered: isotropic average `sqrt(scaleX * scaleY)`.

## Known Technical Debt (Current)

- High complexity hotspots:
    - `EditorSlate`
    - `Toolbar`
    - upload route `onUploadFinish`
    - upload route `detectMediaType`

### Known issues

- While a controller is bound to a wall under active editor live broadcast, controller slide state can drift from scope reality; `slides_updated` metadata events are now partially reconciled client-side, but structural slide changes still require full commit refetch and can momentarily desync.
- Gallery takeover confirmation modal currently uses a custom layering treatment instead of the shared app dialog stack; this was introduced to work around dialog z-index conflicts with project cards and should be replaced by a unified, application-level dialog layering fix.
- Upload/session tokens are currently in-memory and unsigned (including upload tokens and portal tokens), so process restart or multi-instance deployment can invalidate active tokens unexpectedly.

### Things to look at in the future

- Upload dialog (`apps/web/src/components/UploadDialog.tsx`): progress tracking is keyed by filename, so same-name files can collide in UI status updates.
- Upload flow token lifecycle: upload tokens are short-lived (15 minutes), and finalize validation occurs server-side; long uploads may fail at finalize if token expiry is hit mid-transfer. Consider a refresh/reissue strategy or finalize-window policy.

### Things to look at in the future

- Upload dialog (`apps/web/src/components/UploadDialog.tsx`): progress tracking is keyed by filename, so same-name files can collide in UI status updates.
- Upload flow token lifecycle: upload tokens are short-lived (15 minutes), and finalize validation occurs server-side; long uploads may fail at finalize if token expiry is hit mid-transfer. Consider a refresh/reissue strategy or finalize-window policy.

## Security Considerations

- Controller endpoints are intentionally public-facing for wall operation flows, but this currently means custom/public controller paths may attempt to access protected app assets without an explicit authz contract.
- A dedicated authorization flow is still required for controller sessions (and likely other public runtime surfaces), so unauthenticated clients cannot access private assets/configuration.
- Recommendation: introduce scoped, short-lived controller/session tokens with explicit asset permissions and origin constraints, then apply the same pattern consistently across other public endpoints.

### Access Control Audit Note (Public/Published vs Membership)

- Do not conflate `membership access` (`canViewProject`: owner/collaborator/admin) with `public/published access` (limited read access for logged-in users when content is public and published).
- Any endpoint using `canViewProject` should be reviewed when used by gallery/public preview flows, to confirm whether strict membership is intended or a scoped public/published exception is required.
- Re-audit these endpoints when changing auth rules:

1. `apps/web/src/server/projects.fns.ts`: `$getProject`, `$getCommit`, `$listAssets`, `$listAssetsByUrlsForPicker`, `$getProjectCommits`, `$getAudits`, `$getAuditsPage`.
2. `apps/web/src/server/bus/bus.peers.ts`: websocket editor session checks in `registerEditorPeer` and `recomputePeerAuthContexts`.
3. `apps/web/src/routes/api/assets/$uri.ts`: public/published fallback logic must stay aligned with gallery preview requirements and not regress to strict membership-only checks.

### CSP rationale (apps/web/src/start.ts)

- CSP is set server-side in middleware and uses a per-request nonce for script execution.
- Development uses `Content-Security-Policy-Report-Only` so violations are visible without breaking local workflow.
- Production enforces CSP and keeps `script-src` strict (dev-only `unsafe-eval` support exists for tooling/HMR behavior).
- Styles are split intentionally:
- `style-src` / `style-src-elem` stay nonce-based in production for `<style>` blocks.
- `style-src-attr 'unsafe-inline'` is enabled because the app currently relies on many React inline style attributes (`style={{ ... }}`) for runtime positioning/rendering.
- Reporting is wired to `/api/report-csp` on the same origin, and both legacy (`report-uri` / `Report-To`) and modern (`Reporting-Endpoints`) signals are emitted to improve browser coverage.
- Current resource directives (`connect-src`, `frame-src`, `img-src`, `media-src`, `font-src`, `worker-src`) are intentionally broader than minimum to support websocket transport, iframe web layers, map resources, and media pipelines; tighten these host lists over time using collected CSP reports.

## Development considerations

### Safe Order for Refactors

1. Pure performance internals with no API changes
2. Dead code removal guarded by lint/tests
3. Component decomposition and behavior-preserving rewrites
4. Optional protocol/index optimizations

### Do-Not-Break Checklist

- Wall hydration on bind/unbind
- Active video sync consistency
- Autosave and manual save semantics
- Asset creation + editor broadcast
- Commit history and branch promotion flows

### Suggested Validation After any Changes

- Lint + type checks
- Upload image/video and verify asset records
- Multi-editor sync test on same scope
- Wall bind/unbind + hydrate verification
- Manual save + publish/unpublish regression pass

## License

[MIT](./LICENSE)
