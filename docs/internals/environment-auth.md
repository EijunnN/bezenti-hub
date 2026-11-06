# Environment authentication

The environment issues its own sessions and enforces their capabilities. A
session comes from a pairing grant or from a User signing in to a local account.

## Authority survives transport changes

Pairing delegates a set of scopes. Exchanging a bootstrap credential can narrow
that grant but cannot widen it. The default grant includes access
management: `terminal:operate` is a shell as the server's user and
`orchestration:operate` can start a full-access agent, and either can mint a
session with every scope through `t3 auth session issue`, so withholding
management from the default would not be a boundary. A narrower client gets
explicit scopes. Creating another pairing link requires both `access:write` and
every scope being delegated. The
[auth handlers](../../apps/server/src/auth/http.ts) enforce this at issuance;
client labels and device metadata have no authorization role.

The access read model contains pairing metadata, never recoverable pairing
secrets. Only the creation response returns the raw credential. Otherwise read
access to the connections list would become a way to acquire another client's
authority.

Browser cookies, bearer tokens, and DPoP tokens adapt the same scoped session
model. DPoP binds a token to a client's proof key; an invalid proof must fail
rather than fall back to bearer authentication. The OAuth token-exchange
vocabulary gives these grants a familiar meaning.

### User accounts

A session's `subject` names how it was obtained and security checks match its
literals, so the User travels separately: the `auth_sessions` row's `user_id`,
mirrored in the signed `uid` claim. Verification reads the row, so detaching a
User never needs a reissued token.

