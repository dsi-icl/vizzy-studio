# Multi-Stage Projects and Digital Signage Design

Status: converged MVP design  
Last reviewed: 2026-07-28

## Purpose

This document defines the first implementation of:

1. Multiple independently versioned stages inside a project.
2. Server-driven digital signage slideshows targeting one or more walls.

The design intentionally optimizes for the smallest functional change set. It preserves the
existing editor, realtime scope, Yjs identity, mutable-HEAD commit behavior, and project-owned
asset model wherever possible.

This is an implementation specification, not a proposal for project-wide staged releases or a
redesign of the realtime bus.

## Agreed MVP Decisions

- Every project can contain multiple stages.
- Every stage has its own independent commit tree.
- Existing projects migrate to one stage named `Main`.
- The migrated Main stage uses a 16 column by 4 row layout with 1920 by 1080 logical pixels per
  screen.
- Stage layouts are freely mutable.
- A project can have only one active stage for a given complete layout signature.
- A stage is published independently through its own `publishedCommitId`.
- Project-level `headCommitId` and `publishedCommitId` are removed immediately.
- There is no project-wide release or staged-release model.
- A commit records its owning `stageId`, but does not snapshot stage layout.
- Editor routes remain based on project, commit, and slide. They do not add a stage route segment.
- Stage context is resolved from `commit.stageId`.
- The existing realtime scope remains `(projectId, commitId, slideId)`.
- Wall hydration carries the resolved stage layout as additive presentation metadata.
- Wall clients render in stage-logical pixels and best-effort scale one logical screen uniformly
  into the browser viewport, with letterboxing where aspect ratios differ.
- Assets remain project-owned and are shared by every stage.
- Slideshow queues persist explicit slide references, not dynamic project entries.
- Selecting a whole project in the slideshow UI expands its currently published matching stage
  into explicit slide entries.
- Slideshow entries always resolve content from the latest published commit of the matching stage.
- Slideshow configuration owns its target wall list.
- A wall does not store a slideshow configuration ID.
- The server owns slideshow timing and playback progression.
- Gallery and Controller cannot override a signage-targeted wall.
- An Editor can temporarily suppress signage on a wall.
- When the Editor releases the wall, it rejoins the slideshow's current server phase.
- Invalid slideshow entries are skipped and shown as invalid in the management UI.
- Server restart begins each enabled slideshow from its first valid entry.
- Calendar scheduling, dayparts, transitions, custom-render projects, commit pinning, and
  distributed/multi-process scheduling are outside the MVP.

## Terminology

### Stage

A project-owned authoring surface with:

- One layout.
- Its own slides and layers.
- Its own mutable HEAD and commit history.
- Its own published commit.
- Access to the project's shared assets.

Use `ProjectStage` or `StageDefinition` in code where necessary to avoid confusion with the Konva
`Stage` component.

### Layout

A layout is the full logical screen-grid signature:

```ts
interface StageLayout {
    columns: number;
    rows: number;
    screenWidth: number;
    screenHeight: number;
}
```

The overall logical canvas dimensions are:

```text
canvasWidth  = columns × screenWidth
canvasHeight = rows × screenHeight
```

All four fields participate in layout matching and the one-stage-per-layout invariant.

`screenWidth` and `screenHeight` are logical authoring pixels. They do not claim that the browser
or physical panel has exactly that resolution.

### Default stage

Every project has one `defaultStageId`.

For the MVP, this single concept serves both purposes:

- It is the stage opened by project-level Edit/default navigation.
- It is the stage presented by Gallery.

The stage configuration UI exposes this as a single-choice control such as **Present to Gallery**
or **Default / Gallery stage**. New and migrated projects default it to their Main stage.

Do not add separate `mainStageId` and `galleryStageId` fields during the MVP. They can be split in a
later change if editing-default and Gallery-presentation requirements genuinely diverge.

The coupling is intentional: project-level Edit should open the stage currently presented by
Gallery.

## Data Model

### Project

The project embeds small stage descriptors:

```ts
interface ProjectStage {
    id: string;
    name: string;
    order: number;
    layout: StageLayout;
    headCommitId: string | null;
    publishedCommitId: string | null;
    archivedAt?: number | null;
}

interface ProjectDocument {
    // Existing project metadata, collaborators, custom renderer settings, and ownership.
    defaultStageId: string;
    stages: ProjectStage[];
}
```

