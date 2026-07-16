# Bus Authentication and Scope Registration

## Why This Document Exists

This document captures:

1. The current `/bus` websocket authentication and registration flow.
2. The decisions we took and why.
3. What is intentionally deferred.
4. A concrete list of remaining TODOs.

Last reviewed: `2026-04-02`.

## Goals

1. Authenticate peer identity at transport level (session/device/portal token).
2. Keep peer authentication separate from editor scope registration.
3. Keep peer metadata stable across scope transitions.
4. Ensure gallery takeover requester identity is server-derived.

## Decision Summary

1. Device-capable peers (`wall`, `controller`, `gallery`) use challenge/proof auth.
2. `hello_challenge` is method-agnostic; server infers accepted proof type.
3. Controllers may authenticate via device signature or portal token (`_viz_t`).
4. Editor authentication uses server session from websocket request headers.
5. Editor `hello` only authenticates/registers transport identity; scope is set via `switch_scope`.
6. `leave_scope` clears editor scope only; it does not unregister the peer.
7. `switch_scope` goes through the shared websocket mutation rate-limit path.
8. `requesterEmail` is not client input anymore; it is derived from `authContext.user.email`.
9. Authorization (project collaborator/admin rights) is deferred to a later sprint; current work is identity/auth context only.

## Auth Context Model

Defined in `apps/web/src/lib/busState.ts`:

```ts
type AuthContext = {
    user?: { email?: string };
    device?: { kind: 'wall' | 'controller' | 'gallery'; wallId?: string };
    portal?: { wallId: string };
};
```

Semantics:

1. `user` is session-derived identity for editor peers.
2. `device` represents validated device-signature identity.
3. `portal` represents validated controller portal-token identity.
4. Multiple subcontexts can coexist on the same peer (for example controller with both signature and token).

## Message Contract (Current)

1. `hello`
    - Editor: `{ type: 'hello', specimen: 'editor' }`
    - Wall/Controller/Gallery: specimen + routing fields + optional `devicePublicKey`
2. `hello_challenge`
    - `{ type: 'hello_challenge', nonce }`
3. `hello_auth`
    - `{ type: 'hello_auth', proof: { signature?, portalToken? } }`
    - At least one proof must be present.
4. `hello_authenticated`
    - Sent after successful authentication.
5. `auth_denied`
    - Current reason: `missing_session`
6. `switch_scope`
    - `{ type: 'switch_scope', projectId, commitId, slideId }`
7. `leave_scope`
    - Clears editor scope; peer remains connected and registered.

## End-to-End Flow

### 1) Client behavior (`apps/web/src/lib/busClient.ts`)

1. On open, `BusClient` sends `hello` based on auth kind.
2. For device-capable peers, it prepares device identity and public key when available.
3. On `hello_challenge`, it signs nonce (if key exists) and/or attaches controller portal token.
4. On `hello_authenticated`, it marks client `ready` and emits `onReady` callbacks.
5. Outbound messages are blocked until authenticated for authenticated peer kinds.

### 2) Server behavior (`apps/web/src/addons/routes/bus.ts`)

1. `handleHello`
    - Editor:
        - resolves session from websocket headers via `auth.api.getSession`
        - if missing session: `auth_denied` + close
        - registers editor peer with `authContext.user.email` and no scope
        - sends `hello_authenticated`
    - Wall/Controller/Gallery:
        - stores pending challenge context
        - emits `hello_challenge`
2. `handleHelloAuth`
    - validates signature when provided
    - validates portal token when provided (controller only)
    - on success: `hello_authenticated` then `completeHelloRegistration`
3. `completeHelloRegistration`
    - registers peer with specimen-specific metadata and resolved `authContext`
    - sends initial hydrate/snapshots as appropriate
4. `handleSwitchScope` (editor only)
    - rate-limited
    - updates/creates editor scope via `registerEditorPeer` + `setEditorScope`
5. `leave_scope`
    - clears scope via `setEditorScope(entry, null)`
    - applies live-wall vacate cleanup when needed

### 3) State lifecycle (`apps/web/src/lib/busState.ts`)

1. Editor peer remains in `allEditors` for connection lifetime.
2. Editor scope indexing exists only while `meta.scope` exists.
3. `setEditorScope` updates indexes and cleanup timers correctly.
4. `resolveScopeId(editor)` returns `meta.scope?.scopeId ?? null`.

