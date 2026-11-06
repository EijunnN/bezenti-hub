import { useAtomValue } from "@effect/atom-react";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type HubEnvironmentSummary,
  type OrchestrationV2ThreadMove,
  type OrchestrationV2ThreadMoveStep,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ArrowRightLeftIcon } from "lucide-react";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import {
  ENVIRONMENT_STATUS_LABELS,
  activeEnvironmentOf,
  environmentUnavailableReason,
  useHubEnvironments,
} from "~/environments/primary/useHubEnvironments";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readProject, useThreadShell } from "~/state/entities";
import { environmentServerConfigsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { EnvironmentStatusDot } from "../EnvironmentStatusDot";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";

/** Which Thread has the move dialog open; the menus close as their command runs. */
const moveThreadDialogAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("thread-move:dialog-thread"),
);

export function openMoveThreadDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(moveThreadDialogAtom, threadRef);
}

/** What each step of a move is doing, as the Thread and the dialog say it. */
const MOVE_STEP_LABELS: Record<OrchestrationV2ThreadMoveStep, string> = {
  "waiting-for-turn": "Finishing the turn",
  "final-checkpoint": "Uploading a final checkpoint",
  fetching: "Fetching the checkpoint",
  preparing: "Preparing the workspace",
  handoff: "Handing over",
  switched: "Ready",
};

const MOVE_STEPS: ReadonlyArray<OrchestrationV2ThreadMoveStep> = [
  "waiting-for-turn",
  "final-checkpoint",
  "fetching",
  "preparing",
  "handoff",
  "switched",
];

const nameOf = (
  environments: ReadonlyArray<HubEnvironmentSummary>,
  environmentId: EnvironmentId | null | undefined,
) =>
  environmentId === null
    ? "no Environment"
    : (environments.find((environment) => environment.id === environmentId)?.name ??
      (environmentId === undefined || environmentId === HUB_MACHINE_ENVIRONMENT_ID
        ? "Hub machine"
        : "another Environment"));

/** What the move is doing now; a turn waiting on the User says so, since the move waits too. */
const stepLabel = (move: OrchestrationV2ThreadMove) =>
  move.step === "waiting-for-turn" && move.waitingOn === "user"
    ? "Waiting for your answer in the running turn"
    : MOVE_STEP_LABELS[move.step];

/** Cancels the Thread's running move; resolves to an error message, or null when it went. */
function useCancelMove(threadRef: ScopedThreadRef) {
  const cancel = useOrchestrationCommand(threadEnvironment.cancelMove, { reportFailure: false });
  return async (): Promise<string | null> => {
    const result = await cancel({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
    const error = squashAtomCommandFailure(result);
    return error instanceof Error ? error.message : "The move could not be cancelled.";
  };
}

/** «Moving to Desktop: Fetching the checkpoint» in the Thread's header while a move runs. */
export function ThreadMoveBadge({
  move,
  threadRef,
}: {
  readonly move: OrchestrationV2ThreadMove | null;
  readonly threadRef: ScopedThreadRef;
}) {
  const environments = useHubEnvironments();
  const cancel = useCancelMove(threadRef);
  if (move === null || move.status !== "running") return null;
  const label = `Moving to ${nameOf(environments, move.targetEnvironmentId)}: ${stepLabel(move)}`;
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="info" size="sm" role="status" aria-label={label} data-move-step={move.step}>
        <ArrowRightLeftIcon aria-hidden className="size-3" />
        {label}
      </Badge>
      <Button size="xs" variant="ghost" onClick={() => void cancel()}>
        Cancel move
      </Button>
    </span>
  );
}

export function MoveThreadDialogHost() {
  const threadRef = useAtomValue(moveThreadDialogAtom);
  if (threadRef === null) return null;
  return (
    <MoveThreadDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(moveThreadDialogAtom, null)}
    />
  );
}

type SendState =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | { readonly status: "sent"; readonly moveStartedAfter: string | null }
  | { readonly status: "refused"; readonly message: string };

function MoveThreadDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const thread = useThreadShell(threadRef);
  const environments = useHubEnvironments();
  const move = useOrchestrationCommand(threadEnvironment.move, { reportFailure: false });
  const cancelMove = useCancelMove(threadRef);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [target, setTarget] = useState<EnvironmentId | null>(null);
  const [ifRunning, setIfRunning] = useState<"wait" | "stop">("wait");
  const [send, setSend] = useState<SendState>({ status: "idle" });

  const serverConfig = useAtomValue(environmentServerConfigsAtom).get(threadRef.environmentId);
  const project =
    thread === null
      ? null
      : readProject({ environmentId: threadRef.environmentId, projectId: thread.projectId });
  // A Thread without a Project moves its own folder: no worktree, no setup script.
  const withoutProject =
    project !== null && isScratchProject(project, serverConfig?.scratchWorkspaceRoot);
  const sourceId = thread?.activeEnvironmentId;
  const sourceName = nameOf(environments, sourceId);
  const currentMove = thread?.move ?? null;
  // The move this dialog started: the Thread's move once it began after the dialog sent it.
  const ownMove =
    send.status === "sent" &&
    currentMove !== null &&
    (send.moveStartedAfter === null || currentMove.id !== send.moveStartedAfter)
      ? currentMove
      : null;
  const shownMove = ownMove ?? (currentMove?.status === "running" ? currentMove : null);
  const turnRunning = thread !== null && threadRuntimeIsActive(thread.runtime);
  // A Thread whose Environment was removed (null) runs nowhere: every Environment is a target.
  const candidates = environments.filter(
    (environment) =>
      environment.id !== (sourceId === undefined ? HUB_MACHINE_ENVIRONMENT_ID : sourceId),
  );
  const source = activeEnvironmentOf(environments, sourceId);
  const sourceAway = source !== null && !source.isHubMachine && source.status !== "online";
  const providerInstanceId = thread?.modelSelection.instanceId;
  const reasonOf = (environment: HubEnvironmentSummary) =>
    providerInstanceId === undefined
      ? null
      : environmentUnavailableReason(environment, providerInstanceId);
  const targetName = nameOf(environments, shownMove?.targetEnvironmentId ?? target);
  // Once the move switched, the Thread's own Environment is the target: name the one it left.
  const movedFromName =
    shownMove === null ? sourceName : nameOf(environments, shownMove.sourceEnvironmentId);

  const submit = async () => {
    if (target === null) return;
    setSend({ status: "sending" });
    const result = await move({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, targetEnvironmentId: target, ifRunning },
    });
    if (result._tag === "Success") {
      setSend({ status: "sent", moveStartedAfter: currentMove?.id ?? null });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setSend({ status: "idle" });
      return;
    }
    const error = squashAtomCommandFailure(result);
    setSend({
      status: "refused",
      message: error instanceof Error ? error.message : "The Thread could not be moved.",
    });
  };

  const running = shownMove?.status === "running";
  // Sent, and the Thread's stream has not brought the move yet.
  const starting = send.status === "sent" && shownMove === null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && send.status !== "sending") onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Move to another Environment</DialogTitle>
          {sourceId === null && shownMove === null ? (
            <DialogDescription>
              The machine this Thread ran on was removed. The Thread keeps its history and goes on
              on the machine you choose, from the last checkpoint it uploaded.
            </DialogDescription>
          ) : (
            <DialogDescription>
              The Thread keeps its history and goes on running on the machine you choose. If{" "}
              {movedFromName} is online, it first uploads a final checkpoint with any changes made
              by hand.{" "}
              {withoutProject
                ? "The new machine fetches it into the Thread's own folder there, with the folder's branches; repositories nested in the folder stay behind."
                : "The new machine fetches it into a worktree of the Thread's own, with its branch, and runs the Project's setup script there, which also rebuilds ignored files such as dependencies."}{" "}
              If {movedFromName} is offline, the Thread continues from the last checkpoint it
              uploaded, and changes it kept are put on a separate branch when it comes back.
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            {starting ? (
              <p role="status" className="text-sm">
                Starting the move…
              </p>
            ) : shownMove === null ? (
              <>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-2 font-medium text-sm">Environment</legend>
                  {candidates.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      No other Environment you can use is joined to this Hub.
                    </p>
                  ) : (
                    <RadioGroup
                      aria-label="Environment"
                      value={target ?? ""}
                      onValueChange={(value) => setTarget(value as EnvironmentId)}
                    >
                      {candidates.map((environment) => {
                        const reason = reasonOf(environment);
                        const status = environment.kind === "hub" ? "online" : environment.status;
                        const label = `${environment.name}, ${
                          reason ?? ENVIRONMENT_STATUS_LABELS[status]
                        }`;
                        return (
                          <label
                            key={environment.id}
                            className="flex items-center gap-2 text-sm data-disabled:opacity-60"
                            data-disabled={reason === null ? undefined : ""}
                          >
                            <Radio
                              value={environment.id}
                              disabled={reason !== null}
                              aria-label={label}
                            />
                            <EnvironmentStatusDot status={status} />
                            <span className="font-medium">{environment.name}</span>
                            <span className="text-muted-foreground">
                              {reason ?? ENVIRONMENT_STATUS_LABELS[status]}
                            </span>
                          </label>
                        );
                      })}
                    </RadioGroup>
                  )}
                </fieldset>
                {turnRunning ? (
                  <fieldset className="flex flex-col gap-2">
                    <legend className="mb-2 font-medium text-sm">A turn is running</legend>
                    {sourceAway ? (
                      <p className="text-muted-foreground text-sm">
                        The turn is paused: {sourceName} is offline. Waiting means the move waits
                        for {sourceName} to come back; stopping the turn moves the Thread now.
                      </p>
                    ) : null}
                    <RadioGroup
                      aria-label="A turn is running"
                      value={ifRunning}
                      onValueChange={(value) => setIfRunning(value as "wait" | "stop")}
                    >
                      <label className="flex items-center gap-2 text-sm">
                        <Radio value="wait" aria-label="Wait for the turn to finish" />
                        Wait for the turn to finish
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <Radio value="stop" aria-label="Stop the turn" />
                        Stop the turn
                      </label>
                    </RadioGroup>
                  </fieldset>
                ) : null}
                {send.status === "refused" ? (
                  <p role="alert" className="text-destructive text-sm">
                    {send.message}
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <MoveProgress move={shownMove} sourceName={movedFromName} targetName={targetName} />
                {cancelError === null ? null : (
                  <p role="alert" className="text-destructive text-sm">
                    {cancelError}
                  </p>
                )}
              </>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          {shownMove === null && !starting ? (
            <>
              <Button variant="outline" onClick={onClose} disabled={send.status === "sending"}>
                Cancel
              </Button>
              <Button
                onClick={() => void submit()}
                disabled={target === null || send.status === "sending"}
              >
                {send.status === "sending" ? <Spinner /> : null}
                Move Thread
              </Button>
            </>
          ) : (
            <>
              {running ? (
                <Button
                  variant="destructive-outline"
                  onClick={() => void cancelMove().then(setCancelError)}
                >
                  Cancel move
                </Button>
              ) : null}
              <Button variant={running ? "outline" : "default"} onClick={onClose}>
                {running ? "Hide" : "Done"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function MoveProgress({
  move,
  sourceName,
  targetName,
}: {
  readonly move: OrchestrationV2ThreadMove;
  readonly sourceName: string;
  readonly targetName: string;
}) {
  const current = MOVE_STEPS.indexOf(
    move.status === "failed" ? (move.failure?.step ?? move.step) : move.step,
  );
  const summary =
    move.status === "switched"
      ? `Moved to ${targetName}.`
      : move.status === "failed"
        ? `The move stopped at «${MOVE_STEP_LABELS[move.failure?.step ?? move.step]}». The Thread stays on ${sourceName}.`
        : move.status === "cancelled"
          ? `The move was cancelled. The Thread stays on ${sourceName}.`
          : `Moving to ${targetName}: ${stepLabel(move)}`;
  const continuesFrom =
    move.continuesFrom === undefined
      ? null
      : move.continuesFrom.kind === "final"
        ? "It continues from a final checkpoint, with the changes made by hand."
        : move.continuesFrom.kind === "uploaded"
          ? `${sourceName} was offline: it continues from the checkpoint of turn ${move.continuesFrom.appRunOrdinal ?? "?"}, the last one uploaded.`
          : `${sourceName} was offline and never uploaded a checkpoint: it continues from the Project as it is on ${targetName}.`;
  return (
    <div className="flex flex-col gap-3">
      <p role="status" aria-live="polite" className="font-medium text-sm">
        {summary}
      </p>
      <ol aria-label="Move progress" className="flex flex-col gap-1.5 text-sm">
        {MOVE_STEPS.map((step, index) => {
          const state =
            move.status === "switched" || index < current
              ? "done"
              : index === current
                ? move.status === "failed"
                  ? "failed"
                  : "current"
                : "pending";
          return (
            <li
              key={step}
              data-state={state}
              aria-current={state === "current" ? "step" : undefined}
              className={
                state === "pending"
                  ? "text-muted-foreground"
                  : state === "failed"
                    ? "text-destructive"
                    : undefined
              }
            >
              {state === "done"
                ? "✓ "
                : state === "failed"
                  ? "✕ "
                  : state === "current"
                    ? "… "
                    : "· "}
              {MOVE_STEP_LABELS[step]}
              {step === "final-checkpoint" && move.sourceOffline === true
                ? ` (skipped: ${sourceName} was offline)`
                : null}
            </li>
          );
        })}
      </ol>
      {continuesFrom === null ? null : (
        <p className="text-muted-foreground text-sm">{continuesFrom}</p>
      )}
      {move.status === "failed" && move.failure !== undefined ? (
        <p role="alert" className="whitespace-pre-wrap text-destructive text-sm">
          {move.failure.message}
        </p>
      ) : null}
      {move.setAsideRefs !== undefined && move.setAsideRefs.length > 0 ? (
        <p className="text-muted-foreground text-sm">
          What {targetName} had in the workspace is kept in {move.setAsideRefs.join(", ")}.
        </p>
      ) : null}
    </div>
  );
}
