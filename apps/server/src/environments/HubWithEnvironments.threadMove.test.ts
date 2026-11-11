// @effect-diagnostics nodeBuiltinImport:off -- the tests read and write files on disk.
import * as NodeFSP from "node:fs/promises";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  MessageId,
  SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as CommandActor from "../auth/CommandActor.ts";
import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMoveService from "../orchestration-v2/ThreadMoveService.ts";
import { makeHub, seedProject, type Hub } from "./HubWithEnvironments.testkit.ts";
import {
  idleAdapters,
  ownerIdOf,
  dispatchMove,
  settledMove,
  readText,
  checkoutOn,
  turnOnLaptop,
} from "./HubWithEnvironments.scenarios.testkit.ts";

describe("Hub con Environments: moving a Thread", () => {
  it.live(
    "its files, manual changes and next turn go to the target, and the timeline says so",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, desktop, threadId, projectId, owner, laptopCheckout } =
          yield* turnOnLaptop({ desktop: true });
        assert.isDefined(desktop);
        const orchestrator = hub.service(Orchestrator.OrchestratorV2);
        const before = yield* orchestrator.getThreadProjection(threadId);
        const laptopSessions = before.providerSessions.map((session) => session.id);
        assert.isNotEmpty(laptopSessions);
        // Typed by hand after the turn: no checkpoint has it yet.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(`${laptopCheckout}/manual.txt`, "typed by hand\n"),
        );

        yield* dispatchMove(hub, {
          commandId: "command:move-to-desktop",
          threadId,
          target: desktop.environmentId,
          actor: owner,
        });
        const moved = yield* settledMove(hub, threadId);
        assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
        assert.equal(moved.activeEnvironmentId, desktop.environmentId);
        assert.equal(moved.move?.continuesFrom?.kind, "final");
        assert.isNotTrue(moved.move?.sourceOffline);

        // The Thread gets its own worktree on the Desktop, with the turn's file and the change
        // made by hand; the Desktop's shared checkout of the Project is left as it was.
        const desktopCheckout = yield* checkoutOn(hub, desktop, projectId);
        assert.notEqual(desktopCheckout, laptopCheckout);
        const worktree = moved.worktreePath;
        assert.isNotNull(worktree);
        assert.notEqual(worktree, desktopCheckout);
        assert.equal(yield* readText(`${worktree}/notes.md`), "Written on the Laptop (turn 1)\n");
        assert.equal(yield* readText(`${worktree}/manual.txt`), "typed by hand\n");
        assert.isFalse(
          yield* Effect.promise(() =>
            NodeFSP.access(`${desktopCheckout}/notes.md`).then(
              () => true,
              () => false,
            ),
          ),
        );

        // The timeline names both machines, who moved it and what it continues from.
        const after = yield* orchestrator.getThreadProjection(threadId);
        const entry = after.turnItems.find((item) => item.type === "environment_move");
        assert.isDefined(entry);
        assert.equal(entry.title, "Moved from Laptop to Desktop");
        if (entry.type === "environment_move") {
          assert.equal(entry.actorUserId, owner);
          assert.equal(entry.continuesFrom.kind, "final");
          assert.isFalse(entry.sourceOffline);
        }
        // The Laptop's sessions are retired; the audit log records the move.
        for (const session of after.providerSessions) {
          assert.notInclude(laptopSessions, session.id);
        }
        const audited = yield* hub.server.sql<{ readonly detail: string }>`
          SELECT detail_json AS detail FROM audit_log WHERE action = 'thread.move'
        `;
        assert.deepEqual(
          audited.map((row) => JSON.parse(row.detail)),
          [
            { from: laptop.environmentId, to: desktop.environmentId, outcome: "started" },
            {
              from: laptop.environmentId,
              to: desktop.environmentId,
              outcome: "switched",
              continuesFrom: "final",
              continuesFromRef: moved.move?.continuesFrom?.ref,
            },
          ],
        );

        // The next turn opens its session on the Desktop.
        const asked = desktop.requests.length;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:after-move"),
          threadId,
          messageId: MessageId.make("message:after-move"),
          text: "Go on from here",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        yield* desktop.awaitRequest("provider.openSession", asked);
        assert.notInclude(
          laptop.requests.slice(laptop.requests.lastIndexOf("checkpoint.push") + 1),
          "provider.openSession",
        );
      }).pipe(Effect.scoped),
  );

  it.live("with its source offline, it continues from the last checkpoint uploaded", () =>
    Effect.gen(function* () {
      const { hub, laptop, desktop, threadId, owner } = yield* turnOnLaptop({
        desktop: true,
      });
      assert.isDefined(desktop);
      yield* laptop.disconnect;

      yield* dispatchMove(hub, {
        commandId: "command:move-offline",
        threadId,
        target: desktop.environmentId,
        actor: owner,
      });
      const moved = yield* settledMove(hub, threadId);
      assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
      assert.isTrue(moved.move?.sourceOffline);
      assert.equal(moved.move?.continuesFrom?.kind, "uploaded");
      assert.equal(moved.move?.continuesFrom?.appRunOrdinal, 1);
      assert.isNotNull(moved.worktreePath);
      assert.equal(
        yield* readText(`${moved.worktreePath}/notes.md`),
        "Written on the Laptop (turn 1)\n",
      );
      const { turnItems } = yield* hub
        .service(Orchestrator.OrchestratorV2)
        .getThreadProjection(threadId);
      const entry = turnItems.find((item) => item.type === "environment_move");
      assert.isTrue(entry?.type === "environment_move" && entry.sourceOffline);
    }).pipe(Effect.scoped),
  );

  it.live("a failed step leaves the Thread on its source, saying which step failed", () =>
    Effect.gen(function* () {
      const { hub, laptop, desktop, threadId, projectId, owner } = yield* turnOnLaptop({
        desktop: true,
      });
      assert.isDefined(desktop);
      // Where the Desktop's checkout goes is a file: nothing is cloned, and git cannot work there.
      const desktopCheckout = yield* checkoutOn(hub, desktop, projectId);
      yield* Effect.promise(() =>
        NodeFSP.mkdir(desktopCheckout.slice(0, desktopCheckout.lastIndexOf("/")), {
          recursive: true,
        }),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(desktopCheckout, "not a checkout\n"));

      yield* dispatchMove(hub, {
        commandId: "command:move-fails",
        threadId,
        target: desktop.environmentId,
        actor: owner,
      });
      const failed = yield* settledMove(hub, threadId);
      assert.equal(failed.move?.status, "failed");
      assert.equal(failed.move?.failure?.step, "fetching");
      assert.include(failed.move?.failure?.message ?? "", desktopCheckout);
      assert.equal(failed.activeEnvironmentId, laptop.environmentId);
      const audited = yield* hub.server.sql<{ readonly detail: string }>`
        SELECT detail_json AS detail FROM audit_log WHERE action = 'thread.move'
      `;
      const failure = JSON.parse(audited.at(-1)?.detail ?? "{}");
      assert.equal(failure.outcome, "failed");
      assert.equal(failure.failedStep, "fetching");
      assert.equal(failure.failureMessage, failed.move?.failure?.message);
      // It can be moved again once the cause is gone; a running move is not stuck.
      assert.equal(
        (yield* hub.service(ProjectionStore.ProjectionStoreV2).getThread(threadId)).move?.status,
        "failed",
      );
    }).pipe(Effect.scoped),
  );

  it.live("only one move of a Thread runs at a time", () =>
    Effect.gen(function* () {
      const { hub, desktop, threadId, owner } = yield* turnOnLaptop({ desktop: true });
      assert.isDefined(desktop);
      const results = yield* Effect.forEach(
        [1, 2],
        (n) =>
          dispatchMove(hub, {
            commandId: `command:move-race-${n}`,
            threadId,
            target: desktop.environmentId,
            actor: owner,
          }).pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      const refused = results.filter((result) => result._tag === "Failure");
      assert.equal(refused.length, 1);
      assert.include(JSON.stringify(refused[0]), "already moving to another Environment");
      const moved = yield* settledMove(hub, threadId);
      assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
    }).pipe(Effect.scoped),
  );

  it.live("only its own User moves a Thread, to a machine they may use and that is online", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub();
      const owner = yield* ownerIdOf(hub);
      const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
      const away = yield* hub.join({
        name: "Away",
        adapters: idleAdapters(instanceId),
        connect: false,
      });
      const member = UserId.make("member-1");
      yield* addMember(hub.server, { id: member, displayName: "Grace Hopper" });
      const graceSpace = SpaceId.make("personal:member-1");
      const projectId = ProjectId.make("project:graces");
      yield* seedProject(hub.server, {
        projectId,
        title: "Grace's",
        defaultModelSelection: null,
        spaceId: graceSpace,
      });
      const orchestrator = hub.service(Orchestrator.OrchestratorV2);
      const threadOf = (threadId: ThreadId, ownerUserId: UserId, spaceId?: SpaceId) =>
        orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:create:${threadId}`),
          threadId,
          projectId: spaceId === undefined ? ProjectId.make("project:owners") : projectId,
          title: "A Thread",
          modelSelection: { instanceId, model: "claude-sonnet-4-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          ...(spaceId === undefined ? {} : { spaceId }),
          ownerUserId,
        });
      yield* seedProject(hub.server, {
        projectId: ProjectId.make("project:owners"),
        title: "Owner's",
        defaultModelSelection: null,
      });
      const graces = ThreadId.make("thread:graces");
      const owners = ThreadId.make("thread:owners");
      yield* threadOf(graces, member, graceSpace);
      yield* threadOf(owners, owner);
      const refusal = <A, E>(result: Effect.Effect<A, E>): Effect.Effect<string> =>
        result.pipe(
          Effect.flip,
          Effect.map((error) => JSON.stringify(error)),
          Effect.orElseSucceed(() => "accepted"),
        );

      // The Owner cannot move another User's Thread, not even to the Owner's own machine.
      const ownerMovesGraces = yield* refusal(
        dispatchMove(hub, {
          commandId: "command:owner-moves-graces",
          threadId: graces,
          target: laptop.environmentId,
          actor: owner,
        }),
      );
      assert.notEqual(ownerMovesGraces, "accepted");
      // Grace cannot move hers onto the Owner's personal machine.
      const graceToLaptop = yield* refusal(
        dispatchMove(hub, {
          commandId: "command:grace-to-laptop",
          threadId: graces,
          target: laptop.environmentId,
          actor: member,
        }),
      );
      assert.include(graceToLaptop, "not-usable");
      // A Guest of the Owner's Space has no move either.
      const guest = UserId.make("guest-1");
      yield* addMember(hub.server, { id: guest, displayName: "Guest" });
      const ownersSpace = (yield* hub.server.sql<{ readonly spaceId: string }>`
        SELECT space_id AS "spaceId" FROM orchestration_v2_projection_threads
        WHERE thread_id = ${owners}
      `)[0]?.spaceId;
      if (ownersSpace !== undefined && ownersSpace !== null) {
        yield* joinOrganization(hub.server, ownersSpace, guest, "guest");
      }
      const guestMoves = yield* refusal(
        dispatchMove(hub, {
          commandId: "command:guest-moves",
          threadId: owners,
          target: laptop.environmentId,
          actor: guest,
        }),
      );
      assert.notEqual(guestMoves, "accepted");
      // The Owner's own Thread does not go to a machine that is offline.
      const toAway = yield* refusal(
        dispatchMove(hub, {
          commandId: "command:to-away",
          threadId: owners,
          target: away.environmentId,
          actor: owner,
        }),
      );
      assert.include(toAway, "offline");
      // Nothing was recorded on either Thread.
      for (const threadId of [graces, owners]) {
        assert.isUndefined(
          (yield* hub.service(ProjectionStore.ProjectionStoreV2).getThread(threadId)).move ??
            undefined,
        );
      }
    }).pipe(Effect.scoped),
  );
});

/** A move recorded on the Thread at `step`, as a running move would have left it. */
const recordMove = Effect.fn(function* (
  hub: Hub,
  input: {
    readonly threadId: ThreadId;
    readonly source: EnvironmentId;
    readonly target: EnvironmentId;
    readonly step: "waiting-for-turn" | "final-checkpoint" | "fetching";
    readonly actor: UserId;
  },
) {
  const thread = yield* hub
    .service(ProjectionStore.ProjectionStoreV2)
    .getThread(input.threadId)
    .pipe(Effect.orDie);
  const at = "2026-01-01T00:00:00.000Z";
  yield* hub.server.eventSink
    .write({
      events: [
        {
          id: EventId.make(`event:recorded-move:${input.step}`),
          type: "thread.move-updated",
          threadId: input.threadId,
          occurredAt: thread.updatedAt,
          payload: {
            ...thread,
            move: {
              id: `command:recorded-move:${input.step}`,
              sourceEnvironmentId: input.source,
              targetEnvironmentId: input.target,
              ifRunning: "wait",
              actorUserId: input.actor,
              step: input.step,
              status: "running",
              startedAt: at,
              updatedAt: at,
            },
          },
        },
      ],
    })
    .pipe(Effect.orDie);
});

const refusalOf = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<string> =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => JSON.stringify(error)),
    Effect.orElseSucceed(() => "accepted"),
  );

describe("Hub con Environments: moving a Thread, the edges", () => {
  it.live("while a move runs, nothing new starts on the machine it leaves", () =>
    Effect.gen(function* () {
      const { hub, laptop, desktop, threadId, owner } = yield* turnOnLaptop({ desktop: true });
      assert.isDefined(desktop);
      yield* recordMove(hub, {
        threadId,
        source: laptop.environmentId,
        target: desktop.environmentId,
        step: "fetching",
        actor: owner,
      });
      const orchestrator = hub.service(Orchestrator.OrchestratorV2);
      const { checkpoints } = yield* orchestrator.getThreadProjection(threadId);
      const checkpoint = checkpoints.find((candidate) => candidate.status === "ready");
      assert.isDefined(checkpoint);
      for (const command of [
        { type: "queue.resume" as const, commandId: CommandId.make("command:resume"), threadId },
        {
          type: "checkpoint.rollback" as const,
          commandId: CommandId.make("command:rollback"),
          threadId,
          scopeId: checkpoint.scopeId,
          checkpointId: checkpoint.id,
        },
      ]) {
        assert.include(
          yield* refusalOf(orchestrator.dispatch(command)),
          "moving to another Environment",
          command.type,
        );
      }
    }).pipe(Effect.scoped),
  );

  it.live("a running move can be cancelled; the Thread stays where it was", () =>
    Effect.gen(function* () {
      const { hub, laptop, desktop, threadId, owner } = yield* turnOnLaptop({ desktop: true });
      assert.isDefined(desktop);
      yield* recordMove(hub, {
        threadId,
        source: laptop.environmentId,
        target: desktop.environmentId,
        step: "fetching",
        actor: owner,
      });
      const orchestrator = hub.service(Orchestrator.OrchestratorV2);
      const afterSequence = yield* hub
        .service(EventSink.EventSinkV2)
        .latestSequence({ threadId })
        .pipe(Effect.orDie);
      yield* hub
        .service(ThreadManagementService.ThreadManagementService)
        .dispatch({
          type: "thread.move.cancel",
          commandId: CommandId.make("command:cancel-move"),
          threadId,
        })
        .pipe(CommandActor.actAs(owner));
      const entry = yield* orchestrator.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
        Stream.filterMap(({ event }) =>
          event.type === "turn-item.updated" && event.payload.type === "environment_move"
            ? Result.succeed(event.payload)
            : Result.failVoid,
        ),
        Stream.runHead,
        Effect.orDie,
      );
      assert.equal(Option.getOrThrow(entry).title, "Move to Desktop cancelled");
      const { thread } = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(thread.move?.status, "cancelled");
      assert.equal(thread.activeEnvironmentId, laptop.environmentId);
      // The audit log has the cancellation, by the User who moved it.
      const audited = yield* hub.server.sql<{ readonly detail: string; readonly actor: string }>`
        SELECT detail_json AS detail, actor_user_id AS actor FROM audit_log
        WHERE action = 'thread.move'
      `;
      assert.deepEqual(
        audited.map((row) => [JSON.parse(row.detail).outcome, row.actor]),
        [["cancelled", owner]],
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "after a restart, a move waits for its source to reconnect before calling it offline",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, desktop, threadId, owner } = yield* turnOnLaptop({ desktop: true });
        assert.isDefined(desktop);
        yield* laptop.disconnect;
        yield* recordMove(hub, {
          threadId,
          source: laptop.environmentId,
          target: desktop.environmentId,
          step: "final-checkpoint",
          actor: owner,
        });
        // As the Hub resumes the moves it finds at startup, before any machine said hello.
        yield* hub.service(ThreadMoveService.ThreadMoves).resume(threadId, { restarted: true });
        yield* laptop.connect;
        const moved = yield* settledMove(hub, threadId);
        assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
        assert.equal(moved.move?.continuesFrom?.kind, "final");
        assert.isNotTrue(moved.move?.sourceOffline);
      }).pipe(Effect.scoped),
  );
});