The project document no longer has root `headCommitId` or `publishedCommitId` fields.

Embedding stages is deliberate:

- Legacy migration can construct Main from the existing project document.
- No cross-collection stage materialization is required.
- Stage descriptors are small.
- Project assets and collaborators remain naturally shared.

### Commit

```ts
interface CommitDocument {
    projectId: string;
    stageId: string;
    parentId: string | null;
    authorEmail: string | null;
    message: string;
    content: {
        slides: Slide[];
    };
    isAutoSave: boolean;
    isMutableHead: boolean;
}
```

The commit does not contain stage layout.

#### Why `stageId` remains on commits

`stageId` is commit-tree ownership, not slideshow metadata.

Stage HEAD and published pointers identify two commits but do not identify every immutable
snapshot or unpromoted mutable branch belonging to that stage. Without `stageId`, stage history
would need to reconstruct ownership by walking all project commit graphs. Unreferenced branch
heads would be especially awkward to attribute.

`stageId` permits:

- Direct stage-history queries.
- Correct attribution of mutable branch heads.
- Validation that publish and branch promotion stay inside the selected stage.
- Commit-based routes to resolve stage context without adding a stage URL segment.
- A deterministic legacy migration of every existing commit to `stageId: "main"`.

Manual snapshots and new branches must copy the owning `stageId`.

### Signage slideshow

```ts
interface SignageSlideEntry {
    id: string;
    projectId: string;
    slideId: string;
    displayDurationMs?: number;
    gapDurationMs?: number;
}

interface SignageSlideshowDocument {
    id: string;
    name: string;
    layout: StageLayout;
    defaultDisplayDurationMs: number;
    defaultGapDurationMs: number;
    gapMode: 'hold' | 'blank';
    entries: SignageSlideEntry[];
    targetWallIds: string[];
    enabled: boolean;
    createdBy: string;
    collaborators: Array<{
        email: string;
        role: 'viewer' | 'editor';
    }>;
    deletedAt?: number | null;
    createdAt: number;
    updatedAt: number;
}
```

Slideshow entries do not persist `stageId`.

For a given entry, the server:

1. Loads the project.
2. Finds its unique active stage whose complete layout matches the slideshow layout.
3. Loads that stage's latest published commit.
4. Finds the referenced `slideId`.
5. Skips the entry with a visible validation reason if any step fails.

`projectId` remains necessary even if slide IDs are UUIDs. It provides an efficient ownership and
authorization boundary and avoids searching commits across all projects.

### Wall

Walls retain their current runtime binding fields for status and asset authorization:

- `boundProjectId`
- `boundCommitId`
- `boundSlideId`
- `boundSource`

These fields describe what is currently displayed. They are not slideshow configuration.

A wall may additionally contain an optional administrator-configured template:

```ts
interface WallLayoutTemplate extends StageLayout {
    configuredAt: number;
    configuredBy: string;
}
```

The template is an authoring convenience and compatibility hint. It is not a foreign-key
relationship to stages or slideshows.

## Collection Versioning and Migration

Expected application collection changes:

- Projects: version 1 to version 2.
- Commits: version 2 to version 3.
- Walls: version 1 to version 2 for the additive `signage` binding source and optional configured
  template.
- Signage slideshows: new version 1 collection.

No document migration is required for:

- Assets: ownership remains project-scoped.
- YDocs: scope identity does not change.
- Devices: screen observations are runtime peer data in the MVP.
- Audits: new stage/signage actions and resource types are additive values.

Better Auth users are not managed by `BaseCollection`. `canManageSignage` is optional and missing
values are treated as `false`; existing users do not require an application collection migration.

### Project migration

For every legacy project:

1. Create a deterministic embedded stage with `id: "main"` and name `Main`.
2. Set its layout to `{ columns: 16, rows: 4, screenWidth: 1920, screenHeight: 1080 }`.
3. Move the old project `headCommitId` into the stage.
4. Move the old project `publishedCommitId` into the stage.
5. Set `defaultStageId` to `"main"`.
6. Remove the root `headCommitId` and `publishedCommitId` fields.

