/**
 * The Owner disables, re-enables or removes a User. Every write commits in one transaction; once
 * it has, every session and pending link of theirs ends and their open connections close.
 */
import type { InstallationUser, InstallationUserStatus, UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as EnvironmentRegistry from "../environments/EnvironmentRegistry.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ProjectMoveHooks from "../project/ProjectMoveHooks.ts";
import * as VaultReachLoss from "../vaults/VaultReachLoss.ts";
import * as SpaceDirectory from "./SpaceDirectory.ts";

type StatusError =
  | SpaceDirectory.SpaceAccessDeniedError
  | SpaceDirectory.InstallationUserNotFoundError
  | SpaceDirectory.SpaceDirectoryStorageError;

export class InstallationUserService extends Context.Service<
  InstallationUserService,
  {
    /**
     * `disabled` ends their sign-in and keeps their Memberships; `active` lets them sign in again
     * (old sessions stay ended); `removed` also ends their Memberships and freezes their Personal
     * space for the Owner. A removed User stays removed, as a name for what they did.
     */
    readonly setStatus: (input: {
      readonly actorUserId: UserId;
      readonly userId: UserId;
      readonly status: InstallationUserStatus;
    }) => Effect.Effect<InstallationUser, StatusError>;
  }
>()("t3/spaces/InstallationUserService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const sessions = yield* SessionStore.SessionStore;
  const pairingLinks = yield* PairingGrantStore.PairingGrantStore;
  const audit = yield* AuditLog.AuditLog;
  const environments = yield* EnvironmentRegistry.EnvironmentRegistry;
  // The orchestration's work, registered late; absent where nothing runs Threads.
  const moveHooks = yield* Effect.serviceOption(ProjectMoveHooks.ProjectMoveHooks);
  const storageError = (cause: unknown) => new SpaceDirectory.SpaceDirectoryStorageError({ cause });

  const writeStatus = Effect.fn("InstallationUserService.writeStatus")(function* (
    userId: UserId,
    status: InstallationUserStatus,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    if (status === "active") {
      yield* sql`UPDATE users SET disabled_at = NULL WHERE user_id = ${userId}`;
      return;
    }
    yield* sql`
      UPDATE users SET disabled_at = COALESCE(disabled_at, ${now}),
        removed_at = ${status === "removed" ? now : null}
      WHERE user_id = ${userId}
    `;
    // Reset links the Owner gave them stop working with their sign-in.
    yield* sql`
      UPDATE user_reset_links SET expires_at = ${now}
      WHERE user_id = ${userId} AND used_at IS NULL AND expires_at > ${now}
    `;
    yield* spaces.endAccessOf({ userId, removed: status === "removed" });
  }, Effect.mapError(storageError));

  /** Shells started for a removed User close on their machines: the orchestration's work. */
  const reconcileTerminals = Effect.gen(function* () {
    if (Option.isNone(moveHooks)) return;
    const work = yield* moveHooks.value.current;
    if (work !== undefined) yield* work.reconcileTerminals;
  });

  const setStatus: InstallationUserService["Service"]["setStatus"] = Effect.fn(
    "InstallationUserService.setStatus",
  )(function* ({ actorUserId, userId, status }) {
    const action = status === "removed" ? "user.remove" : "user.disable";
    // The check, the status, and the revocation of every session (browser, app, outside MCP
    // client, CLI bearer) and pairing link commit together. Asking again for the status they
    // already have runs the revocation again, so a retry always finishes the job.
    const outcome = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* spaces.authorizeUserChange({ actorUserId, action, userId });
          if (current.status === "removed" && status !== "removed") {
            return yield* new SpaceDirectory.SpaceAccessDeniedError({
              action,
              reason: "user-removed",
            });
          }
          const changed = current.status !== status;
          if (changed) {
            yield* audit
              .record({
                actor: AuditLog.userActor(actorUserId),
                action: status === "active" ? "user.enable" : action,
                target: { kind: "user", id: userId },
                detail: { from: current.status },
              })
              .pipe(Effect.mapError(storageError));
          }
          if (status === "active") {
            if (changed) yield* writeStatus(userId, status);
            return { changed, announce: Effect.void };
          }
          if (changed && current.status !== "removed") yield* writeStatus(userId, status);
          // A removed User's own Vault allowances go (spec 5 ticket 07); a disabled one keeps
          // them, unused while they cannot sign in.
          if (status === "removed") {
            yield* VaultReachLoss.forgetUser(sql, AuditLog.userActor(actorUserId), {
              userId,
              displayName: current.displayName,
            }).pipe(Effect.mapError(storageError));
          }
          // Their machines go with their sign-in, and stay revoked if they come back.
          const disconnect = yield* environments
            .revokeOwnedBy({ userId, actor: AuditLog.userActor(actorUserId) })
            .pipe(Effect.mapError(storageError));
          const announceSessions = yield* sessions
            .revokeAllForUserDeferred(userId)
            .pipe(Effect.mapError(storageError));
          const announceLinks = yield* pairingLinks
            .revokeAllForUserDeferred(userId)
            .pipe(Effect.mapError(storageError));
          // No cached principal outlives the commit, even if the work after it fails.
          yield* spaces.changed;
          return {
            changed,
            announce: Effect.andThen(announceSessions, announceLinks).pipe(
              Effect.andThen(disconnect),
            ),
          };
        }),
      )
      .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
    if (status === "active") {
      if (outcome.changed) yield* spaces.changed;
    } else {
      yield* outcome.announce;
      yield* spaces.membershipsChanged([userId]);
    }
    // Every shell started with their set, in whoever's Thread, closes (spec 5 ticket 07).
    if (status === "removed") yield* reconcileTerminals;
    yield* spaces.userStatusChanged({ userId, active: status === "active" });
    return yield* spaces.installationUser(userId).pipe(
      Effect.flatMap(Effect.fromOption),
      Effect.catchTags({
        NoSuchElementError: () =>
          Effect.fail(new SpaceDirectory.InstallationUserNotFoundError({ userId })),
      }),
    );
  });

  return InstallationUserService.of({ setStatus });
});

export const layer = Layer.effect(InstallationUserService, make).pipe(
  Layer.provide(AuditLog.layer),
  Layer.provide(EnvironmentRegistry.layer),
);
