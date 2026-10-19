# Custom demo proxy integration

This branch consolidates PR #162 and PR #163. It uses the project `customPort`,
`customHost`, and `customStripPrefix` settings from #162 and the admin preview
flow from #163. Demos run behind one `/serve/<projectId>/` gateway on a dedicated
browser origin. There is no per-project JSON environment mapping or in-memory
session registry.

## Browser origin and routing

Set `SERVER_SERVE_ORIGIN` to a dedicated HTTPS sibling host on the same site as
`VITE_BASE_URL` (for example, `studio.example.com` and `demos.example.com`).
This lets SameSite cookies work inside wall and gallery iframes while isolating
demo code from Vizzy's browser origin. The load balancer must preserve `Host`,
path, query, and WebSocket upgrades for `/serve/*`. The main Vizzy host remains
at `VITE_BASE_URL` and should use host-only authentication cookies. Demo upstreams
must only be reachable through the gateway.

Set `DEMOS_HOSTS` to the comma-separated allowlist of upstream hosts. Configure
`customHost` on each custom project to one of those hosts and `customPort` to its
port. Set `customStripPrefix` when the demo process expects `/screen` and
`/assets/...` at its own root; otherwise it receives `/serve/<projectId>/screen`
and `/serve/<projectId>/assets/...`.

The app issues a 60-second one-use launch ticket for a bound wall or controller,
or a signed-in admin preview. Ticket IDs are stored in MongoDB with a TTL index.
The demo host consumes the ticket, sets an HttpOnly signed cookie at
`Path=/serve/<projectId>`, and redirects to `/serve/<projectId>/screen` or
`/control`. The cookie holds a bounded map of independent grants, so opening
screen, control, or previews for the same project does not overwrite another
grant. The URL carries a `__vizzySession` query parameter that selects the grant;
this selector is not an authorization token. The browser sends the signed cookie
on every project path. The gateway uses a same-origin Referer for subrequests
that omit the selector. Shared static assets can use any current grant. Ambiguous
API or WebSocket requests must provide the selector.

Wall and controller grants last up to two hours and are checked against the live
wall binding on every HTTP request and WebSocket handshake. Admin previews last
at most 15 minutes. Signed cookies survive a web process restart. A wall
reconnect restores its binding from the wall record and obtains a new launch.
Each bind has a random generation that invalidates grants from an earlier bind.
Wall and gallery clients refresh their grants every minute with a small image
request to `/_keepalive`. If it fails, they obtain a fresh launch and reload the
iframe. Admin previews do not refresh.

The proxy strips browser cookies and authorization headers before contacting the
demo process. It supplies verified `X-Vizzy-Wall-Id`, `X-Vizzy-Surface`, and
`X-Vizzy-Public-Base` headers. It applies a narrow HTML CSP for framing,
objects, and base URLs; it does not block the demo's inline scripts or styles.

## Demo rebuild contract

Build each demo with its browser base path fixed to `/serve/<projectId>/`. For
example, Vite's `base` can be `/serve/<projectId>/`. Asset tags and project-root
API calls under that path then work without a runtime path segment. The browser
URL for entry pages includes `__vizzySession`, which the demo may copy into
WebSocket URLs or fetch URLs that do not inherit the document Referer. For
example, read it from `location.search` and append it as a query parameter to
`/serve/<projectId>/bus`. The gateway removes that internal parameter before
forwarding requests upstream.

Check each rebuilt demo in a browser for document, assets, HTTP API, WebSocket,
redirects, and both controller and wall layouts before switching traffic.

## Verification

Run `bun test tooling/testing/serve-merge-smoke.test.ts` for the host boundary,
one-use launch, cookie scope, proxy rewrite, and immediate unbind behavior.
Run `bun test apps/web/src/lib/serveUrls.test.ts apps/web/src/server/serveCookie.test.ts
apps/web/src/lib/serveHeaders.test.ts` for URL, cookie, and header rules.

Deployment still needs a real browser pilot on rebuilt demos and a restart test
with the actual load balancer, MongoDB, and wall reconnection flow. Local tests
and typechecks do not prove those deployment properties.
