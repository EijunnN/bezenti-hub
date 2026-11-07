# Remote architecture

Each connection joins a client to one environment over HTTP and WebSocket. The
environment owns providers, execution, files, and durable state. Direct access,
Tailscale, and SSH change how the client reaches that server; they do
not introduce another execution model. See
[remote access](../user/remote-access.md) for setup.

## Identity is independent of the route

An environment keeps its ID across server restarts and endpoint changes. Saved
connections are local to a client profile; the server's identity and state are
not. A repository identity can correlate clones across environments, but never
routes work between them. Servers reach each other only through the Hub: Peer
Links, which let one server's agents sign in to another's `/mcp`, were removed
in spec 3 (migration 102 revoked their sessions and tokens).
The canonical key follows the `upstream` remote when one exists, so pull request
features target the repository a fork tracks. A fork also reports its own
`origin`, and clients group and label by that, so a fork never collapses into a
checkout of its upstream.

[Environment ID initialization](../../apps/server/src/environment/ServerEnvironment.ts)
must publish a complete ID atomically. Repair of an empty ID file retains a
recovery file so concurrent or delayed initializers choose the same winner.
Removing that recovery state as ordinary temporary-file cleanup can change the
identity underneath an already-running server.

Advertised endpoints are reachability hints. Only the connecting device can
prove that a route works. In particular, a host's loopback address refers to a
different machine when another device opens it. Endpoint selection must not
silently fall back to loopback when a shareable endpoint is unavailable.

A saved environment holds an ordered list of routes, and the
[driver](../../packages/client-runtime/src/connection/driver.ts) connects over
the first that works. Each direct route is first checked with the public
descriptor, so a saved LAN address that a different machine answers on another
network receives no credential. That check is not proof of a working route:
when every route stays silent, each is still tried. A route that fails to
connect, including a blocked one, moves on to
the next; only an incompatible server stops the walk, because it is the same
server on every route. While connected over a later route the
[supervisor](../../packages/client-runtime/src/connection/supervisor.ts)
preflights the earlier ones and replaces the session when one would connect.
Preflight includes authorization so a route that answers but rejects this
client never costs a working session; a route that still fails afterwards is
held back for a cooldown so a flaky network cannot bounce the connection.

A connected server reports the LAN and tailnet addresses it is bound to, and the
client saves them as learned routes. A learned route reuses the paired bearer token of
the route it was learned over. A paired token only learns a plain HTTP address off the tailnet
when it was itself paired over plain HTTP, so a token paired over HTTPS never
starts travelling unencrypted. Learned routes the server stops reporting are
dropped, which is how a changed LAN address replaces the old one; routes the
user saved are never touched. The reported addresses are hints like any advertised endpoint, so a
learned route still has to answer as this environment before it is used.

A background service with no configured host is what makes this work for
headless machines. It listens on every IPv4 interface and, until the
Installation has an Owner, closes each connection unless both addresses of the
direct peer are loopback, private, or tailnet IPv4. That keeps a fresh VPS's
public address closed, including a cloud VM whose public address is NATed to a
private interface. Once an Owner exists every request needs a User session, so
the filter accepts any peer
([ADR 0003](../adr/0003-public-hub-with-local-accounts.md)). The socket filter
runs before any request, so it reads a synchronous flag
([OwnerPresence](../../apps/server/src/auth/OwnerPresence.ts)) that
EnvironmentAuth sets at startup and when the Owner is created. It is not a
firewall: Tailscale Serve and a local reverse proxy reach the server
over loopback. So the same rule runs again per request on the resolved client
([clientAdmission](../../apps/server/src/auth/clientAdmission.ts)), whatever the
listener, and that check re-reads the directory while the flag is off, so a
failed startup read does not keep a published Hub closed. One listener
per address would miss a DHCP change, and the wildcard keeps the reported
addresses current.

### The client behind a proxy

