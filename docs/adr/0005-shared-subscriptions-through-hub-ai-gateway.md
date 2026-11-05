---
status: accepted
---

# Shared subscriptions through a Hub AI gateway, risk accepted

Only the Owner registers AI accounts, subscription logins and API keys alike, and decides which Spaces and Users may use each one. The Hub runs CLIProxyAPI as its AI gateway: real credentials never enter a Sandbox, each Thread gets a gateway key limited to its allowed AI accounts, and CLIProxyAPI handles global priority, pooling and same-model failover on quota exhaustion.

## Consequences

Letting other people use the Owner's Claude and ChatGPT subscriptions breaks Anthropic's consumer and Claude Code terms ("you may not make your Account available to anyone else"; no routing subscription credentials on behalf of other users), and the gateway's VPS uses datacenter IPs that Anthropic scrutinises. Accounts can be suspended without notice. The Owner accepted this risk knowingly; per-seat business plans (Claude Team, ChatGPT Business) or API keys are the compliant fallback and fit the same model, since they are just other AI accounts. Providers whose CLI cannot take a custom base URL still need a credential inside the Sandbox; that is decided per provider in the spec.
