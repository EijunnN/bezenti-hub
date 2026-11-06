/**
 * Ends a Thread's unfinished turns on the Hub alone, for a machine that can't be reached to stop
 * them (offline, or removed): each is marked interrupted with `reason`, as Force stop does, and
 * nothing is sent to the machine. A machine that returns with the session drops it.
 */
import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type * as Orchestrator from "./Orchestrator.ts";

const UNFINISHED: ReadonlySet<string> = new Set(["preparing", "starting", "running", "waiting"]);

export const interruptRunsOnHub = Effect.fn("HubRunInterrupt.interruptRunsOnHub")(
  function* (
    orchestrator: Orchestrator.OrchestratorV2["Service"],
    input: { readonly threadId: ThreadId; readonly reason: string; readonly key: string },
  ) {
    const records = yield* orchestrator.getThreadRecords(input.threadId, ["runs", "providerTurns"]);
    const at = yield* Clock.currentTimeMillis;
    for (const run of records.runs) {
      if (!UNFINISHED.has(run.status)) continue;
      const providerTurn = records.providerTurns.findLast(
        (turn) => turn.runAttemptId === run.activeAttemptId && turn.status === "running",
      );
      const commandId = CommandId.make(`server:${input.key}:${run.id}:${at}`);
      yield* (
        providerTurn === undefined
          ? orchestrator.dispatch({
              type: "run.interrupt",
              commandId,
              threadId: input.threadId,
              runId: run.id,
              reason: input.reason,
            })
          : orchestrator.dispatch({
              type: "thread.background-work.settle",
              commandId,
              threadId: input.threadId,
              providerThreadId: providerTurn.providerThreadId,
              providerTurnId: providerTurn.id,
              reason: input.reason,
            })
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not end a turn on the Hub", {
            threadId: input.threadId,
            runId: run.id,
            cause,
          }),
        ),
      );
    }
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Could not end a Thread's turns on the Hub", { cause }),
  ),
);
