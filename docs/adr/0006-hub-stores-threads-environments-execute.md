# The Hub stores Threads; Environments only execute

Upstream T3 Code keeps each Thread's durable state (projections in `statev2.sqlite`, checkpoint refs, attachments) inside the Environment that runs it, so a Thread can never leave its machine. Because a Project must be continuable from any Environment and an Organization's Members must see its Threads even when the machine that ran them is off, the Hub becomes the store of Thread history: Environments execute turns and stream their events, messages and checkpoints to the Hub, and a Thread is active in exactly one Environment at a time. Project files travel through a git repository the Hub keeps per Project: after every turn the active Environment pushes that turn's checkpoint, and an Environment taking over fetches the latest one, so moving works even when the previous Environment is offline.

## Considered Options

- Copy a Thread's projections to the new Environment on each move: keeps upstream's model, but a Thread disappears for everyone while its machine is off.
- Peer Links (remote access to the original Environment): no copy, but the Thread stays bound to one machine.
- Live file sync (Mutagen, Syncthing): requires excluding `.git`, which loses checkpoints.

## Consequences

This is the deepest departure from upstream: orchestration persistence moves from each Environment to the Hub, and it is the largest piece of implementation work in this fork.
