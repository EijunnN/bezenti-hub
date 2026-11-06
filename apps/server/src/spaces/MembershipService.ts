/**
 * Who is in an Organization and with which Role. Each write and the session changes it causes
 * commit in one transaction; once committed, the affected Users' open connections close, so
 * their clients reload exactly what they may still see.
 */
import type {
  ChangeMemberRoleResult,
  MemberList,
  MemberResetLink,
  SpaceDirectoryView,
  SpaceId,
  SpaceRole,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as UserDirectory from "../auth/UserDirectory.ts";
import * as SpaceDirectory from "./SpaceDirectory.ts";

/** Refused, or the Organization is missing or hidden from the actor (alike). */
export class MembershipRefusedError extends Schema.TaggedError<MembershipRefusedError>()(
  "MembershipRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class MembershipStorageError extends Schema.TaggedError<MembershipStorageError>()(
  "MembershipStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read or write Memberships.";
  }
}

type MembershipError = MembershipRefusedError | MembershipStorageError;

export class MembershipService extends Context.Service<
  MembershipService,
  {
    readonly list: (actor: UserId, spaceId: SpaceId) => Effect.Effect<MemberList, MembershipError>;
    /** A new Admin who signs in with only a password is signed out until they add a second factor. */
    readonly changeRole: (input: {
      readonly actor: UserId;
      readonly spaceId: SpaceId;
      readonly userId: UserId;
      readonly role: SpaceRole;
    }) => Effect.Effect<ChangeMemberRoleResult, MembershipError>;
    /** What they created stays in the Organization. */
    readonly remove: (input: {
      readonly actor: UserId;
      readonly spaceId: SpaceId;
      readonly userId: UserId;
    }) => Effect.Effect<MemberList, MembershipError>;
    /** What they created stays in the Organization. */
    readonly leave: (
      actor: UserId,
      spaceId: SpaceId,
    ) => Effect.Effect<SpaceDirectoryView, MembershipError>;
    readonly issueResetLink: (input: {
      readonly actor: UserId;
      readonly spaceId: SpaceId;
      readonly userId: UserId;
    }) => Effect.Effect<MemberResetLink, MembershipError>;
  }
>()("t3/spaces/MembershipService") {}

const NOT_FOUND = "That Organization does not exist.";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const users = yield* UserDirectory.UserDirectory;

  const storageError = (cause: unknown) => new MembershipStorageError({ cause });
  const refused = (reason: string) => new MembershipRefusedError({ reason });
  /** A hidden Organization is refused exactly like a missing one. */
  const refusal = (
    error:
      | SpaceDirectory.SpaceAccessDeniedError
      | SpaceDirectory.SpaceNotFoundError
      | SpaceDirectory.SpaceDirectoryStorageError,
  ): MembershipError => {
    switch (error._tag) {
      case "SpaceAccessDeniedError":
        return refused(error.message);
      case "SpaceNotFoundError":
        return refused(NOT_FOUND);
      case "SpaceDirectoryStorageError":
        return storageError(error);
    }
  };

  /** Runs the writes in one transaction, then tells the Users' connections once it committed. */
  const commit = <A>(
    userIds: ReadonlyArray<UserId>,
    writes: Effect.Effect<A, MembershipError | SpaceDirectory.SpaceDirectoryStorageError>,
  ) =>
    sql.withTransaction(writes).pipe(
      Effect.mapError((error): MembershipError =>
        error._tag === "MembershipRefusedError" || error._tag === "MembershipStorageError"
          ? error
          : storageError(error),
      ),
      Effect.tap(() => spaces.membershipsChanged(userIds)),
    );

  const list: MembershipService["Service"]["list"] = Effect.fn("MembershipService.list")(
    function* (actor, spaceId) {
      return yield* spaces.members(actor, spaceId).pipe(Effect.mapError(refusal));
    },
  );

  const memberOrFail = (actor: UserId, spaceId: SpaceId, userId: UserId) =>
    list(actor, spaceId).pipe(
      Effect.flatMap((listed) => {
        const member = listed.members.find((candidate) => candidate.userId === userId);
        return member === undefined
          ? Effect.fail(storageError("membership vanished after the change"))
          : Effect.succeed(member);
      }),
    );

  const changeRole: MembershipService["Service"]["changeRole"] = Effect.fn(
    "MembershipService.changeRole",
  )(function* ({ actor, spaceId, userId, role }) {
    if (actor === userId) {
      return yield* new MembershipRefusedError({
        reason: "You can't change your own Role. Ask the Owner, or leave the Organization.",
      });
    }
    // The check and the writes share one transaction, so a concurrent change cannot slip between.
    const mustSetUpStrongSignIn = yield* commit(
      [userId],
      Effect.gen(function* () {
        const current = yield* spaces
          .authorizeMembership({
            actor,
            action: "membership.changeRole",
            spaceId,
            target: userId,
            nextRole: role,
          })
          .pipe(Effect.mapError(refusal));
        if (current === role) return false;
        yield* spaces.setRole({ spaceId, userId, role });
        // Admins sign in with a passkey, or a password plus an authenticator app.
        return role === "admin"
          ? yield* users.requireStrongSignInNext(userId).pipe(Effect.mapError(storageError))
          : false;
      }),
    );
    return { member: yield* memberOrFail(actor, spaceId, userId), mustSetUpStrongSignIn };
  });

  const remove: MembershipService["Service"]["remove"] = Effect.fn("MembershipService.remove")(
    function* ({ actor, spaceId, userId }) {
      if (actor === userId) {
        return yield* new MembershipRefusedError({
          reason: "To remove yourself, leave the Organization.",
        });
      }
      yield* commit(
        [userId],
        spaces
          .authorizeMembership({ actor, action: "membership.remove", spaceId, target: userId })
          .pipe(
            Effect.mapError(refusal),
            Effect.andThen(spaces.removeMembership({ spaceId, userId })),
          ),
      );
      return yield* list(actor, spaceId);
    },
  );

  const leave: MembershipService["Service"]["leave"] = Effect.fn("MembershipService.leave")(
    function* (actor, spaceId) {
      yield* commit(
        [actor],
        spaces
          .authorizeMembership({ actor, action: "membership.leave", spaceId, target: actor })
          .pipe(
            // Not a Member, or the Owner, who belongs to no Organization: nothing to leave.
            Effect.mapError((error) =>
              error._tag === "SpaceAccessDeniedError"
                ? refused("You're not in this Organization.")
                : refusal(error),
            ),
            Effect.andThen(spaces.removeMembership({ spaceId, userId: actor })),
          ),
      );
      return yield* spaces.view(actor).pipe(Effect.mapError(storageError));
    },
  );

  const issueResetLink: MembershipService["Service"]["issueResetLink"] = Effect.fn(
    "MembershipService.issueResetLink",
  )(function* ({ actor, spaceId, userId }) {
    if (actor === userId) {
      return yield* new MembershipRefusedError({
        reason: "Change your own sign-in under Settings → Access.",
      });
    }
    yield* spaces
      .authorizeMembership({ actor, action: "membership.resetLink", spaceId, target: userId })
      .pipe(Effect.mapError(refusal));
    const link = yield* users
      .issueResetLink({ userId, createdBy: actor })
      .pipe(Effect.mapError(storageError));
    if (Option.isNone(link)) {
      return yield* new MembershipRefusedError({ reason: "This account cannot sign in." });
    }
    return link.value;
  });

  return MembershipService.of({ list, changeRole, remove, leave, issueResetLink });
});

export const layer = Layer.effect(MembershipService, make);
