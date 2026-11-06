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

### App sign-in

The desktop and mobile apps sign in to a Hub through the system browser
(RFC 8252), so passkeys and password managers work and the app never sees a
credential. [AppSignIn](../../apps/server/src/auth/AppSignIn.ts) is the whole
server side:

- The app makes a PKCE verifier and `state`, and opens `/app-sign-in` with the
  S256 challenge, its redirect and a label. The page signs in as any browser
  does, then the User approves: `POST /api/auth/app-sign-in/approve` takes only
  the browser's own cookie (its origin checked with it), never a bearer token,
  so every app session traces back to a sign-in in a browser. The page and
  `/connect-agent` are served with `frame-ancestors 'none'` and
  `X-Frame-Options: DENY`, so another site cannot frame the consent. Cancel
  returns `error=access_denied` with the `state` to the same redirect.
- The redirect is a loopback `http://127.0.0.1:<port>/callback` or `[::1]`, never
  `localhost`, which can resolve elsewhere (RFC 8252 §8.3) (the desktop
  app listens on a port of its own for that one sign-in) or exactly
  `t3code[-dev|-preview]://auth/callback`
  ([`appSignInRedirectKind`](../../packages/shared/src/appSignIn.ts)). Anything
  else is refused, so the page is not an open redirect and the code never
  leaves the device that asked for it.
- The Hub keeps the code's SHA-256 in memory with the User, challenge and
  redirect, for one minute. `POST /api/auth/app-sign-in/token` spends a code on
  its first presentation, even when the verifier or redirect then fails, and
  issues a bearer (or, with a DPoP proof, DPoP) session for that User, subject
  `app-sign-in`, with the standard scopes the approving browser session held,
  never more. A restart drops pending codes;
  the app just signs in again. Like other app tokens it lasts 30 days from
  issue and does not slide.
- Signing out (`POST /api/auth/sign-out`) ends the request's own session,
  cookie or token, so removing a Hub from an app revokes its session there. The
  client also signs out a new session it could not save, and the previous one
  when it signs in to a saved Hub again. Apps refuse a plain-HTTP Hub address
  outside this machine, the LAN and the tailnet, as the Hub's transport rule
  would.

A custom URL scheme is not owned: another app on the phone can register
`t3code://`. It cannot use a code it intercepts, because the exchange needs the
verifier that stayed in the T3 Code app, and a callback whose `state` is not
the app's own is dropped. iOS hands an `ASWebAuthenticationSession` result
only to the app that opened it; on Android the redirect is an ordinary intent
that another app could catch, which is why the verifier matters. What a scheme
cannot stop is
a malicious app starting its own sign-in, with its own verifier, and asking the
User to approve it; the approval page names the client label (chosen by the
app) and where the code goes, and says to continue only with a sign-in the
User just started. Claimed HTTPS redirects (universal and app links) would
close that gap and are the next step if it matters.

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
Using a Personal space at all needs the `personalSpace.create` Installation
permission: without it the space is hidden (`space.view` is denied, so what it
holds from before a revoke reads as missing too). The Owner grants and revokes
permissions (`installation_permissions` rows) over HTTP
(`/api/installation/users`, which also needs the `access:read`/`access:write`
scope) through `SpaceDirectory.setInstallationPermission`. `environments.registerOwn` is
only stored. The Owner reads every
Personal space and lists them in the selector, but changes nothing in another
User's (`personal-space-read-only`). Naming a Space one cannot see, a
`personal:<id>` included, answers exactly like naming a missing one.

#### Who sees what

A User sees the Projects and Threads of the Spaces the policy lets them view
(`space.view`): their own Personal space (with the permission) and every live
Organization they belong to. The Owner sees everything, every Personal space included; an archived
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
bumps, so a new Membership shows on the next read without reconnecting. A
Membership that ends or changes instead closes the User's sockets
(`connectionEnds` in `ws.ts`, fed by `SpaceDirectory.membershipsChanged`),
because rows already sent cannot be filtered back out. The client reconnects and
resumes its shell from its last sequence, and a resume would send only new
events, so removing a Membership also stamps `users.access_narrowed_through`
with the current event sequence; a resume from at or before it gets a full
snapshot instead (`CurrentViewer.lostAccessSince`). Every other stream re-checks
visibility when the client resubscribes. The socket subscribes to Membership
changes before it resolves its viewer, so a change in between is not missed, and
a write that changes nothing publishes nothing.