## Requester Identity Derivation

`request_bind_wall` override requests still carry `requesterEmail` for gallery UX, but it is now computed server-side:

1. Source of truth: `entry.meta.authContext.user.email`
2. Client no longer sends requester identity in `hello` or `switch_scope`.

## Recompute Hook (Current Behavior)

Bridge:

1. `process.__BUS_RECOMPUTE_AUTH_CONTEXT__({ email?, projectId? })`

Current scope:

1. Iterates editor peers.
2. Re-resolves session email from websocket headers.
3. Updates `authContext.user.email` if changed.
4. Sends `auth_denied` and closes peer if session is missing.

Out of scope:

1. Project authorization revocation checks.
2. Automatic collaborator/admin policy enforcement.

## Server-Side Trigger Point Implemented

Ban/unban flow now triggers recompute on the server path:

1. UI calls `$adminSetUserBanStatus` (`apps/web/src/server/admin.fns.ts`)
2. Server executes `adminSetUserBanStatus` (`apps/web/src/server/admin.ts`)
3. Better Auth `banUser`/`unbanUser` are called with server request headers
4. `adminRecomputeBusAuthContext({ email })` is invoked

## Known Limitations

1. Gallery reboot is still scope-routed (`type: 'reboot'`) and can no-op when gallery is not attached to a relevant scope.
2. Pending hello challenges have no explicit TTL eviction (they are cleared on close/reconnect/consume).
3. Recompute currently targets editors only.

## Unprocessed TODOs

### High Priority

1. Add explicit challenge TTL/expiry for `pendingHelloAuthByPeer` and reject stale proofs.
2. Define and implement authorization enforcement layer (separate from auth context) for editor `switch_scope` and mutating messages.
3. Add server-side trigger hooks for auth-context recompute from permission-changing hotspots beyond ban/unban (for example collaborator updates).

### Medium Priority

1. Decide whether to formalize peer auth state transitions in telemetry/audit events (issued challenge, auth success, auth failure reason).
2. Add automated integration tests for:
    - editor missing session -> `auth_denied`
    - controller signature auth
    - controller portal-token auth
    - switch_scope rate limiting
    - leave_scope preserving peer registration
3. Harden replay resistance assumptions in docs/tests (currently nonce challenge is per pending handshake, not globally tracked).

### Low Priority

1. Revisit gallery reboot routing behavior and decide explicit product behavior for unscoped gallery sessions.
2. Consider future cleanup of process-level bridges (`__BUS_RECOMPUTE_AUTH_CONTEXT__`) if a dedicated event bus/server hook mechanism is introduced.

## REST And ServerFn Device Signature Contract

Current canonical request signature payload for HTTP auth-context derivation (`apps/web/src/server/requestAuthContext.ts`):

1. `METHOD` (uppercased)
2. `PATHNAME`
3. canonical query string (sorted key/value pairs)
4. `TIMESTAMP` (epoch ms)
5. `NONCE`
6. optional `BODY_SHA256` (base64url)

Headers expected:

1. `x-vizzy-device-kind`
2. `x-vizzy-device-public-key`
3. `x-vizzy-device-timestamp`
4. `x-vizzy-device-nonce`
5. `x-vizzy-device-signature`
6. optional `x-vizzy-device-body-sha256`
7. optional `x-vizzy-device-wall-id`

Replay and freshness controls:

1. Nonce cache per public key (TTL)
2. Timestamp skew window enforcement
3. Signature verification against provided public key
4. DB lookup for enrolled device status

Client-side implementation surface:

1. Shared signer: `apps/web/src/lib/requestSigning.ts`
2. Shared fetch wrapper: `apps/web/src/lib/signedFetch.ts`
3. Device identity signing API: `apps/web/src/lib/deviceIdentity.ts` (`signPayload`)

Initial rollout wiring completed:

1. Nitro addon route `/proxy` now derives auth context directly (outside TanStack pipeline).
2. Wall route frameability probe (`/proxy?check=1`) now uses `signedFetch(..., { deviceKind: 'wall' })`.
3. Gallery server function call `$issueControllerPortalToken` now injects signed fetch via server-fn `fetch` option.