Every route, WebSocket upgrades included, sees the request as the client made
it: a global middleware
([clientConnection](../../apps/server/src/auth/clientConnection.ts)) replaces
the request's address, scheme and Host with the ones a trusted proxy forwarded
(`T3CODE_TRUSTED_PROXIES`, loopback by default, since Tailscale Serve and a
local Caddy connect from there). Forwarding headers
from any other peer are ignored, and `X-Forwarded-For` is walked from the right
so an address a client writes into it is never chosen. Per-client rules (sign-in
and Invitation back-off, session metadata, the managed policy's remote-client
limit, the plain-HTTP refusal below, `Secure` cookies, the browser-origin check)
read only that resolved request, never the headers. A trusted proxy that forwards
a request without a usable client address (`for=unknown`, an obfuscated name, a
scheme alone) leaves the client unknown, and unknown counts as public, never as
the proxy's loopback. Without a trusted proxy every client behind one shares the
proxy's address and its back-off bucket.

Browser session cookies and access tokens are bearer credentials, so
[EnvironmentAuth](../../apps/server/src/auth/EnvironmentAuth.ts) issues them
(account sign-in, pairing links, token exchange, MCP clients) over plain HTTP
only to loopback, LAN and tailnet clients, keeping `t3 up --lan` pairing. A
public or unknown client needs HTTPS, and with `T3CODE_PUBLIC_URL` set only
loopback may use plain HTTP.

Pull request routing trust covers the whole route list. Adding or changing a route
revokes it; reordering does not, because the same addresses remain trusted.

## The web app is a client

Each Hub serves its own web app (ADR 0007); there is no separately hosted web
client. The web app stores its connection catalog in the browser and connects
directly to each environment. It does not proxy traffic or hold server-side
pairing state, so serving the UI over HTTPS cannot make a plain HTTP LAN backend
accessible from that browser context.

Pairing links open on the endpoint's own `/pair` page and carry the secret in the
fragment. A [pairing URL with a `host` query](../../apps/web/src/hostedPairing.ts)
still pairs the page with another backend. Fragments stay out of requests, the
browser exchanges the secret with the environment and strips it from its
history. Moving the token into a query parameter would disclose it to the wrong
origin.

Links the app hands out (Copy thread, prompt links, MCP thread links for outside
clients) point at the Hub's public URL, `T3CODE_PUBLIC_URL`, which the server
advertises in its environment descriptor; without one, at the address the client
reached the Hub on (`hubLinkOrigin` in `packages/shared/src/threadLinks.ts`).

## Access and process ownership are different

Tailscale supplies an endpoint for ordinary pairing, so it needs no separate
environment type. Authentication remains the environment's responsibility for
every route. See [environment authentication](./environment-auth.md).

SSH can launch a server as well as forward a port. Desktop main owns that
lifecycle because it can spawn SSH and handle authentication prompts. The
renderer uses the forwarded endpoint through the shared connection runtime.
[SSH cleanup](../../packages/ssh/src/tunnel.ts) stops a remote server only if the
launcher owns it; a server it discovered already running must survive a client
disconnect. Reconnection restores the forward before opening the application
transport.

Remote servers can outlive several client releases. Clients must use advertised
capabilities and handle their absence, rather than assume their own version
describes the server. Process replacement belongs to the launcher's
[update protocol](./server-updates.md); the connection runtime handles the
resulting disconnect.

### Desktop without a local environment

Desktop normally launches its own primary server, but the desktop setting `localEnvironmentEnabled`
(`apps/desktop/src/settings/DesktopAppSettings.ts`) turns that off. Changing it relaunches the app;
no local state is deleted. On the next start the main process skips port selection, server exposure,
and the primary and WSL backends, and opens the window right away. The renderer sees this through
`desktopBridge.getLocalEnvironmentEnabled()`: `readPrimaryEnvironmentTarget` returns null, so primary
auth and platform-managed discovery are skipped and only saved environments (pairing, SSH)
connect. This is possible because the desktop renderer is not served by the backend: the `t3code://`
scheme serves the bundled client from disk (Vite in development) and API traffic always goes to the
environment's own URL.