Granting or revoking an Installation permission keeps the socket: it wakes that
User's open streams instead (`SpaceDirectory.subscribeAccessChanges`, one hub
per User, only when a row changed). The shell stream restarts, the old round
ending before a fresh authoritative snapshot and its live tail take over (web
reloads its Spaces on it). Streams on one Thread (Thread, command output,
worktree setup, terminals) go through `untilAccessLost` in
[RpcSpaceAccess](../../apps/server/src/auth/RpcSpaceAccess.ts): it subscribes,
reruns the middleware's guard once and on each change, and ends the stream when
the guard refuses. A Membership change wakes the same hub before its socket
closes.

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

An Organization's lifecycle is the Owner's
([OrganizationLifecycle](../../apps/server/src/spaces/OrganizationLifecycle.ts)).
Archiving sets `archived_at` and, like a removal, marks its Members'
`access_narrowed_through` and closes their sockets, so their shells resume without
it; it then stops, as the Owner, every Thread with live work: unfinished runs, open
requests, background commands and delegated tasks (`threadHasLiveWork`; the Sandbox
stop of spec 3 goes there too). Nothing starts there afterwards: the policy refuses
Users' creates and continues, and the orchestrator refuses any `message.dispatch`,
fork or delegated task in an archived or frozen Space whoever sends it, the server's
own resumes and continuations included (`SpaceDirectory.workBlocked`). Scheduled
tasks run only in an open Space: archived, frozen or deleted ones skip their runs,
and a failed read skips the tick. Restoring clears `archived_at` and
publishes on the Members' access-change hubs, so open shells reload with it. Delete
is refused unless archived and first sets `deleting_at` (migration 091) in the same
transaction as the check, so the Organization is never restored half-deleted: it deletes the Organization's Projects (with their
Threads) and leftover Threads through `ProjectService`'s event-sourced delete paths,
with command ids fixed per Organization so a retry replays, then removes its
scheduled tasks, Memberships, Invitations and row in one transaction.

Moving a Project (`project.move` in the project mutation) is decided on both
Spaces: the mover runs the origin and the destination (Admin of an Organization, or
the User of a Personal space). The Owner moves anything except into or out of
another User's Personal space, other than out of a removed User's frozen one.
Nothing moves into an archived or frozen Space. `ProjectService.move` marks the Project
moving (`whileProjectMoves`: no Thread is created or started in it meanwhile), checks
each Thread idle under its lock and refuses with `ProjectMoveBlockedError` (HTTP 409)
naming the busy ones, records the Project's new `spaceId` on a `project.meta-updated`
event, then lists its Threads again and gives each the new Space with a
`thread.metadata-updated` event under its lock, each checked as a move out of the
Thread's own Space (so a stray Thread stamped elsewhere needs that Space's rights too). Afterwards `SpaceDirectory.projectMoved` bumps
`revision`, marks who lost it as narrowed and publishes on every viewer's
access-change hub, so the origin's open shells drop it and the destination's gain
it, also after a move that failed part way. A rerun of an interrupted move finishes
its Threads.

Spaces are read and Organizations created over HTTP (`/api/spaces`), beside the
account endpoints, rather than as guarded WS commands: creating an Organization
depends on who the User is, not on a session scope, so clients show controls from
the server's `canCreateOrganization`, `canCreateThreads`, `canInvite`,
`canMoveProjectsOut` and `canMoveProjectsIn` answers; archived Organizations are
listed (marked `archived`) only to the Owner.
Per-Thread controls come from `threadRolePermissions` in the client runtime, which
mirrors the policy from the directory's Roles and `isOwner`; the server stays the
judge.

### Invitations

People join an Organization only through an Invitation
([InvitationService](../../apps/server/src/spaces/InvitationService.ts)), which
carries the Role and is created, listed and revoked over HTTP
(`/api/spaces/:spaceId/invitations`, `/api/invitations/revoke`). The policy's
`invitation.create` and `invitation.manage` actions allow the Owner and the
Organization's Admins, only in an Organization (nothing is shared from a Personal
space), and creating needs a live one. An Admin Invitation, to create or to
revoke, also needs `admin.manage`, which is the Owner's alone. The link is `<origin>/invite#token=…`; the token is 32 random
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

### Memberships

