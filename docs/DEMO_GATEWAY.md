# Demo domain gateway

The browser keeps using the existing demo host and paths, such as
`https://vizzy-studio-demos.dsi.ic.ac.uk/sustainability/control`. The public
entry for that host must reach the **Vizzy VM**. Vizzy checks an HttpOnly
session cookie and proxies each allowed HTTP or WebSocket request to the
**demos VM**. By default it uses Nginx at port 5780. Individual demos can be
routed directly to their process ports after verification. Demo builds and
stored project URLs do not change.

The smallest operational change keeps the existing HTTPS load balancer and
changes only the demo hostname's backend route:

```text
Browser → existing load balancer HTTPS → Vizzy gateway :3670 → demos VM Nginx :5780 → demo
```

The direct-to-Vizzy-VM HTTPS option remains documented below for deployments
that require the demo hostname to bypass the load balancer.

This replaces the earlier `/demos/{projectId}/controller/` path design. That
path design cannot preserve compiled root-relative `/assets`, `/network`,
`/pages`, `/api` and `/bus` requests without adapting demo builds.

## Vizzy VM configuration

Set these server environment variables and deploy the web app:

```env
SERVER_DEMO_GATEWAY_SOURCE_ORIGIN=https://vizzy-studio-demos.dsi.ic.ac.uk
SERVER_DEMO_GATEWAY_UPSTREAM_ORIGIN=http://146.169.9.215:5780
```

The first value is the public demo origin already stored in projects. The
second is the fallback Nginx listener on the demos VM. The gateway never chooses
an upstream from a browser URL. The ingress must preserve the original `Host`
header and support WebSocket upgrades. Requests for the main Vizzy hostname
continue through the normal Vizzy router. Keep `VITE_BASE_URL` set to the main
Vizzy origin.

The gallery and wall request launch URLs for a project currently bound to
their wall. Vizzy uses the stored `customControlUrl` or `customRenderUrl` to
determine the demo slug. The Nginx fallback needs no project ID or port table;
direct process routing uses a separate allowlist of slug-to-port mappings. A stored URL on
another origin continues through the existing external URL behavior.
Administrators can also open **Demo Screen** or **Demo Controller** from the
project detail page without binding a wall. Vizzy checks the signed-in admin
role, issues a one-use ticket, and creates a separate demo preview session.
That session lasts at most 15 minutes, even while active. It has no wall ID or
wall portal token: the demo page and assets can load, but controller actions
that require a bound wall may need the wall to be bound first. A copied demo
URL without the preview browser's cookie still receives `401`.
Compiled requests under that slug and the shared root paths listed in
`apps/web/src/lib/demoGatewayPaths.ts` are accepted. When piloting another
demo, add any extra root paths it needs to that list after checking they belong
to the intended demo.

Example launch and redirect:

```text
GET https://vizzy-studio-demos.dsi.ic.ac.uk/_vizzy/demo-launch/69fb297952b72213cf9f59b8/controller?ticket=...
303 Location: /sustainability/control?l=gallery&w=wall-id
Set-Cookie: __Host-vizzy_demo_session=...; Path=/; HttpOnly; Secure; SameSite=Lax
```

The launch ticket is random, one use, and expires after 60 seconds. The
wall-bound browser session cookie has no fixed age; its server-side session
expires after 12 hours without activity. Neither is a JWT. The ticket is
removed from the visible URL on the redirect. Every page, asset and HTTP API
request checks the session; wall sessions also check their current binding.
WebSocket handshakes do the same; open connections are closed after a binding
or session expires (checked every five seconds). The gateway synthesizes the demo `Referer` used by the current Nginx
`$route_upstream` map. It does not forward the gateway cookie to Nginx.
Wall unbind/rebind and scope cleanup also revoke pending tickets and active
sessions, including when a wall is rebound to the same project.

Sessions and launch tickets are in the Vizzy process memory. A process restart
ends them. Before running multiple Vizzy instances, move this state and the
wall binding state to a shared store, or use routing that keeps all requests
for a session on the same instance. The demo host uses one gateway session
cookie per browser, so two different demos open simultaneously in one browser
can replace each other's session. Demos on this host also share one browser
origin; they are not isolated from each other.

## Local simulation without either VM

