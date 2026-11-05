# One rootless container Sandbox per Space

Agents of different Spaces must not read each other's files or secrets, see each other's processes, or reach each other's network services; inside one Space nothing is isolated. Each Organization, and each Personal space allowed to create, gets its own Sandbox on the Hub's machine: a T3 server running under its own OS user inside a rootless Podman container, created on first use and registered with the Hub as an Environment that serves only that Space.

## Considered Options

- One T3 server per Space with its own OS user, no container: cheapest, but loopback is shared, so one client's dev servers and previews are reachable from another's agents.
- gVisor runtime for the same containers: stronger against kernel bugs but slower for git and npm; can be added later as a runtime option.
- MicroVMs (Firecracker, Kata): strongest, but need KVM, which many VPS plans lack.
- Per-process sandboxes (bubblewrap, each CLI's own sandbox): defence in depth only; they allow broad reads and vary per provider.

## Consequences

No isolation protects a Space's secrets from that Space's own agent; how secrets reach agents is decided with vaults. A base image with the toolchain (node, git, the AI CLIs) must be maintained.
