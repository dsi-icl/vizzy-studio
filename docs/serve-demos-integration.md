# Custom demo proxy integration

This branch consolidates PR #162 and PR #163. It keeps #162's project
`customPort`, `customHost`, `customStripPrefix`, and `/serve/<projectId>/` proxy,
and brings in #163's admin previews and launch flow. No second browser hostname
or per-project JSON environment mapping is required.

## Routing and access

Use the same public FQDN in `VITE_BASE_URL` for Vizzy and custom demos. Route
`/serve/*` to the Vizzy app on that host, preserving path, query, `Host`, and
WebSocket upgrades. Production requires HTTPS. For local browser testing, use
`http://localhost` for `VITE_BASE_URL`; Chromium accepted the Secure demo cookie
there but rejected it on `http://127.0.0.1`.

Set `DEMOS_HOSTS` to the comma-separated allowlist of upstream hosts. Configure
`customHost` on each custom project to one of those hosts and `customPort` to its
port. Set `customStripPrefix` when the demo process expects `/screen` and
`/assets/...` at its own root; otherwise it receives `/serve/<projectId>/screen`
and `/serve/<projectId>/assets/...`. Demo upstreams should only be reachable
through the gateway.

The app issues a 60-second one-use launch ticket for a bound wall or controller,
or a signed-in admin preview. Ticket IDs are stored in MongoDB with a TTL index.
Vizzy consumes the ticket, sets an HttpOnly, Secure, SameSite=None signed cookie
for that launch at `Path=/serve/<projectId>`, and redirects to `/screen` or
`/control` below that path. Each launch uses a distinct cookie name, so
simultaneous screen and controller launches for one project cannot overwrite
each other's grants. `__vizzySession` in the entry URL selects a grant; its
cookie is still required. The gateway removes the selector before forwarding a
request upstream. Existing signed cookies containing several grants remain
readable during the transition.

Wall and controller grants last up to two hours and are checked against the live
wall binding on each HTTP request and WebSocket handshake. Admin previews last
at most 15 minutes. Signed cookies survive a web process restart. A wall
reconnect restores its binding from the wall record and obtains a new launch.
Each bind has a random generation that invalidates grants from an earlier bind.
The Gallery waits for the server's matching wall-binding event before requesting
a custom controller launch, so it cannot launch against the binding being replaced.
Wall and gallery clients refresh grants every minute with `/_keepalive`; a
failed refresh starts a new launch.

### Public demo paths

Every custom project has a public namespace at `/serve/<projectId>/public`.
Requests to that path and its descendants do not require a Vizzy launch ticket,
`__vizzySession`, or serve cookie. There is no project setting or gateway route
allowlist for this namespace. Vizzy still requires a configured custom project,
an allowed upstream host, and an allowed request origin. It strips browser
cookies and authorization headers before forwarding and marks the request with
`X-Vizzy-Surface: public` and `X-Vizzy-Public-Base: /serve/<projectId>/public`.

Vizzy preserves `/public` when forwarding the request. A demo must implement
its own `/public/...` routes; this namespace never aliases the private
`/control` or `/screen` routes. A public mini controller must generate its QR
URL inside this namespace and load its assets, API requests, and WebSocket
connection through the same namespace. Vizzy does not validate a demo's invitation token or
authorize its control messages. Public WebSocket connections do not receive a
Vizzy serve grant, so the demo must enforce its own permissions and expiry.
Public redirects remain below `/serve/<projectId>/public`.

## Same-host script isolation

Vizzy keeps the wall and custom controller iframes in an opaque origin with
`sandbox="allow-scripts allow-forms allow-same-site-none-cookies"`. Every proxied
response also carries the same CSP `sandbox` policy, which protects direct admin
preview tabs and other document types. Chromium's extra token keeps the demo
cookie available when third-party cookies are blocked; browsers that do not
support the token ignore it. Browser cookie blocking policies still require a
deployment pilot. Demo scripts cannot read Vizzy's `localStorage`, including
`vizzy.device.identity.v1`, or access the parent document. Do not add
`allow-same-origin` to either sandbox.

For a demo that places another HTML page inside its screen iframe, copy the
`__vizzySession` selector into that inner iframe's URL. The gateway keeps the
CSP sandbox on the inner page but omits `frame-ancestors 'self'` for a
session-bound `.html` iframe request. Its parent has an opaque origin, so
`'self'` would otherwise block the nested page. Entry pages, direct document
loads, and non-HTML responses keep the framing restriction.

An opaque document's asset, fetch, and WebSocket requests appear cross-site to
the browser despite sharing Vizzy's FQDN. The path-scoped demo cookie therefore
uses `SameSite=None; Secure`. Vizzy's main auth cookies stay separate; the proxy
strips all browser cookies and authorization headers before contacting the demo
process. Private `/serve/*` paths accept `Origin: null` only with a valid signed
demo grant. Dynamic private opaque-origin requests must also carry the entry page's
`__vizzySession` selector. The gateway allows credentialed `Origin: null` CORS
for those requests, static `/assets/` or `/_next/static/` subresources, and
requests below a project's `/public` namespace. Requests to Vizzy's `/api/*`
remain outside that CORS policy.

## Demo rebuild contract

Build each demo with its browser base path fixed to `/serve/<projectId>/`; for
example, use that value for Vite's `base`. Static asset tags can use that path
directly, but module scripts, module preloads, and stylesheets need
`crossorigin="use-credentials"` on their generated HTML tags. Vite emits
`crossorigin` without that value by default, which omits the demo cookie from
opaque-origin requests and makes protected assets return 403. Fonts requested
by CSS also omit cookies; bundle them inline (for example, as data URLs) rather
than as separate protected files. For dynamic HTTP API calls, copy
`__vizzySession` from the entry URL
into the URL and set `credentials: 'include'`:

```js
const session = new URL(location.href).searchParams.get('__vizzySession');
const url = new URL(`/serve/${projectId}/api/state`, location.href);
url.searchParams.set('__vizzySession', session);
const response = await fetch(url, { credentials: 'include' });
```

WebSocket URLs also need the selector. HTML forms need it in their action URL.
The gateway accepts JSON request preflights with `Content-Type`; custom request
headers are not passed to the upstream demo. Root-relative calls to Vizzy's
`/api/*` are not part of the demo proxy and will fail from the opaque origin.

Check each rebuilt demo in a browser for document, assets, HTTP API, WebSocket,
redirects, controller, wall, and admin preview before switching traffic. The
proxy's CSP permits inline demo scripts and styles while sandboxing documents.

## Verification

Run `bun test tooling/testing/serve-merge-smoke.test.ts
apps/web/src/server/serveCookie.test.ts apps/web/src/lib/galleryBindAck.test.ts
apps/web/tests/unit/iframeSandbox.test.ts`.
Deployment still needs a pilot with rebuilt demos and a restart test with the
actual load balancer, MongoDB, and wall reconnection flow.