The existing lazy migration writer only performs `$set`, so it cannot physically remove legacy
fields. This migration therefore requires a targeted backfill using `$unset`, or an extension to
the collection migration mechanism that explicitly supports removed fields.

The TypeScript model, queries, and application code must stop exposing or using the root pointers
in the same delivery. There is no compatibility-alias phase.

### Commit migration

Every legacy commit receives:

```ts
stageId: 'main';
```

This migration is deterministic and per-document.

### Wall migration

Legacy walls retain their current runtime binding fields. The migration:

- Leaves any existing `live` or `gallery` source unchanged.
- Does not invent a configured layout template.
- Allows future writes to use the additive `signage` source.

An absent configured template means “not configured,” not the legacy 16×4 default. Live
observations and administrator input determine whether a template is later saved.

### Migrate-on-use mechanics

The design fits the repository's migrate-on-use model, but only if the following collection-layer
changes are made.

#### 1. Removed fields must be unset atomically

`BaseCollection.fromDB()` currently writes migrated documents using `$set` only. Omitting
`headCommitId` and `publishedCommitId` from the migrated JavaScript object therefore does not
remove them from MongoDB.

The migration writeback must support `$unset` and perform one guarded update containing:

```ts
{
    $set: {
        defaultStageId: "main",
        stages: [migratedMainStage],
        _version: 2
    },
    $unset: {
        headCommitId: "",
        publishedCommitId: ""
    }
}
```

The existing version guard must remain so an older migration writeback cannot overwrite a newer
concurrent update.

This can be implemented as a small migration-result extension or a collection-specific migration
writeback hook. A separate bulk migration is not required unless deployment policy requires every
unread database document to be physically rewritten immediately.

On first application read, the returned public project shape is stage-only even if the asynchronous
MongoDB writeback has not completed yet.

#### 2. New queries must still discover legacy documents

A migration only runs after MongoDB returns a document. A query that filters exclusively on a new
field cannot discover a legacy document missing that field.

During the migrate-on-use period:

- Gallery/public project discovery must not filter only on `stages` or `defaultStageId`.
- Main-stage commit history must include both `stageId: "main"` and legacy commits where
  `stageId` is absent.
- Raw projection helpers that bypass `fromDB()`, including the current published-commit reference
  query, must be replaced with stage-aware helpers that pass results through migration.
- Project operations must load the project through `ProjectsCollection` before inspecting stage
  pointers.

These are collection-internal migration predicates, not public compatibility aliases. Application
models and server/UI code only receive the new stage-aware shape.

Suitable transitional query behavior is:

```ts
// Legacy commits can only belong to the migrated Main stage.
stageId === 'main'
    ? { projectId, $or: [{ stageId: 'main' }, { stageId: { $exists: false } }] }
    : { projectId, stageId };
```

Gallery discovery may query the broader set of public, non-deleted projects and filter their
already-migrated public shapes, or use a legacy-inclusive MongoDB predicate before applying
`fromDB()`.

#### 3. Nested commit pointers require raw/public conversion

Stage `headCommitId` and `publishedCommitId` values are nested foreign keys. The Projects
collection must:

- Store them as MongoDB `ObjectId` values, matching the existing root-pointer representation.
- Expose them as strings to application code.
- Convert them in stage insert/update setters.
- Stamp `_version` in every custom stage pointer update.

#### 4. Lazy migration is not immediate database-wide rewriting

Migrate-on-use guarantees that documents are upgraded when selected through the collection layer.
Unread documents can remain in their legacy raw shape indefinitely.

If “remove the root pointers immediately” means no application code may expose or depend on them,
the migrate-on-use plan satisfies it.

If it means no legacy field may remain anywhere in MongoDB after deployment, a one-off bulk
backfill is additionally required. This is an operational choice, not a data-model difference.

### Migration-sensitive query targets

The following current behaviors must be replaced or updated in the same delivery:

- Project creation and update payloads.
- Project default Editor redirects.
- Project Edit button resolution.
- Mutable HEAD creation.
- Manual save fallback to a project HEAD.
- Branch creation, listing, and promotion.
- Stage commit/history listing.
- Stage publish and unpublish.
- Published-project and Gallery-state discovery.
- Gallery project cards and binding.
- Public asset authorization for Gallery-visible projects.
- Commit viewer mutable-HEAD checks.
- Project published summaries and badges.
- Custom-render project publication compatibility.
- Repository test seeds.

