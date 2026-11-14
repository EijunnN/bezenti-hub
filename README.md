# T3 Code Hub

A self-hosted, multi-user home for coding agents. One Hub on your own server keeps every Thread's history, decides who may use which secret and which AI account, and sends the work to the right machine. Your team reaches it from the web, the desktop app or the phone.

Works with Claude Code, Codex, OpenCode, Pi, Cursor, Antigravity, Grok, Kiro and more.

## Why

Coding agents usually live on one person's laptop: the history, the keys and the logins stay there. When a team wants to share them, three things break:

- **Work doesn't travel.** Close the laptop and the Thread is stuck on it.
- **Keys spread badly.** Everyone pastes API keys on their own machine; nobody knows who has what or how to take it back.
- **AI subscriptions don't share.** One person uses a subscription, or a password gets passed around.

The Hub fixes all three. The rule behind it: **the Hub decides and stores; machines run the work.** The Hub never runs agents itself.

## What you get

- **People and permissions.** One Owner; Organizations with Admins, Members and Guests; a private Personal space per person; passkeys; an audit log.
- **Threads stored on the Hub.** Every conversation and its changes live on the Hub. Move a Thread from one machine to another and keep going; nothing is lost when a machine goes away.
- **Where the work runs.** A Sandbox per Space (a rootless Podman container on the Hub's server), machines people join with `t3 join`, and dedicated servers an Organization shares (added by hand or over SSH).
- **Vaults.** Secrets reach agents as environment variables, never as arguments, files or logs. Values show as `[NAME]` in history, terminals, diffs and files. Allow a Vault to a Space or a person; take it back at any time.
- **AI accounts and the gateway.** Add API keys and subscriptions (Claude, ChatGPT, Google AI Pro and others) once. Choose who may use each one and in what order. Agents go through the Hub's gateway with a per-Thread key and never see the real credential. Usage is recorded per person, Space and account.
- **Local CLI keys.** Use Claude Code or Codex on your own computer through the Hub's accounts.
- **Clients.** The web app served by the Hub, an Electron desktop app, and a mobile app.

## Concepts in one table

| Word            | What it is                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------- |
| **Hub**         | Your central server: people, permissions, Vaults, AI accounts and every Thread's history.       |
| **Space**       | Where things belong: an **Organization** (a team or a client) or a person's **Personal space**. |
| **Project**     | A code repository. It belongs to one Space, not to one machine.                                 |
| **Thread**      | A conversation with an agent about one task. Its history lives on the Hub.                      |
| **Environment** | A machine that runs the work: a Sandbox, a joined laptop or a dedicated server.                 |
| **Vault**       | A box of secrets handed to agents as environment variables.                                     |
| **AI account**  | An API key or a subscription the Hub shares with whoever you allow.                             |

## Run your own Hub

You need a Linux server with systemd, a domain with HTTPS (passkeys require it) and, for Sandboxes, rootless Podman 3.4 or newer.

```bash
git clone https://github.com/EijunnN/bezenti-hub.git
cd bezenti-hub
vp i          # install dependencies (see "Build from source" below)
vp run build
```

Then publish the Hub behind a reverse proxy with TLS, set its public address and start it as a service:

- [Install and first run](./docs/user/install.md)
- [Publish the Hub](./docs/user/public-hub.md): DNS, proxy, `T3CODE_PUBLIC_URL`, previews
- [Run it as a background service](./docs/user/background-service.md)
- [Updating](./docs/user/updating.md)

On first start the Hub prints a pairing link: create the Owner account with a passkey, then download the **master key** backup from Settings → Sharing & access. Without that key, every stored secret is lost if the server is lost.

## Documentation

User guides live in [docs/user](./docs/user):

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Guest links](./docs/user/guest-links.md)
- [Moving Threads between machines](./docs/user/thread-migration.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [Source control](./docs/user/source-control.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [FAQ](./docs/user/faq.md)

How it works inside: [docs/internals](./docs/internals), starting at [overview.md](./docs/internals/overview.md). Secrets and masking: [secrets.md](./docs/internals/secrets.md). AI accounts and the gateway: [ai-gateway.md](./docs/internals/ai-gateway.md). Sandboxes: [sandboxes.md](./docs/internals/sandboxes.md).

## Build from source

The repo uses [Vite+](https://viteplus.dev/guide/), so install the global `vp` tool first.

```bash
# macOS / Linux
curl -fsSL https://vite.plus | bash
```

```powershell
# Windows
irm https://vite.plus/ps1 | iex
```

Then:

```bash
vp i                                  # dependencies
vp run dev                            # local development
vp run dist:desktop:linux             # desktop app (also :dmg, :win)
cd apps/mobile && pnpm android        # mobile app (or pnpm ios)
```

See [docs/operations/development.md](./docs/operations/development.md) for prerequisites and details.

## Status

Early. The core is in place and covered by tests, but it has not been run in production yet. Expect rough edges.

## License

[MIT](./LICENSE)