[MembershipService](../../apps/server/src/spaces/MembershipService.ts) lists,
changes, removes and leaves over `/api/spaces/:spaceId/members…` and `/leave`.
The policy decides each on a `MembershipResource` (the target's current Role and
the one asked for): an Admin acts on Members and Guests only, and anything that
starts or ends at Admin is the Owner's. The check and the write share one
transaction, and the target's connections close after it commits. Removing and
leaving delete only the Membership row; Projects and Threads keep their Space and
creator. Members of an Organization see its member list; anyone else gets the
same answer as for a missing Organization.

An Admin Membership counts only for a User with a passkey or TOTP: until then
`SpaceDirectory` gives them a Member's Role (`pendingAdmin` in the directory and
member list), and the credentials row's `isAdmin`, which feeds
`passwordRequiresTotp`, is false. A phished password therefore never yields Admin
rights, and nothing enrolls TOTP from the sign-in form: a pending Admin adds it
under Settings → Access with a step-up. Promoting a User who has a passkey and a
password but no TOTP revokes their sessions in the same transaction, since any of
them may have come from the password; their password then answers
`SecondFactorMissingError`. Credential changes that start or end Admin rights call
`AccessChanges` (provided by SpaceDirectory, so account code need not depend on
Spaces) after they commit.

Removing someone, or changing an Admin to another Role, revokes the pending
Invitations they created in that Organization in the same transaction. A guest
link records its creator and stops working once that User may no longer create
guest links on its Thread (checked on every guest request), which covers removal
and demotion without a write to the Thread.

### Disabled and removed Users

[InstallationUserService](../../apps/server/src/spaces/InstallationUserService.ts)
sets `users.disabled_at` / `removed_at` and, in the same transaction, expires
their reset links, revokes the Invitations they created, and revokes every
`auth_sessions` row (browser, app, MCP client and CLI bearer are all sessions)
and pairing link of theirs in one write each; removal also deletes their
Memberships and sets their Personal space's `frozen_at`. Sockets and the
per-User hub hear it after the commit. Asking again for the same status reruns
the revocation, so a retry finishes a half-done one, and a session read treats
a disabled or removed User's session as revoked regardless. Their principal
carries `inactive`, which the policy denies everywhere, so anything that acts
_as_ them without a session (guest links they made, agent tool calls) stops
too, and their Memberships can stay for a re-enable. After the commit
`SpaceDirectory.userStatusChanged` tells the work that runs as them:
`InactiveUserTurns` interrupts their running turns, and `ScheduledTaskService`
pauses their enabled tasks (`paused_for_owner`), resumes exactly those on
re-enable, and skips and pauses any run whose creator turned out inactive; the
Owner may pause or delete such a task. A trigger (migration 092) refuses a new
session or pairing link for an inactive User, closing the race with a sign-in
already under way, which then answers as the disabled account. App sign-in
codes need no revocation since their exchange checks the User. Sign-in
(passkey, password, the TOTP step, recovery code) says the account is disabled
or removed only after the credential verified, so it is no oracle, and spends
nothing. The User row stays as a tombstone for names. A frozen Personal space
is read-only for everyone; the Owner may only stop its running Threads, move its
Projects out (`ProjectService.move`) and
delete from it, archived or not.

Reset links are the Owner's alone (`UserDirectory.issueResetLink`; `created_by`
names the issuer), since a link takes the account over. Redeeming one registers a
passkey or, for anyone but the Owner, sets a new password; either way it removes
every other passkey, the password and TOTP and ends every session, in one
transaction.

### Audit log

[AuditLog](../../apps/server/src/audit/AuditLog.ts) appends to `audit_log`
(migration 093), which triggers keep append-only; nothing prunes it. An entry
is written by the service that performs the action, inside that action's
transaction, so a rolled-back action leaves none and an entry that cannot be
written fails the action. Event-sourced actions (permanent Thread and Project
deletes, Project moves, guest links) pass their entry to `EventSink`
(`commitCommand`/`commitProjectCommand` `audit`), which writes it with the
receipt as the fiber's `CommandActor`, so a replayed command records nothing.
App sign-in and MCP OAuth approvals live in memory and record before their
code is minted. The shell (`t3 auth session issue`, `t3 auth owner-reset`)
records as actor `cli`. Entries snapshot the Space and target names, since
Organizations and Projects are deleted while Users are only tombstoned. Detail
keys that name a credential are dropped on write, whatever the caller passes.
`secret.*` and `environment.register` are in the closed `AuditAction` list for
the specs that own them to record. The read (`/api/installation/audit`) is
Owner-only and needs `access:read`; anyone else gets the same 403 whatever
they filter by.

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