No code path may read a project root commit pointer after this migration.

### Seed and test data

All repository seed fixtures must be upgraded to stage-aware projects and commits. Tests must not
continue seeding removed root project pointers.

## Stage Rules

### One active stage per layout

Two non-archived stages in one project cannot share the same:

```text
(columns, rows, screenWidth, screenHeight)
```

Archived stages do not participate in the uniqueness constraint.

The server must enforce this invariant on creation and layout updates. Client filtering alone is
not sufficient.

### Mutable layouts

Stage layouts are freely mutable.

On update:

- Reject invalid or non-positive dimensions.
- Reject a layout already used by another active stage in the project.
- Do not scale or delete layers.
- Do not rewrite commit history.
- Do not automatically unpublish the stage.
- Re-evaluate slideshow-entry validity from the stage's new current layout.

Historical commits render using the stage's current layout. Reproducible historical dimensions are
explicitly not an MVP requirement.

Layers that fall outside a reduced canvas remain stored. An Editor warning is desirable but may be
deferred if it materially expands the initial implementation.

### Stage lifecycle

The stage-aware equivalents of the current operations are:

- `ensureMutableHead(projectId, stageId)`
- create branch inside a stage
- promote branch inside a stage
- publish commit for a stage
- unpublish a stage
- list commits for a stage
- archive a stage

All server operations must validate that project, stage, commit, and slide belong to the same
requested context.

The following lifecycle invariants also apply:

- A project must always have at least one active stage.
- `defaultStageId` must reference an active stage.
- The default stage cannot be archived until another active stage becomes the default.
- A published stage must be unpublished before it can be archived.
- Archived stages remain available for historical commit resolution but not editing, importing, or
  slideshow layout matching.
- A project with a missing legacy HEAD migrates with `main.headCommitId: null`; stage-aware
  `ensureMutableHead()` creates it on demand.

## Route and Editor Resolution

The canonical Editor URL remains:

```text
/quarry/editor/:projectId/:commitId/:slideId
```

It does not add `stageId`.

The loader:

1. Loads `commitId`.
2. Verifies `commit.projectId` matches the route project.
3. Resolves the owning stage from `commit.stageId`.
4. Verifies that stage still belongs to the project.
5. Loads the stage layout into the Editor store.

Project-only Editor navigation:

1. Resolves `project.defaultStageId`.
2. Ensures that stage has a mutable HEAD.
3. Redirects to the existing project/commit/slide URL.

The realtime scope and Yjs identity remain unchanged because `commitId` already separates the
stage commit trees:

```text
scope = (projectId, commitId, slideId)
ydoc  = (projectId, commitId, slideId, layerId)
```

The Editor store gains the resolved stage ID and layout. Columns, rows, screen width, and screen
height replace global geometry assumptions in the Editor, viewer, controller preview, backgrounds,
and wall renderer.

## Project and Stage UI

The current **Commits** project tab becomes **Stages**.

The current **History** tab remains the audit log.

The Stages area provides:

- Stage list and active/default indication.
- Create stage from custom values.
- Create stage from a wall template.
- Edit stage name and layout.
- Open stage in Editor.
- Stage-specific commit tree and branches.
- Stage-specific publish and unpublish.
- Archive stage.
- Set the single Default / Present to Gallery stage.

Remove global project publication controls and binary project-level Published status. Suitable
project summaries include:

- Number of published stages.
- Whether the default Gallery stage is published.
- Validation warnings for missing default stage or invalid pointers.

## Publishing and Gallery

Each stage owns its published commit.

Gallery presents `project.defaultStageId` and its latest published commit. If the default stage is
not published, the project is unavailable to Gallery.

Gallery does not choose a stage from wall dimensions in the MVP.

Project visibility and stage publication have separate purposes:

- Stage publication determines whether the stage is eligible for signage and presentation.
- Project `visibility` determines whether the project is publicly visible in Gallery.
- Publishing a stage selects its stable presentation revision; it does not make a private project
  public.