From the repository root, run:

```sh
bun tooling/testing/demo-gateway-smoke.ts
```

The script uses an in-memory fake demos Nginx. It checks that a copied
`/bitcoin/` URL is denied without a session, simulates 64 separate screen
browsers redeeming tickets with `c` and `r` coordinates, verifies that their
original page and asset paths are forwarded, and confirms that removing the
wall binding denies subsequent requests while a short admin preview still
opens a demo without a wall. It also checks that sustainability can use a
configured direct process port while bitcoin remains on the Nginx fallback.
It makes no network requests and does not change running VMs. It cannot verify the real load balancer, demo
builds, WebSockets, or 64-device performance; those need a deployed pilot.

## Direct process pilot: sustainability

The optional environment variable below sends only `sustainability` to its
process on port `3002`. Every other demo keeps using the Nginx fallback on
`5780` during the pilot:

```env
SERVER_DEMO_GATEWAY_DIRECT_UPSTREAMS={"sustainability":{"origin":"http://146.169.9.215:3002","assetsFromRoot":true}}
```

The public `/sustainability/control`, `/sustainability/screen`, `/api/...`,
`/pages/...` and `/network/...` paths keep their names when forwarded. Only
`/sustainability/assets/...` becomes `/assets/...` on port `3002`, matching
the observed direct asset response. The browser still uses
`/sustainability/assets/...`. A redirect from the process to its internal IP
is translated back to the public path; this matters because the direct
`/sustainability/control` request was observed to return a `307` redirect to
`http://146.169.9.215:3002/sustainability/control?operator=A`.

The direct origins are configured by the Vizzy operator, never taken from a
project URL or browser request. To replace Nginx for all demos, add and verify
each demo's internal origin and path rules; then the Nginx fallback setting can
be removed. A demo process bound only to `127.0.0.1` on the demos VM is not
reachable from the Vizzy VM without changing the listener or providing
another private transport.

The current sustainability Nginx rules also serve `/pages/` and `/network/`
from files on the demos VM. From the Vizzy VM, the observed direct requests
to port `3002` for `/pages/powering.png` and
`/network/powering-data.json` both returned `200` with the expected content
types, matching port `5780`. The direct control request returned `307`, screen
returned `200`, and `/assets/screen-CBePBy4m.js` returned `200`. This confirms
connectivity and these sampled files, but not the demo's full browser flow.
Its API and WebSocket still need a browser pilot. Other demos have different Nginx `alias`, proxy and
cache rules; a direct port mapping alone does not prove compatibility. Keep
Nginx running as the fallback until each replacement works in a browser.

## Keep the existing load balancer (smallest change)

The demo hostname's DNS and HTTPS certificate stay on the existing load
balancer. Its route for `vizzy-studio-demos.dsi.ic.ac.uk` changes from the
demos VM Nginx (`146.169.9.215:5780`) to the Vizzy VM's existing HTTP app
listener (`146.169.9.69:3670`). The Vizzy gateway then contacts the demos VM
Nginx at `146.169.9.215:5780`. The main Vizzy hostname and other load
balancer routes remain on their existing backends. The load balancer must
preserve the demo `Host` header, original request path, query string, and
WebSocket upgrades. Confirm that it does not cache protected demo responses.
Configure this route's health check as `GET /_vizzy/gateway-health` with the
demo `Host` header and expect `200`. The demo home path `/` requires a session
and returns `401` to an anonymous health check. The health endpoint only
reports that the gateway is configured; it does not prove the demos VM is
reachable.

Do not switch the load balancer route until the new gateway image and the two
`SERVER_DEMO_GATEWAY_*` settings above are running on the Vizzy VM. The
observed Quadlet source is
`/home/ubuntu/.config/containers/systemd/vizzy-studio.container`; copy
[`deploy/demo-gateway/10-gateway.conf`](../deploy/demo-gateway/10-gateway.conf)
to its `vizzy-studio.container.d/` drop-in directory. Local source changes do
not affect the running `ghcr.io/dsi-icl/vizzy-studio:latest` image. The image
workflow publishes only committed source when triggered from the repository;
manual dispatch from a feature branch publishes only `sha-<commit>` and does
not replace `latest`. Pin the Vizzy VM Quadlet to that exact SHA-tagged image
for the pilot, then verify the running image digest or revision before
switching traffic. Keep the direct sustainability mapping commented out for
the first gateway cutover; enable it after the Nginx fallback path passes the
browser checks.

