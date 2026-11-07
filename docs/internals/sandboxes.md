# Sandboxes

A Space's Sandbox (ADR 0004) is a joined T3 server the Hub runs for that Space. It is an
Environment like any joined machine, `kind = 'sandbox'` with the Space's `space_id` and no owner,
so remote execution, checkpoints, the Hub repository, moves and disconnections apply unchanged. Its
lifecycle is a row in `sandboxes` (migration 100).

## Identity and credential

A Space has one Sandbox id for its whole life, `sandbox:<spaceId>`
(`sandboxEnvironmentIdOf`). With a runtime on, the Environments list shows it, `stopped`, for every
Space the viewer may run Threads in before it exists, so the composer can offer it; choosing it in
`chooseForThread` makes it ([Sandboxes](../../apps/server/src/sandboxes/Sandboxes.ts)). The Hub
issues the credential itself, with no approval: the Sandbox keeps it in its home, the Hub only its
hash, as for `t3 join`. A home lost while the row stays gets a new credential on its next start.

What the credential reaches is decided by the Space, never by a User:

- `environment.use` on a Sandbox needs the Thread's Space to be the Sandbox's (`workSpaceId` in
  [AccessPolicy](../../apps/server/src/auth/AccessPolicy.ts)), so placement, moves and forwarded
  workspace calls never put another Space's Thread on it, whoever asks. Callers that place or
  forward pass the Thread, or the Space a new one is claimed in (`ThreadLaunchService` claims it
  before placing, as `thread.create` will).
- The executor refuses to open a session or start a turn on a Sandbox for a Thread whose Space is no
  longer the Sandbox's (`SandboxSpaceMismatchError`), until moving such Threads exists.
- The [git route](../../apps/server/src/environments/gitRoute.ts) serves a Sandbox only the
  repositories of its own Space: a Project's, or a Thread's own repository by the Thread's Space.
- A Sandbox never `leave`s, and is not renamed or removed as a machine. Archiving its Organization
  stops it and nothing starts it meanwhile; deleting the Organization revokes the credential and
  removes its row and home.

A runtime must never let one Sandbox see another's home: each credential lives in its own home
only, so a container gets its own volume and nothing else of the Hub's (the Podman runtime).

## Runtime

Only implementations of [SandboxRuntime](../../apps/server/src/sandboxes/SandboxRuntime.ts) touch
processes or containers. Without one that runs Sandboxes the Hub offers none and placement refuses
them (`sandbox-unavailable`).

The [process runtime](../../apps/server/src/sandboxes/ProcessSandboxRuntime.ts) is for tests and
development only, on with `T3CODE_SANDBOX_RUNTIME=process`: it isolates nothing from the Hub's user,
so every Sandbox could read the others' credentials. It runs `t3 serve --base-dir
<Hub home>-sandboxes/<id>`, beside the Hub's home rather than in it, as a child of the Hub with the
environment stripped to `PATH`, locale and temp dirs, `HOME` the Sandbox's home, and a start token;
a dev Hub passes its `--dev-url`, so its Sandboxes have the Replay provider. The Hub address it
gives is always loopback; a Hub bound only to another address runs no Sandbox. Its children end
with the Hub; one left by a Hub that crashed is found by the pid file beside its home and stopped,
once its command line and start token prove it is that server, before another starts on the home.

A Sandbox counts as started once its socket is ready: `markReady` on the attached socket (not a
replaced one) after the welcome, the recorded hello and the executor's registration, so a Thread
placed right after finds its providers and executor. A server that ends first fails the start at
once with its exit code.

## Previews through the Hub

A dev server started in a Thread's terminal or by its agent listens on its machine's loopback,
which nobody else reaches: a Sandbox's container, a dedicated machine, a laptop behind NAT. The Hub
serves it at an address of its own, `/preview/<token>/`, and relays each request to that port over
the Environment channel ([HubPreviews](../../apps/server/src/preview/HubPreviews.ts),
[the route](../../apps/server/src/preview/hubPreviewRoute.ts)). It works the same for a Sandbox and
any joined machine.

- **Never the Hub itself:** a Thread on the Hub machine gets no address (its loopback is the Hub's),
  nor does any port the Hub answers on: its configured port, the port its HTTP server listens on,
  the dev web server's. With the process runtime (`T3CODE_SANDBOX_RUNTIME=process`, whose Sandboxes
  share the Hub's loopback) neither does any port the Hub process listens on (read from `/proc`).
  The dev server sees `Host: localhost:<port>` and `Origin: http://localhost:<port>`, never the
  Hub's own credentials.