- A signage manager may browse or import only projects they already have permission to view.
- A wall may receive a private project's assets only while it is authorized for the project
  currently bound by the server.

When wall observations or a configured wall template are available, Gallery may show a warning if
the default stage layout differs from the selected wall layout. The mismatch does not block
presentation.

Changing the Default / Present to Gallery control changes `project.defaultStageId`. This also
changes the stage opened by project-level default Edit navigation in the MVP.

## Explicit Slideshow Queue

The persisted queue contains only explicit slide references.

### Add one slide

The configuration UI:

1. Filters projects to those with one active stage matching the slideshow layout.
2. Reads that stage's latest published commit.
3. Presents its published slides.
4. Adds the selected `{ projectId, slideId }` reference.

### Add a whole project

The configuration UI:

1. Resolves the project's unique matching-layout stage.
2. Reads its latest published commit.
3. Expands the ordered slides.
4. Inserts one explicit entry per slide.

This is an import operation, not a persistent dynamic project entry.

Consequences:

- Republishing a retained slide ID updates its displayed layers.
- Newly published slides are not inserted automatically.
- Deleted slide IDs become invalid and are skipped.
- Project slide reordering does not silently reorder the signage queue.
- Operators can rearrange or remove imported slides individually.

Users may re-import a project when they want to refresh its slides. A smarter grouped
**Refresh project slides** operation may be reviewed later; it does not require an MVP persistence
model now.

## Slideshow Timing

The server runs one authoritative timeline per enabled slideshow.

Each expanded slide has:

- A display duration from the entry override or slideshow default.
- A gap duration from the entry override or slideshow default.
- A gap mode of `hold` or `blank`.

`blank` means a black frame in the MVP. It preserves signage ownership and target assignment and
must not invoke generic wall unbinding.

The runner maintains:

- Current queue index.
- Current phase (`display` or `gap`).
- Phase start and end server timestamps.
- A generation number invalidating stale timers after configuration changes.

All target walls normally follow the same slideshow cursor and phase.

When every entry is invalid, the runner must stop rapid advancement, expose an error state, and
wait for configuration/publication changes or a bounded retry.

After server restart, each enabled slideshow begins at its first valid entry.

## Slideshow Targeting and Binding Authority

`targetWallIds` is stored on the slideshow.

Invariants:

- A slideshow may target multiple walls.
- A wall may belong to at most one enabled slideshow.
- Only an admin or operator can edit targets or enable/disable a slideshow.
- Target conflicts must be rejected by the server.

Persistent targeting and current runtime binding are separate:

```text
Slideshow target = desired server-owned behavior
Wall binding     = content currently displayed
Editor lease     = temporary suppression of signage for one wall
```

### Runtime policy

- The server drives signage output.
- Gallery cannot bind or unbind a signage-targeted wall.
- Controller cannot replace signage content on a signage-targeted wall.
- Gallery disconnection does not affect the wall binding.
- An Editor may live-bind a signage-targeted wall.
- While an Editor lease is active, the signage runner sends nothing to that wall.
- The slideshow timeline continues for other walls and continues advancing server-side.
- When the last relevant Editor disconnects or releases the wall, that wall immediately joins the
  slideshow's current phase.
- Removing the target or disabling the slideshow is the authoritative way to stop signage.

The current generic bind and unbind handlers require centralized policy checks so callers cannot
bypass these rules.

Use an explicit `signage` binding source in runtime state and persisted wall status. Do not reuse
the `gallery` source.

## Wall Observations and Templates

Wall clients currently advertise column and row. The handshake may be extended with optional:

```ts
interface WallScreenObservation {
    col: number;
    row: number;
    viewportWidth: number;
    viewportHeight: number;
    screenWidth?: number;
    screenHeight?: number;
    devicePixelRatio?: number;
}
```

The server/admin UI can derive:

- Observed row and column bounds.
- Missing coordinates.
- Multiple clients claiming one coordinate.
- Viewport-size and aspect-ratio consistency.
- A preview of the observed arrangement.

Observations do not automatically mutate wall templates, stages, or slideshows.

An admin may explicitly save/adopt an observed arrangement as a wall template, then use that
template to prefill stage or slideshow creation. The copied stage/slideshow layout remains
independent of later wall-template changes.