After deploying the gateway, run these checks on the Vizzy VM before asking
the load balancer administrator to switch the route:

```sh
curl -sS -o /dev/null -w 'demo HTTP=%{http_code}\n' \
  -H 'Host: vizzy-studio-demos.dsi.ic.ac.uk' \
  http://127.0.0.1:3670/bitcoin/
curl -sS -o /dev/null -w 'health HTTP=%{http_code}\n' \
  -H 'Host: vizzy-studio-demos.dsi.ic.ac.uk' \
  http://127.0.0.1:3670/_vizzy/gateway-health
curl -sS -o /dev/null -w 'main HTTP=%{http_code}\n' \
  -H 'Host: vizzy.dsi.ic.ac.uk' \
  http://127.0.0.1:3670/
```

Expected: demo `401`, health `200`, main `200`. A demo `200` or the Vizzy home page means
the gateway is not enforcing access yet. At cutover, change only the demo
hostname's backend route and retain the previous backend as a rollback
target. Test a fresh browser's direct demo URL (`401`) and an authorized
controller and screen, including assets, APIs, and WebSockets. Once those
checks pass, restrict demos VM Nginx port `5780` to the Vizzy VM plus
localhost as described below, so the old direct backend cannot bypass the
gateway. No DNS A record change, new Vizzy VM certificate, Caddy service, or
demo rebuild is needed for this option.

## Direct HTTPS on the Vizzy VM (without the shared load balancer)

The Vizzy container currently publishes HTTP on `146.169.9.69:3670` and its
single app process also serves the main Vizzy hostname through the existing
load balancer. Keep that HTTP listener for the main site. Put a small TLS
terminator on the **Vizzy VM** at port 443 for the demo hostname only, using
[`deploy/demo-gateway/Caddyfile`](../deploy/demo-gateway/Caddyfile). Caddy
forwards every path unchanged to the same app process on `127.0.0.1:3670`;
the token checks and demos VM proxy remain in `server.ts`. The main Vizzy
hostname and its load-balancer route do not change.

The Caddyfile expects a valid certificate and private key for
`vizzy-studio-demos.dsi.ic.ac.uk` at
`/etc/vizzy-demo-gateway/fullchain.pem` and
`/etc/vizzy-demo-gateway/privkey.pem`. Provision these before the DNS change,
for example through the institution's certificate process or DNS-based ACME
validation. Keep the private key off Git and out of chat. The `caddy` service
account needs read access to both files. Renew the certificate before expiry
and reload Caddy after replacing either file. This manual-certificate setup
does not obtain or renew certificates itself.

The existing Nitro app can accept TLS certificates directly, but it has only
one listener. Switching that listener to HTTPS would also change the main
Vizzy site's current HTTP upstream. Using Caddy here keeps the single Vizzy
app process and the current main-site route.

### Prepare and verify before changing DNS

1. Deploy an image containing this gateway code to the Vizzy VM. The current
   `ghcr.io/dsi-icl/vizzy-studio:latest` container will not acquire local
   source changes until a new image is built, published, pulled and restarted.
   In the container's Quadlet or environment file set the two
   `SERVER_DEMO_GATEWAY_*` values above. A scoped Quadlet drop-in template is
   provided at [`deploy/demo-gateway/10-gateway.conf`](../deploy/demo-gateway/10-gateway.conf).
   The observed source file on the Vizzy VM is
   `/home/ubuntu/.config/containers/systemd/vizzy-studio.container`, so its
   drop-in directory is
   `/home/ubuntu/.config/containers/systemd/vizzy-studio.container.d/`.
   Create that directory and copy the template there as `10-gateway.conf`.
   Keep `VITE_BASE_URL` on the main Vizzy origin. To confirm the unit source
   without displaying secrets:

    ```sh
    systemctl --user show vizzy-studio.service -p SourcePath -p FragmentPath -p DropInPaths
    ```

    After the new image is available, run `systemctl --user daemon-reload`,
    `podman pull ghcr.io/dsi-icl/vizzy-studio:latest`, and
    `systemctl --user restart vizzy-studio.service`. Verify the running image
    digest before testing; a locally built image tagged `latest` may differ
    from the registry image. Do not use a `:latest` tag as proof that the new
    gateway code is deployed.

