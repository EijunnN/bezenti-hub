/**
 * Whether this server's own machine runs agents. A Hub's (the Hub machine) does only in
 * development (`T3CODE_HUB_RUNS_AGENTS`); a joined machine's always does: that is its job. The
 * server provides it from its config; anything that does not (tests, orchestration-only hosts)
 * keeps the in-process executor running agents. See docs/internals/sandboxes.md.
 */
import { HUB_RUNS_NO_AGENTS_MESSAGE } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

export const HubRunsAgents = Context.Reference<boolean>("t3/environment/HubRunsAgents", {
  defaultValue: () => true,
});

/** What the Hub machine answers for work it no longer runs: sessions, terminals, writes. */
export class HubRunsNoAgentsError extends Schema.TaggedError<HubRunsNoAgentsError>()(
  "HubRunsNoAgentsError",
  { operation: Schema.String },
) {
  override get message(): string {
    return HUB_RUNS_NO_AGENTS_MESSAGE;
  }
}