## Wall Layout Delivery

Making the wall aware of the stage layout is required, not an optional signage enhancement.
Without it, a stage using anything other than the legacy 1920×1080 logical screen size would
still be positioned and culled as 1920×1080 by the wall.

Extend the existing wall hydrate payload with additive metadata:

```ts
interface WallHydrateLayout {
    layout: StageLayout;
}
```

The server resolves this layout from the stage that owns the bound commit. This works for Editor,
Gallery, and signage bindings without adding stage identity to the URL or realtime scope. A wall
continues to identify itself by grid coordinate `(col, row)`; after hydration it derives its
logical viewport from that coordinate and the supplied layout.

This change does not alter layer-operation opcodes, Editor commands, Yjs document identity,
idempotency keys, or the `(projectId, commitId, slideId)` scope. It is an additive field on the
existing server-to-wall hydrate message and a presentation-state change in the wall client.

For rolling compatibility, the hydrate field may initially be optional and the wall may fall back
to the legacy `{ columns: 16, rows: 4, screenWidth: 1920, screenHeight: 1080 }` layout when it is
absent. New server paths must always populate it.

Changing the layout of a stage that is currently bound must invalidate any layout-sensitive
hydrate cache and rehydrate affected wall clients. A separate long-lived layout protocol is not
needed for the MVP.

## Logical Pixels and Physical Screens

The MVP supports configurable logical pixels per screen through `screenWidth` and `screenHeight`.
Existing fixed `SCREEN_W` and `SCREEN_H` assumptions must therefore become resolved stage-layout
values where they define canvas geometry, wall viewport origin, culling, backgrounds, or previews.

For wall coordinate `(col, row)`:

```text
logicalViewportX = col × screenWidth
logicalViewportY = row × screenHeight
logicalViewportW = screenWidth
logicalViewportH = screenHeight
```

The wall should best-effort fit that logical screen into its actual browser viewport at one root:

```text
scale = min(browserWidth / screenWidth, browserHeight / screenHeight)
```

The logical root remains `screenWidth × screenHeight`, uses a top-left transform origin, and is
centred inside a black physical viewport. Matching aspect ratios fill the viewport; differing
aspect ratios are uniformly scaled with letterboxing. Do not independently scale layer positions,
sizes, or individual renderers, and do not use non-uniform stretching.

This preserves the application's pixel-positioned layer model and keeps viewport origin and
culling calculations in logical coordinates. Existing installations whose browser viewport
already matches the logical screen receive scale `1`.

This is intentionally best-effort. The MVP must verify the existing DOM, canvas, iframe, video,
and custom-background renderers through the root transform, but does not promise special
calibration for browser zoom, overscan, bezel compensation, mixed-aspect screens, or irregular
physical arrangements.

### Geometry constant audit

Hard-coded sizes must be classified by purpose rather than removed indiscriminately:

- Logical geometry comes from `StageLayout`. This includes Editor and viewer canvas bounds,
  insertion points, layer background bounds, wall origin/culling, and custom background world
  coordinates.
- Legacy defaults remain `16 × 4` at `1920 × 1080` only for migration, initial/fallback state,
  and the isolated background playground.
- Browser-only SSR fallbacks such as preview-overlay viewport dimensions do not define project
  geometry and may remain.
- Editor interaction measurements such as edge-scroll zones are CSS/browser pixels and remain
  independent of stage layout.
- Rendering budgets are allowed to be fixed, but must cap both dimensions and total work rather
  than masquerade as logical geometry.

In particular, the former width-only `MAX_PREVIEW_W` background limit is replaced by an
aspect-preserving raster budget with a maximum edge and maximum pixel count. This prevents
portrait or extreme-aspect stages from allocating an unexpectedly tall canvas. Background
particle count is proportional to panel count with a hard performance ceiling, particle/wave
measurements are converted from logical pixels to raster pixels, wave placement is relative to
the configured row count, and the Editor snap grid preserves the existing per-panel grid density
for arbitrary `screenWidth` and `screenHeight`.

## Authorization

The current Better Auth integration stores and checks one exact role string. Application
middleware does not safely support comma-separated combined roles.

The MVP adds a feature capability following the existing trusted-publisher pattern:

