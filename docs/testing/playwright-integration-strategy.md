# Playwright Integration Strategy (6 Concurrent Clients)

This plan targets your real production topology in one test run:

- 2 `editor` clients
- 2 `controller` clients
- 2 `wall` clients

## 1) Test Harness Layout

Use Playwright projects and fixtures to model each client role.

- `project: editor-a`, `editor-b`
- `project: controller-a`, `controller-b`
- `project: wall-a`, `wall-b`

Create a shared fixture that:

1. Seeds a test project/commit in MongoDB.
2. Starts the app once (`bun run --filter=@repo/web start`).
3. Creates six isolated browser contexts (not just pages) to simulate independent sessions.
4. Exposes helpers for role-specific actions (`editLayer`, `bindWall`, `publishCommit`, `assertRenderedState`).

Use `test.describe.configure({ mode: "serial" })` for each multi-client scenario to preserve causality.

## 2) Scenario Buckets

Prioritize scenarios that match your known risk areas:

1. Live editing consistency:

- editor-a updates layer position/content.
- editor-b receives update under expected latency budget.
- both walls converge to same rendered state.

2. Controller binding churn:

- controller-a binds wall-a while editor stream is active.
- controller-b rebinding/unbinding does not desync wall hydration.

3. Save/publish transitions:

- manual save creates immutable snapshot.
- publish/unpublish changes propagate consistently to both controllers and both walls.

4. Asset pipeline under contention:

- simultaneous image and video uploads.
- progress events are emitted.
- assets appear in both editor clients and become renderable on walls.

5. Recovery paths:

- force close one editor and one wall mid-session.
- reconnect and validate rehydration from authoritative scope state.

## 3) Hardness Model (Test Harness Hardening)

Implement hardness in phases so failures are diagnosable:

1. Deterministic phase:

- fixed waits are forbidden.
- all assertions wait on explicit protocol/UI signals.
- strict time budgets per step.

2. Stress phase:

- run each scenario N times (`N=10` initially).
- inject jitter (random 20-300 ms delays) into editor/controller actions.

3. Fault-injection phase:

- random client restarts.
- temporary network throttling/packet loss on selected contexts.
- optional Mongo primary step-down in dedicated chaos workflow.

4. Soak phase:

- 20-30 minute long-running mixed-role scenario.
- fail on memory growth, websocket reconnect storms, or drift in wall render checksums.

## 4) CI Execution Shape

Recommended GitHub Actions split:

- PR gate (fast): deterministic smoke set, 1-2 key 6-client scenarios.
- post-merge/nightly: stress + fault-injection matrix.
- weekly: soak suite with traces/videos retained.

Keep Playwright artifacts (`trace`, `video`, `screenshot`) only on failure for PRs, always-on for nightly chaos runs.

## 5) Data and Isolation

- Use one Mongo database name per run (`vizzy_ci_<run_id>`).
- Prefix project names/ids by run id.
- Cleanup in `afterAll` and with a fallback TTL cleanup job.

## 6) First Implementation Milestone

Start with one critical end-to-end test:

- `multi-client-live-sync.spec.ts`
- six clients connected
- one editor mutation
- both walls and both controllers converge
- includes reconnect of one wall

Once this is stable in CI, expand to save/publish and asset processing scenarios.
