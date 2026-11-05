# Makita (t3code fork)

A self-hosted, multi-user extension of T3 Code: one Owner runs one installation for themselves and the people who work with them, giving each scoped access to projects, threads, AI accounts, vaults and environments. Base T3 Code vocabulary lives in `docs/internals/glossary.md`; a term defined here overrides it.

## Language

**Installation**:
One self-hosted deployment of this product, with exactly one Owner.
_Avoid_: Tenant, instance, workspace

**Owner**:
The single person who runs the Installation and holds every permission in it.
_Avoid_: Superadmin, root

**User**:
A person with a sign-in on the Installation's Hub.
_Avoid_: Account, cuenta (reserved for AI accounts), usuario

**Hub**:
The central server of an Installation and the source of truth for Users, permissions, AI accounts, vaults, Projects and registered Environments. It never runs agents itself.
_Avoid_: Control plane, main server, master

**Space**:
The place a Project or Thread belongs to: exactly one Organization or one Personal space, never both.
_Avoid_: Scope, area, folder

**Organization**:
A Space shared by its Members. It owns the Projects and Threads created in it and is granted vaults, AI accounts and Environments. Only the Owner creates Organizations.
_Avoid_: Organización, team, workspace, tenant

**Personal space**:
The private Space every user has. Creating in it is a permission; nothing in it is shared directly with others, though the Owner can see it.
_Avoid_: Libre, sin organización, my space, home

**Member**:
A user who belongs to an Organization. A user can be a Member of several Organizations.
_Avoid_: Participant, collaborator

**Role**:
The fixed set of permissions a Member has in one Organization. Each Member has exactly one Role per Organization; Roles are a closed set, not configurable.
_Avoid_: Rol, group, permission set

**Installation permission**:
A permission the Owner grants a user that belongs to no Organization, such as creating in their own Personal space.
_Avoid_: Global role, system permission

**Invitation**:
An offer to join one Organization that the invitee must accept; accepting it creates the user's account if they had none.
_Avoid_: Sign-up, registration

**Environment**:
One running T3 server and the machine, filesystem, credentials and state it owns: a VPS, a desktop, a laptop.
_Avoid_: Entorno, machine, host, runner

**AI account**:
One subscription login (Claude, ChatGPT…) or one API key that only the Owner registers in the Hub and allows Spaces or Users to use.
_Avoid_: Cuenta, provider account, personal AI account, credential

**AI gateway**:
The Hub's single endpoint through which agents reach their AI accounts, so real credentials never leave the Hub.
_Avoid_: Proxy, CLIProxy, router, hub (for this meaning)

**Vault**:
A named set of secrets (tokens, API keys…) stored in the Hub, each under an environment-variable name. Only the Owner creates Vaults and allows them to Spaces or Users.
_Avoid_: Secret store, env file, bóveda

**Main vault**:
The Owner's primary Vault, from which other Vaults link or copy secrets.
_Avoid_: Root vault, principal

**Secret link**:
An entry in one Vault that points to a secret in another Vault, so rotating the original updates every link.
_Avoid_: Export, alias, reference

**Sandbox**:
An Environment the Hub runs on its own machine for exactly one Space, isolated from every other Space. It is where a Space's work runs when no other Environment is chosen.
_Avoid_: Container, VM, workspace, default environment

**External environment**:
Any Environment other than a Sandbox: a machine (PC, laptop, extra VPS) running a T3 server registered with the Hub. It is either personal, used only by the User who registered it in any of their Spaces, or dedicated to one Space and usable by all its Members.
_Avoid_: Remote, host, node, runner

**Thread**:
The durable conversation and work history a user drives with an agent. Every Thread belongs to a Space and its history is stored in the Hub; a Thread without a Project runs in its Space's Sandbox.
_Avoid_: Chat, conversation, session

**Active environment**:
The one Environment a Thread is running in at a given moment. Moving a Thread changes its Active environment.
_Avoid_: Current machine, host

**Project**:
A body of work, with its files and Threads, that belongs to one Space, is not bound to a single Environment and can be continued from different Environments.
_Avoid_: Proyecto, repo, workspace
