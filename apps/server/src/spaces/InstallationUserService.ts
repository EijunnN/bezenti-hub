/**
 * The Owner disables, re-enables or removes a User. Every write commits in one transaction; once
 * it has, every session and pending link of theirs ends and their open connections close.
 */
import type { InstallationUser, InstallationUserStatus, UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
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

  /** Every session (browser, app, outside MCP client, CLI bearer) and pairing link ends. */
  const endSignIn = (userId: UserId) =>
    sessions
      .revokeAllForUser(userId)
      .pipe(Effect.andThen(pairingLinks.revokeAllForUser(userId)), Effect.mapError(storageError));

  const setStatus: InstallationUserService["Service"]["setStatus"] = Effect.fn(
    "InstallationUserService.setStatus",
  )(function* ({ actorUserId, userId, status }) {
    const action = status === "removed" ? "user.remove" : "user.disable";
    // The check and the writes share one transaction, so a concurrent change cannot slip between.
    const changed = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* spaces.authorizeUserChange({ actorUserId, action, userId });
          if (current.status === "removed") {
            if (status === "removed") return false;
            return yield* new SpaceDirectory.SpaceAccessDeniedError({
              action,
              reason: "user-removed",
            });
          }
          if (current.status === status) return false;
          yield* writeStatus(userId, status);
          return true;
        }),
      )
      .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
    if (changed) {
      if (status === "active") {
        yield* spaces.changed;
      } else {
        yield* endSignIn(userId);
        yield* spaces.membershipsChanged([userId]);
      }
      // The audit log (ticket 14) records this action here.
      yield* Effect.logInfo("Changed a User's status.").pipe(
        Effect.annotateLogs({
          action: status === "active" ? "user.enable" : action,
          actorUserId,
          userId,
        }),
      );
    }
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

export const layer = Layer.effect(InstallationUserService, make);