```ts
canManageSignage: boolean;
```

Authorization rules:

- Admin: manage all slideshows, collaborators, targets, and activation.
- Operator: manage all slideshows, collaborators, targets, and activation.
- User with `canManageSignage`: access the signage console and manage slideshows shared with them.
- Ordinary user: no signage-console access.
- Only admin/operator: change `targetWallIds` or `enabled`.

Per-slideshow collaborators determine which configurations a signage-capable user may view or
edit.

A separate `/signage` management surface is preferable to broadening access to the existing
`/admin` area.

Editing an enabled slideshow takes effect on live playback at the next resolution/phase boundary.
This applies to authorized shared signage managers as well as admins and operators. Target-wall
changes and enable/disable remain admin/operator-only.

## Administrator-Configurable Layout Limits

The existing database-backed admin configuration system should provide:

```text
stage.maxColumns = 16
stage.maxRows    = 4
```

These values are defaults when unset and may be changed by an administrator at runtime.

The limits apply to:

- New stage creation.
- Stage layout changes.
- New slideshow creation.
- Slideshow layout changes.
- Wall-template adoption into a new stage or slideshow.

Changing a limit does not rewrite, resize, unpublish, or disable existing stages and slideshows.
Existing layouts above a newly lowered limit are grandfathered, but cannot be changed to another
out-of-limit layout. Raising the limits immediately permits larger new layouts.

The server is authoritative for limit validation. Editor and signage forms should read and display
the current limits, but client validation is only advisory.

Columns, rows, logical screen width, and logical screen height must be positive finite integers.
The configurable 16×4 ceiling applies to columns and rows; it does not replace the per-screen
logical pixel fields.

## Required Runtime Hardening

### Asset authorization ordering

The current binding flow hydrates wall clients before persisting the new `boundProjectId`, while
wall asset authorization reads that persisted project ID. Repeated cross-project signage
transitions can expose this race.

The binding operation must establish the new authorization state before clients begin requesting
the new project's assets.

### Binding serialization

Slideshow changes, editor leases, and target changes must be serialized per wall or guarded by a
generation/token check so a stale asynchronous bind cannot reclaim a wall.

### Active video registry

If signage includes videos, active-video runtime keys must include scope as well as numeric layer
ID. Numeric IDs are not globally unique across projects and commits.

### Single-process constraint

The MVP assumes one application process. Realtime bus maps and slideshow runner state are
process-local. Multi-process scheduling requires distributed coordination and is deferred.

## Validation and Error Feedback

The slideshow management UI must distinguish at least:

- Valid.
- Project missing or archived.
- No active project stage matching the slideshow layout.
- Matching stage is not published.
- Slide no longer exists in the latest published commit.
- Target wall missing.
- Target wall already assigned to another enabled slideshow.
- Wall template or observation differs from slideshow layout.

Invalid entries remain editable and visible. Playback skips them.

Wall-layout mismatch is advisory in the MVP and may be overridden by an admin/operator.

## Data Integrity, Indexes, and Concurrency

At minimum, add or review indexes for:

- Commits by `{ projectId, stageId, createdAt }`.
- Mutable commit heads by `{ projectId, stageId, isMutableHead }`.
- Signage slideshows by creator/collaborator lookup.
- Signage slideshows by `targetWallIds`.
- Enabled/non-deleted signage slideshows.

Service-level invariants:

- Stage IDs are unique inside a project.
- Active full-layout signatures are unique inside a project.
- `defaultStageId` resolves to one active stage.
- Stage HEAD and published commits belong to the same project and stage.
- Slide IDs are unique inside a commit.
- Slideshow entry IDs are unique inside a slideshow, but the same project slide may intentionally
  appear more than once.
- `targetWallIds` contains no duplicates.
- Every target wall exists.
- A wall belongs to at most one enabled slideshow.

The embedded-stage layout uniqueness check and slideshow target assignment must not be implemented
as an unguarded read-then-write sequence. Concurrent server requests could both pass validation.
Use an atomic conditional update, a suitable unique index where MongoDB supports the array shape,
or a transaction.

`_version` is a schema version and must not be treated as an optimistic-concurrency revision.

## Resolution and Invalidation Timing

The runner resolves an entry against the latest project/stage/published-commit state before each
display phase.