- **Asking:** `preview.proxyUrl { threadId, port }` (the client's «Open preview» in the Thread
  details, Preview section) answers `{ path, url?, expiresAt }`. It follows the rule of the other
  preview RPCs (`work`: the Thread's own User) and `environment.use`, and binds the address to the
  session's User (a principal without one acts as the Owner, as everywhere in spec 1), that session,
  the Thread, its Active environment and the port. Asked again it gives the same address while that
  lasts. `url` is absolute only with `T3CODE_PUBLIC_URL`; the client otherwise puts `path` on the
  Hub address it is connected to.
- **The address alone opens nothing.** Every request must carry the User's Hub session or the
  address's preview cookie. A browser opening the page (`Sec-Fetch-Mode: navigate`,
  `Sec-Fetch-Dest: document`) must carry the Hub session, which top-level navigations always send;
  the answer then sets `t3_preview` (HttpOnly, Secure, SameSite=None, `Path=/preview/<token>/`,
  bound to the address, its User and session), which the page's own requests and WebSockets carry
  from its opaque origin. A leaked link fetched without either answers 401; another User's Hub
  session, 404.
- **Every request checks again:** the session is still live, the User still works the Thread
  (`SpaceVisibility.claimWork`: a Member of another Space, or another Member of the same Space, is
  refused), the Thread is still on that Environment (read on every request: a move ends the address
  at once) and the User may still use it. The rest is answered from the last 2 seconds unless a
  Space or Membership changed. A live WebSocket is checked again on each access change and every
  30 seconds, and closes once the check fails or its session ends. A refusal is a 404 like an
  unknown address. A machine away answers 503 «Environment offline: <name> is not connected.»; a
  port with nothing listening, 502; a dev server that does not answer in time, 504; a machine whose
  T3 predates these operations, 502 asking to update it (executor contract 8, which machines now
  report in their hello).
- **Addresses:** in memory, so a Hub restart ends them all (the client asks again). One expires
  after an hour unused; a User keeps at most 32, and past that their least recently used goes,
  never another User's. A session that ends takes its addresses with it.
- **Origin:** a path on the Hub's own origin would let the page's scripts call the Hub's API with
  the User's cookies. The Hub serves every response with `Content-Security-Policy: sandbox …`
  without `allow-same-origin`, so the page runs in an opaque origin: it cannot read or use the
  Hub's cookies, storage or API. Nothing the dev server answers sets or clears state on the Hub's
  origin (`Set-Cookie`, `Clear-Site-Data`, `Strict-Transport-Security` are dropped). Never sent on:
  `Cookie`, `Authorization`, `Proxy-Authorization`, `Expect` and every client address header
  (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `CF-Connecting-IP`, `True-Client-IP`, …).
  `CONNECT`, `TRACE` and `TRACK` answer 501. `Referrer-Policy: no-referrer` keeps the token out of
  other sites' logs. Redirects to the dev server itself stay under the address.
- **Trade-off:** the sandboxed page has no cookies or `localStorage` of its own; root-absolute URLs
  (`/src/main.ts`) leave the address, so a dev server must use relative URLs or a base path (`vite
  --base /preview/<token>/`); and requests the page makes in CORS mode with default credentials
  (`fetch()`, module scripts) send no cookie from an opaque origin, so they are refused. Classic
  subresources (`<script src>`, `<img>`, `<link>`), forms and WebSockets work. The preview cookie
  needs a secure context (HTTPS, or `localhost`). A wildcard subdomain per preview
  (`<token>.preview.<host>`) would lift all of this; it needs wildcard DNS and TLS on the public URL,
  so it is left for later.
- **Proxies:** the route sits behind the same client admission as every other one
  (`T3CODE_TRUSTED_PROXIES` decides which forwarded addresses and schemes count) and needs nothing
  of the public URL beyond the absolute `url`.
- **On the wire:** `preview.proxyHttp` and `preview.proxySocket` are workspace streams (spec 2's
  `workspace.stream`): a response's head, then its body in base64 chunks of up to 64 KiB; a
  socket's open (with the subprotocol the dev server chose), messages and close.
  `preview.proxySocketSend` carries the browser's messages in order. The Hub holds at most 512
  chunks of a response (1,024 messages of a socket) for a reader that has not taken them, and the
  machine at most 1,024 socket messages; past that the stream fails, so a slow client never holds
  the machine's socket and a cut response never reads as complete. Request bodies are capped at
  8 MiB. The machine gives a dev server 30 seconds to answer a request's head and 15 to finish a
  WebSocket handshake; the Hub waits 45 for the machine.
- **Activity:** preview traffic should keep a Sandbox awake once idle stops exist (ticket 02); the
  call site is marked in `HubPreviews.check`.
