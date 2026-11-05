# A central Hub is the source of truth

Upstream T3 Code has no central server: each Environment owns its own state and clients merely aggregate them. We add a Hub, a single server on the Owner's VPS, that owns users, permissions, AI accounts, vaults, the Project registry and the list of Environments; other Environments register with it and run agents on its behalf. Without one place that knows who is who, a Project could not move between Environments, a vault could not serve several Projects, and a revoked permission could not take effect everywhere at once.

The Hub process itself never runs agents, because it holds every Space's secrets. The default place work runs is the Sandbox of its Space on the Hub's machine (see ADR 0004), so a Thread with no chosen Environment still runs on the Owner's VPS.