2. Before installing TLS, confirm that the new app rejects an anonymous demo
   request and still serves the main Vizzy hostname. Run on the Vizzy VM:

    ```sh
    curl -sS -o /dev/null -w 'demo HTTP=%{http_code}\n' \
      -H 'Host: vizzy-studio-demos.dsi.ic.ac.uk' \
      http://127.0.0.1:3670/bitcoin/
    curl -sS -o /dev/null -w 'main HTTP=%{http_code}\n' \
      -H 'Host: vizzy.dsi.ic.ac.uk' \
      http://127.0.0.1:3670/
    ```

    Expected: demo `401`, main `200`. If the demo request returns the main
    site, the new code or environment has not reached this container.

3. On the Vizzy VM, install Caddy if needed, place the certificate files at
   the paths above, and add the supplied site block to Caddy's configuration.
   Inspect any existing Caddyfile first; do not overwrite other sites. Check
   and reload with:

    ```sh
    sudo caddy validate --config /etc/caddy/Caddyfile
    sudo systemctl reload caddy
    sudo ss -lntp '( sport = :443 )'
    ```

4. From a **client machine on the network where users browse Vizzy**, test
   the new HTTPS route while DNS still points at the old load balancer:

    ```sh
    bash deploy/demo-gateway/preflight.sh
    ```

    The script uses `curl --resolve` to target `146.169.9.69` without changing
    DNS. It verifies the real certificate and expects `401` for an anonymous
    page, asset and API request. A connection timeout means direct port 443
    access must be opened before cutover. A certificate error means the
    certificate is not valid for this hostname; do not use `-k` to accept it.

5. Test an authorized controller and screen in a browser routed to the new
   Vizzy VM entry before moving production DNS. Confirm page assets, HTTP
   APIs and WebSockets all stay on the demo hostname. Then change only the
   demo hostname's DNS A record from the old entrance (`100.64.1.3` in the
   observed client lookup) to `146.169.9.69`. Check split-horizon DNS and any
   AAAA record too. The shared load balancer's old demo route can be removed
   after clients stop resolving the old address; never remove it first.

## Demos VM access after cutover

1. On the demos VM, keep Nginx and all current demo builds, `location` rules,
   upstreams and demo processes. Nginx should still listen on `5780` for the
   Vizzy VM. After the new route works, restrict `5780` to source
   `146.169.9.69` (Vizzy VM) plus localhost. For example, inside the relevant
   Nginx `server { listen 5780; ... }` block:

    ```nginx
    allow 146.169.9.69;
    allow 127.0.0.1;
    allow ::1;
    deny all;
    ```

    Check `sudo nginx -t` before reloading Nginx. Apply the same source rule in
    the cloud firewall if the platform provides one. Restrict direct demo ports
    separately if those ports are reachable from clients in your threat model;
    the Nginx rule only covers `5780`.

2. Do not add the frontend proxy's old source (`146.169.10.38`) to the final
   demos VM allowlist. If it can still access `5780`, the public frontend can
   bypass Vizzy.

## Pilot checks

Use the sustainability project as the first pilot. With a wall bound, open its
controller and screen in Vizzy. The browser should first visit a one-time
`/_vizzy/demo-launch/...` URL, then land on the familiar
`/sustainability/control` or `/sustainability/screen` URL. Check the browser
network panel for 200 responses from `/sustainability/assets/...`, `/network`,
`/pages`, API requests and a successful `/bus` WebSocket. The controller's
`?operator=A` redirect should stay on the demo hostname.

In a fresh private browser with no demo session, opening the same familiar
URL should return 401. From the Vizzy VM, the demos VM Nginx should still
respond at `http://146.169.9.215:5780/sustainability/`. From other locations,
the direct `5780` route should be denied after the access rule is enabled.

This repository contains the gateway, UI launch flow, and a Vizzy VM HTTPS
site template. It does not change running VMs, DNS, the existing load
balancer, the demos VM Nginx, cloud firewall, or demo builds.