Therefore:

- Republishing a retained slide ID affects its next display, not a currently visible phase.
- A stage layout change can invalidate an entry at its next display.
- Deleting or archiving referenced content causes the next resolution to skip it.
- Editing slideshow entries or targets increments the runner generation and cancels stale work.
- A wall that reconnects to an enabled targeted slideshow joins its current server phase.
- A wall that remains offline does not pause the slideshow timeline.

The runner may also consume project/slideshow change notifications to wake early, but correctness
must not depend on receiving an in-process notification.

## Implementation Sequence

1. Add shared `StageLayout` validation and layout-key helpers.
2. Add embedded project stages and `defaultStageId`.
3. Add commit `stageId`.
4. Migrate legacy projects and commits, including explicit removal of root commit pointers.
5. Update seed fixtures and add migration tests.
6. Make all project, commit, branch, publish, Gallery, asset, and Editor loaders stage-aware.
7. Replace the project Commits tab with Stages and move history/publication controls into stages.
8. Add freely mutable stage layout management and uniqueness enforcement.
9. Parameterize Editor, viewer, controller, background, and wall logical geometry with all four
   layout fields.
10. Add stage layout to wall hydration, derive logical wall viewports from it, and rehydrate on
    active layout changes.
11. Add uniform root scaling and letterboxing for logical-to-browser viewport fitting.
12. Add the signage slideshow collection and explicit slide-entry CRUD.
13. Add the separate signage management surface and authorization capability.
14. Add project/slide import filtered by complete layout.
15. Add slideshow-owned wall targeting and conflict validation.
16. Add the server-authoritative slideshow runner.
17. Add editor suppression/resumption and Gallery/Controller policy enforcement.
18. Add invalid-entry status and runner health feedback.
19. Add optional wall observations, preview, and configured templates.
20. Add focused migration, stage, publication, queue, scheduling, reconnect, and authorization
    tests.

## Required Follow-Up Review

The following are intentionally deferred and must be recorded when the MVP is handed off:

1. Split editing default and Gallery presentation into separate stage selectors if one
   `defaultStageId` proves insufficient.
2. Make Gallery select or filter stages using target-wall layout.
3. Define blocking versus warning behavior for Gallery/wall layout mismatch.
4. Add grouped project-import provenance and a first-class **Refresh project slides** operation.
5. Add commit pinning for slideshow entries.
6. Define calibrated overscan, bezel compensation, browser-zoom policy, and irregular or
   mixed-aspect physical wall layouts beyond the MVP's uniform best-effort scaling.
7. Add calendar scheduling, dayparts, transitions, or time-zone behavior.
8. Add custom-render project support.
9. Add distributed/multi-process slideshow coordination.
10. Revisit commit-layout snapshots only if reproducible historical dimensions become a product
    requirement.
11. Decide whether wall clients should report physical viewport width, height, and device pixel
    ratio. The MVP deliberately observes only the existing row/column peer coordinates and lets
    admins configure logical panel dimensions, avoiding another wall-handshake protocol change.
12. Add richer runner telemetry (current entry, phase, next transition, and last bind error) to the
    signage panel if operational feedback beyond per-entry validation is needed.

## Acceptance Summary

The MVP is successful when:

- A migrated project opens as a Main 16×4 stage with 1920×1080 logical screens.
- New projects can add, edit, navigate, version, and publish independent stages.
- No application code relies on project-level commit pointers.
- Commit-based Editor URLs resolve their stage correctly.
- Project assets remain shared across all stages.
- A project cannot have duplicate active full-layout signatures.
- A slideshow can import explicit slides from matching published stages.
- Publishing updated slide content is reflected without rewriting slideshow references.
- Invalid or resized references are skipped and visibly diagnosed.
- Wall hydration supplies the bound stage's complete layout without changing editing scopes.
- A wall computes origin and culling in logical pixels, then uniformly fits one logical screen
  into its browser viewport with black letterboxing when necessary.
- One server timeline drives all target walls with per-slide display and gap timing.
- Editor binding temporarily suppresses, then correctly resumes, signage.
- Gallery and Controller cannot override signage-targeted walls.
- Authorization distinguishes slideshow management from target/activation authority.
