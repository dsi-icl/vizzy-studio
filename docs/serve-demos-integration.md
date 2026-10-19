# Custom demo proxy integration

This branch starts from PR #162. It keeps one project `customPort` and one
`/serve/<projectId>/` upstream contract. PR #163's admin preview is provided
through the same proxy and authorization flow; its slug-to-project environment
mapping and in-memory sessions are not used.

## Browser origin and routing

Set `SERVER_SERVE_ORIGIN` to a dedicated HTTPS sibling host on the same site as
`VITE_BASE_URL` (for example, `studio.example.com` and `demos.example.com`).
This lets SameSite cookies work inside wall and gallery iframes while keeping
the demo on a different browser origin. For local HTTP development, map two
names under one test domain to loopback and set both origins accordingly.
The Vizzy web process receives the demo host and serves only
`/serve/*` on it. The load balancer must preserve `Host`, path, query, and
WebSocket upgrades. Keep the main Vizzy origin at `VITE_BASE_URL`, with host-only
authentication cookies. Do not expose the demos VM directly to browsers after
cutover.

The app issues a 60-second, one-use launch ticket for a bound wall or controller,
or a signed-in admin preview. One-use ticket IDs are stored in MongoDB with a TTL
index. The demo host consumes the ticket, sets an HttpOnly signed cookie, and
redirects to `/serve/<projectId>/s/<routeId>/screen` or `/control`. Wall and
controller cookies last up to two hours and are checked against the live wall
binding on every HTTP request and WebSocket handshake. Preview cookies last at
most 15 minutes. Each browser session has its own route ID and cookie name, so
two tabs do not replace each other's credentials. The signed cookies continue to
validate after a web process restart. A wall reconnect restores its binding from
the wall record, then obtains a new demo launch. Each bind has a random generation
that invalidates cookies issued before an unbind or rebind.
The wall and gallery refresh their bound session cookie every minute with a
small image request under that session path. If it fails, they request a fresh
launch and reload the demo iframe.
Admin previews do not refresh.

The public demo origin cannot serve Vizzy `/api/*`, gallery, or admin routes.
The main origin rejects requests whose `Origin` is the demo origin. The proxy
strips browser cookies and authorization headers before contacting the demo
process and supplies verified `X-Vizzy-Wall-Id`, `X-Vizzy-Surface`, and
`X-Vizzy-Public-Base` headers. Demo processes must not be publicly reachable
without this gateway.

## Demo rebuild contract

Demo builds can be updated for this integration. Their browser-facing asset,
API, navigation, and WebSocket URLs must remain below the current session base
(`/serve/<projectId>/s/<routeId>/`). Use relative URLs from `/screen` or
`/control`, or derive absolute URLs from the verified `X-Vizzy-Public-Base`
header. For example, `./assets/app.js` from `/screen` stays inside the session;
`/assets/app.js` and `/serve/<projectId>/assets/app.js` do not. The gateway strips
the session prefix before forwarding upstream, so a demo process still receives
`/serve/<projectId>/screen`, `/serve/<projectId>/assets/app.js`, and so on.
Check each rebuilt demo in a browser for document, assets, HTTP API, WebSocket,
redirects, and both controller and wall layouts before switching traffic.

## Verification

Run `bun test tooling/testing/serve-merge-smoke.test.ts` for the host boundary,
one-use launch, cookie scope, proxy rewrite, and immediate unbind behavior.
Run `bun test apps/web/src/lib/serveUrls.test.ts apps/web/src/server/serveCookie.test.ts
apps/web/src/lib/serveHeaders.test.ts` for URL, cookie, and header rules.

Deployment still needs a real browser pilot on the rebuilt demos and a restart
test with the actual load balancer, MongoDB, and wall reconnection flow. Neither
the local smoke nor a typecheck proves those deployment properties.