Once an Owner exists every session belongs to a User. A pairing link carries
the User who created it, and a device that redeems it signs in as that User. An
outside MCP client acts as the User who approved it (see
[MCP clients](#mcp-clients-are-a-separate-audience)). The Hub's shell picks the
User: `t3 pair`, `t3 auth pairing create`, `t3 auth session issue` and
`t3 thread` take `--user <sign-in name or id>`, resolved by
`UserDirectory.findActiveUserByName`, and issuance refuses a disabled or removed
User. Only paths that are the Installation's own bind to the Owner in
[EnvironmentAuth](../../apps/server/src/auth/EnvironmentAuth.ts): those shell
commands without `--user` (only someone with the Hub's shell runs them), the
startup link, the desktop bootstrap, the reusable dev token and `t3 project`.
The binding is explicit at each caller rather than a default in
[SessionStore](../../apps/server/src/auth/SessionStore.ts): a future path that
forgot its User would otherwise silently act as the Owner. Instead an
`auth_sessions` trigger refuses a row without a User once an Owner exists, so
such a path fails closed. Creating the Owner hands it every earlier session,
since before then only the machine's operator could pair.

Browser sessions slide: the row's `expires_at`, not the signed `exp`, is the
deadline, and each use moves it to 30 days ahead, written at most once an hour.
An open socket renews it an hour before the deadline, since the renewal only
moves a deadline that has not passed. Bearer, DPoP, MCP and CLI tokens keep the
fixed lifetime in their `exp`: they are held unattended, so use must not keep a
leaked one alive. The browser cookie's expiry is re-sent on every
`/api/auth/session` check, so it follows the row.

Each User sees and revokes their own sessions and links; the Owner (or anyone
before an Owner exists) sees everyone's. The access stream subscribes before
reading its snapshot and passes a removal only for an id it already showed that
viewer, since a removal carries nothing else to scope it by. A link is checked
against its User when redeemed, so a disabled User's links stop working, and a
credential change or reset revokes the User's unspent links along with their
other sessions: a link minted with a stolen session must not outlive the change
that ends that session.

The administrative bootstrap link creates the Owner exactly once
([UserDirectory](../../apps/server/src/auth/UserDirectory.ts)); the passkey is
verified before the link is spent, so a cancelled registration does not burn
it. Once an Owner exists that link refuses Owner creation and the web app sends
its visitor to sign in, though other clients can still exchange it to pair as
the Owner. Once used, revoked or expired, that link reports `spent` from the
owner-status endpoint, so the web app says it was used rather than calling it
invalid. Every other credential reports `not-applicable`, so the unauthenticated
endpoint never confirms that one existed. Signed-out visits go to `/sign-in` once an Owner exists
(the session state reports `ownerExists`); the pairing-code form only appears
on a fresh Installation.
A passkey is bound to the host name the browser used when it was registered
(the WebAuthn relying party ID, taken from the request's `Origin`), so moving
the Installation to another domain strands existing passkeys. With
`T3CODE_PUBLIC_URL` set, that origin is the only one a passkey ceremony
accepts, and it passes the origin check even when a proxy rewrites `Host`, so a
passkey cannot be registered on another name for the same server. Recovery codes
and Owner reset links are the way back in. Both are random enough that a plain
SHA-256 is stored, and each is spent atomically on use. A reset link comes from
`t3 auth owner-reset`, which writes to the database directly, so it works with
the server stopped. It lasts one hour, and issuing one ends the earlier ones. A
registration started from a link can only be finished with that link. A reset
assumes the old passkeys are lost or stolen, so in one transaction it spends the
link, replaces every passkey with the new one, revokes the Owner's sessions and
issues a new one.

### Spaces

Every Project and Thread belongs to a Space: an Organization or a User's Personal
space. Who may do what is decided only by the pure
[AccessPolicy](../../apps/server/src/auth/AccessPolicy.ts), whose table-driven test
is the Role table; a new rule is a new row there, not a check at a call site.
[SpaceDirectory](../../apps/server/src/spaces/SpaceDirectory.ts) loads the
principal (Owner or not, Roles, Installation permissions) for it.

A new Project or Thread is claimed for its Space inside the service every caller
goes through, `ProjectService.create` and `ThreadManagementService.dispatch`, so
the web client, launches, MCP tools, scheduled tasks and the CLI are all checked
and stamped with `spaceId` and `ownerUserId`. Transports only pass the session's
User (a client's `ownerUserId` is replaced). MCP tools pass the invocation
scope's `userId`, so an agent creates as the Thread's owner and an outside client
as the User who approved it; a refusal reaches the agent as the app's message.
Only callers with no User at all act as the Owner: work before an Owner exists,
`t3 project`, and server-made effects. A scheduled task records its creator
(`owner_user_id`), only they change or run it, and its runs act as them; tasks from
before Users keep running as the server. A Thread joins its Project's Space, and a
Project from before Spaces counts as the Owner's Personal space, so a client's
requested Space applies only to new Projects and to Threads in unknown Projects.
Clients send their current Space only to the environment it came from. Archived
Organizations and frozen Personal spaces take nothing new, even from the Owner.

Rows from before Spaces keep `NULL` in both columns and count as the Owner's
Personal space; the migration cannot backfill them because the Owner may not
exist yet. A trigger on `users` creates each User's Personal space
(`personal:<userId>`) with the row, so no account path has to remember it.
Creating in a Personal space needs the `personalSpace.create` Installation
permission, which only the Owner holds until the Owner can grant it.

#### Who sees what

A User sees the Projects and Threads of the Spaces the policy lets them view
(`space.view`): their own Personal space and every live Organization they belong
to. The Owner sees everything, every Personal space included; an archived
Organization disappears for its Members only. A Thread's Space is its own
`spaceId`, else its Project's, so an unstamped child Thread follows its Project;
with neither it is the Owner's.

[SpaceVisibility](../../apps/server/src/spaces/SpaceVisibility.ts) is the only
place this is answered, and every read of Projects or Threads asks it:

- The stores take a `spaceIds` filter (`SpaceVisibility.spaceFilter`) and put
  `threadInSpaces` in their SQL, so hidden Threads are never read or decoded:
  the shell snapshot and its index, archived and older settled pages, families,
  worktrees, search and Pull Request links. Projects are filtered by `spaceId`.
- The shell stream drops a live delta for a Project or Thread the subscriber
  cannot see before reading it, so deltas never show what the snapshot hid.
- RPCs that name one Thread or Project are checked by the RPC authorization
  middleware from [RpcSpaceAccess](../../apps/server/src/auth/RpcSpaceAccess.ts).
  It lists every `orchestration.*` RPC and every RPC whose payload names a
  `threadId`, `projectId` or `projectIds`, as `thread`, `project`, `filtered` or
  `unscoped` with the reason; `RpcAuthorization.test.ts` fails when one is
  missing. A hidden Thread and a missing one both fail with
  `SpaceResourceNotFoundError`, so a refusal is not an existence oracle. HTTP
  Thread routes answer `thread_not_found` the same way.
- MCP read tools use the scope's `userId` (`mcpVisibility`). Every caller has
  one once an Owner exists: an agent in a Thread reads as the Thread's owner, an
  outside client as the User who approved it. A caller with none reads as
  everything, which only happens before an Owner exists.
  The scope's `userId` is the same field WS and HTTP principals carry, so
  `SpaceDirectory.principalOf` gives services the same principal (Owner or not,
  Roles, Installation permissions). MCP project updates and deletes treat a
  Project the User cannot see as missing; Role write rules come with ticket 08.

Each WebSocket connection resolves its viewer once (`CurrentViewer`) and again
only when `SpaceDirectory.revision` moves, which every Space or Membership write
bumps, so a new Membership shows on the next read without reconnecting. An open
shell keeps rows it already sent when a Membership ends; removing Members
(ticket 09) must close or resubscribe those connections.

#### Who changes what

Every write meets the Role rules where all transports meet: thread commands in the
orchestrator's dispatch, under the Thread's lock
([commandAccess](../../apps/server/src/orchestration-v2/commandAccess.ts) maps each
command to an action), Project changes in `ProjectService`, and Force stop in
`ThreadManagementService` before it kills the agent. Who acts is the fiber's
[CommandActor](../../apps/server/src/auth/CommandActor.ts): the RPC middleware sets
it to the session's User, the HTTP mutate route likewise, an MCP call acts as its
credential's User (an agent as its Thread's owner), and
`ServerRuntimeStartup.enqueueCommand` carries it into its worker. Only the server's
own work (effect worker, reactors, tasks from before Users) has no actor and goes
unchecked; once an Owner exists, a request whose session names no User is refused
(`SpaceDirectory.actingUser`), and an agent in a Thread from before owners acts as
the Owner. The receipt store stamps the actor on every
command receipt (`actor_user_id`); nothing a client sends sets it.

Only a Thread's creator speaks in it or changes it, not even an Admin or the Owner
(MCP app calls and model context included); archiving, restoring and stopping are
the creator's or an Admin's; permanent deletion is an Admin's and only from the
archive. Pins, settling, snoozes and tags are stored once per Thread, so they are
the creator's or an Admin's too; visits and unread marks are open to every viewer,
and since that marker is per Thread a viewer's visit also marks it read for its
creator until markers are kept per User. A command not named in `commandAccess`
counts as continuing, so a new command is owner-only until someone decides
otherwise. A refusal on something the User can see is a `SpaceAccessDeniedError`
that says why; a hidden target and a missing one fail alike as not found on every
path. Refusals record no receipt, since a Role can change and the retry should
pass, and a command id replays only for the User who sent it.

Terminals, previews, devices, chat attachments and worktree setup are `work` RPCs
in `RpcSpaceAccess`: only the Thread's owner works them, and a terminal opens only in
the folder of a Thread the User created or in a Project of a Space where their Role
creates Projects (so not a Guest's). A draft has no row to
carry an owner, so the first User to work it holds it in memory
(`SpaceVisibility.claimWork`); it is hidden from everyone else, and the terminal
and preview streams show each User only what they may work. A launch whose
client-chosen id names an existing Thread fails before anything is provisioned,
alike for hidden and visible Threads, and Pull Request
calls routed by repository see only visible Projects (`RequestVisibility`).

Spaces are read and Organizations created over HTTP (`/api/spaces`), beside the
account endpoints, rather than as guarded WS commands: creating an Organization
depends on who the User is, not on a session scope, so clients show controls from
the server's `canCreateOrganization`, `canCreateThreads` and `canInvite` answers.
Per-Thread controls come from `threadRolePermissions` in the client runtime, which
mirrors the policy from the directory's Roles and `isOwner`; the server stays the
judge.

### Invitations

People join an Organization only through an Invitation
([InvitationService](../../apps/server/src/spaces/InvitationService.ts)), which
carries the Role and is created, listed and revoked over HTTP
(`/api/spaces/:spaceId/invitations`, `/api/invitations/revoke`). The policy's
`invitation.create` and `invitation.manage` actions allow only the Owner for now,
only in an Organization (nothing is shared from a Personal space), and creating
needs a live one. The link is `<origin>/invite#token=…`; the token is 32 random
bytes shown once, and only its SHA-256 is stored, so looking it up leaks nothing
through timing. The web app's startup pairing leaves `#token=` alone on `/invite`,
as on `/reset`.

The invitee's endpoints (`/api/invitations/preview`, `registration`,
`totp-enrollment`, `accept`) need no session. An unknown, expired (7 days),
revoked, used or archived-Organization link answers the same `invalid` preview
and the same refusal, and each such miss counts toward the per-client back-off
of password sign-in. Accepting verifies the passkey, or hashes the password and
checks the TOTP code, first; then one transaction creates the User, spends the
Invitation with a conditional `UPDATE` (so of two racing accepts one wins),
adds the membership and issues the browser session. A refusal inside it, such as
a taken sign-in name, leaves the link unspent. A signed-in User accepts through
`/api/invitations/join`, which adds the Organization to their User instead; it
refuses the Owner, an existing Member, and an Admin Invitation for an account
that signs in with a password alone.

### Sign-in rules

Which accounts may use a password without a second factor is one function,
`passwordRequiresTotp` in UserDirectory: true for the Owner and for an Admin of
any Organization. Extend that function rather than checking roles at call sites.
It applies three times: setting a password needs TOTP enrolled first, removing
TOTP needs the password gone first, and password sign-in refuses an account the
rule covers when it has no TOTP. The last check catches an account whose rule
changed after it set a password. An Admin Invitation therefore takes a passkey,
or a password together with a TOTP enrollment confirmed in the same accept.

Any account with TOTP gets the code step: the password step answers
`secondFactor: "totp"` with a short-lived challenge id, and the code goes to
`/api/auth/password/totp`. That answer comes whether or not the password was
right (a wrong one gets a challenge no code passes), so it never confirms a
guessed password on its own. Failed passwords, codes and step-up proofs count
per account and per client address, which behind a trusted proxy is the
forwarded one. After five failures each further one locks
the key for twice as long, from 30 seconds up to 15 minutes. The counters live in
memory, so a restart clears them.

A stolen session must not be able to install a lasting way in. Setting,
changing or removing a password and confirming or removing TOTP therefore need
a step-up proof in the same request: a fresh passkey assertion, or the current
password plus a code when TOTP is enrolled. Only an account with no credential
yet is exempt. Each such change revokes the User's other sessions, and a removal
that would leave no way to sign in is refused.

Passwords are argon2id (19 MiB, two passes) via `hash-wasm`, which is
WebAssembly. A native addon would need a build per platform staged into the
desktop and CLI artifacts, and `node:crypto.argon2` needs Node 24.7, newer than
the server's supported floor. Hashing holds the event loop for tens of
milliseconds, so at most two run at once. TOTP secrets are sealed with
AES-256-GCM under the `user-credential-key` server secret, with the User id as
associated data. Each sign-in code's 30-second step is recorded, so a code works
once. An enrollment code is not recorded, since it only proves the app works.

### Guest links are not sessions

A [guest link](../user/guest-links.md) gives one browser read access to one
thread and a way to propose messages. Its tokens are HMACs of the thread and
share id under a server key ([GuestShareService](../../apps/server/src/guest/GuestShareService.ts)),
so nothing secret is stored. The share in the thread projection is the only
state: replacing, closing, or archiving it revokes every token, and the
orchestrator's serial commands make redeeming and sending happen once. Guest
tokens never enter `SessionStore`, so no RPC, WebSocket, or MCP path can accept
one. Guest routes also require the environment's public address to still be the
link's hostname; the request's Host header is not checked, because a LAN client
can forge it. No public address exists until the Hub provides one, so guest
links cannot be created yet.

### MCP clients are a separate audience

Agents T3 Code did not launch sign in to `/mcp` through a narrow OAuth
authorization-code server ([McpOAuth](../../apps/server/src/auth/McpOAuth.ts)).
It accepts loopback redirect URIs for agents on the user's machine and any
HTTPS redirect for hosted agents (ChatGPT, bots). An HTTPS redirect means a
link someone else sends the owner can deliver access to that someone, so the
approval page names the host access goes to and approving stays the owner's
call. Every client is public and proves itself with PKCE; a client that asks
for a secret is registered without one. Client registration is stateless, so an unauthenticated caller cannot grow server
state. Approval spends a one-time pairing code, or uses a browser session with
`access:write`; proof-bound codes are refused without being spent.

The issued session belongs to whoever approved: the signed-in User of that
browser session, or the User a pairing code was issued to (its creator, or the
`--user` it was created for). The authorization code carries that User to the
token exchange, and `/mcp` puts the session's `user_id` on the invocation
scope, so reads, creations and the client's place in "Your sessions" (listing
and revoking) all follow that User, and revoking or disabling the User cuts the
client off with the rest of their sessions. A signed-out consent page shows the
sign-in form in place and reloads the same request once signed in, so there is
no return URL to redirect through; the approval details name the User
(`signedInAs`). The CSRF token is bound to the approving session, client,
redirect and PKCE challenge, so it cannot approve for another sign-in. A
pairing code is checked before it is spent: its User must still sign in and, in a
signed-in browser, be that browser's User, so the page's "acting as" is always
true. Once an Owner exists an approval that names no User is refused rather than
given to the Owner; sessions from before the Owner are adopted by it when it is
created, so no MCP session stays userless. The token
stays a plain bearer: DPoP binding of MCP clients is unchanged.

The user grants either read-only access or a runtime-mode ceiling, not a
scope list: MCP tools are all orchestration, and `orchestration:operate`
alone would let an agent start a thread in full access and act through it.
The result is an ordinary session with subject `mcp-client`. A read-only
grant holds `orchestration:read` alone. On `/mcp` it passes only tools
declared as reads in [McpToolAccess](../../apps/server/src/mcp/McpToolAccess.ts),
where every tool must declare who may call it to compile. Any other grant adds
`orchestration:operate` and a signed ceiling. Only `/mcp` accepts these sessions. Every other HTTP and WebSocket
path rejects that subject, because the RPC surface would let the agent act
above its ceiling. Inside MCP the credential sets the limits and tool
parameters only pick targets; see
[threadAccess](../../apps/server/src/mcp/threadAccess.ts).

Issuer and resource URLs come from the request's Host and the scheme a trusted
proxy reported (see [the client behind a proxy](./remote.md#the-client-behind-a-proxy)),
so one server answers over loopback, Tailscale Serve and a reverse proxy. A
proxy that rewrites Host or drops the protocol header breaks sign-in.

Bearer and DPoP clients obtain short-lived WebSocket tickets through authenticated
HTTP so long-lived tokens stay out of socket URLs. A ticket names the route it
opens: the RPC socket, or the media routes (device hub, preview stream), which
share one ticket across `<img>`, `EventSource` and several sockets. A DPoP
client's RPC ticket is bound to its proof key and the upgrade carries a fresh
proof in the `dpop` query parameter, since a WebSocket cannot set headers; a
ticket captured on a plain HTTP LAN route is useless without the key, and the
proof's `jti` is consumed like any other. Media tickets stay bearer because each
media request would need its own proof. Clients that predate this mint unbound
tickets that open either route. Browser sessions can authenticate the upgrade
with their cookie. A successful handshake grants no
extra authority: [every RPC declares a required
scope](../../apps/server/src/auth/RpcAuthorization.ts), and the WebSocket RPC
group's `RpcScopeAuthorization` middleware checks it before any handler runs.

Scope changes must not prevent older clients from connecting. Token exchange
intersects recognized requests with the pairing grant; retired and unknown names
are dropped. A request with no granted scopes fails before consuming the link.
Stored credentials are never expanded when scopes split.

Auth responses keep `scopes` within the original wire vocabulary and include
`permissions` for the exact grant. New clients use `permissions` when present,
even if empty. Older servers omit it, so clients use legacy parent checks for
features those servers already support. These client checks never change server
authorization. Permission errors likewise retain a legacy `requiredScope` and
add the exact `requiredPermission`, so a denied RPC stays decodable by old clients.
Unknown response permissions are ignored; grant inputs stay strict.

Desktop restarts forget the previous local bearer token, so its reusable
bootstrap grant replaces earlier sessions for the same subject and method.
Revocation and insertion share a [database
transaction](../../apps/server/src/persistence/AuthSessions.ts); a failed
replacement must leave the old credential usable. Pairing and browser sessions
do not follow this replacement rule.

### Reusable dev credential

Web development environments can accept one `T3CODE_DEV_AUTH_TOKEN` across
worktrees and ports on one hostname. The token and startup URLs that contain it
grant administrative access. Desktop and non-development servers ignore it. See
the [development runbook](../operations/development.md#reusable-dev-credential)
for setup.

Each environment hashes the value and seeds its own database record at startup.
Environments do not share SQLite data, signing keys, environment IDs, session
records, pairing grants, or revocation state. Local revocation persists after
restart and does not affect another worktree. Removing or rotating the value
and restarting invalidates the old credential and its WebSocket tickets.

Normal credentials keep precedence. A rejected normal credential never falls
back to the reusable credential. OAuth exchanges create ordinary local bearer
or DPoP children with normal expiry and revocation. The reusable cookie expires
after 30 days.

## The environment is the filesystem boundary

Projects are organizational boundaries, not filesystem sandboxes.
`filesystem:read` permits reading files the server account can read, including
absolute paths outside a project. This lets clients display artifacts that an
agent writes in a temporary directory. Relative paths and writes still follow
the [workspace path rules](../../apps/server/src/workspace/WorkspaceFileSystem.ts).

Signed asset URLs are bearer credentials. A URL for media on the host grants
access to one canonical file and its device/inode identity, not its containing directory.
[Asset access](../../apps/server/src/assets/AssetAccess.ts) rechecks the opened
file's identity when serving it, so atomic replacement requires a new URL while
editing the same file in place does not. An HTML file authorized this way cannot
load sibling assets; directory-scoped workspace previews are a separate grant.
Clients should share the authored file reference so they do not disclose the
temporary URL's credential. `filesystem:read` is checked when the URL is minted,
not when it is served: a URL issued before the grant was revoked keeps working
until it expires, and it is not bound to the session that minted it.

Host videos can change in place. Their [HTTP
responses](../../apps/server/src/http.ts) omit cache validators because file
metadata cannot prove byte-for-byte identity for `If-Range`. Adding weak
validators would turn native-player seeks into full downloads.
