import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SecretMasker from "../vaults/SecretMasker.ts";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PullRequestReviewGuide, ThreadPullRequestKey, type UserId } from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type PullRequestReviewGuideRepositoryError,
} from "./Errors.ts";

const GuideRow = Schema.Struct({
  guide: Schema.fromJsonString(PullRequestReviewGuide),
});

export class PullRequestReviewGuideRepository extends Context.Service<
  PullRequestReviewGuideRepository,
  {
    readonly get: (
      key: ThreadPullRequestKey,
    ) => Effect.Effect<
      Option.Option<PullRequestReviewGuide>,
      PullRequestReviewGuideRepositoryError
    >;
    /**
     * Stores a guide masked with the values of the User who generated it (spec 5 ticket 05); with
     * none known, as written. Values that cannot be read hide its text.
     */
    readonly put: (
      key: ThreadPullRequestKey,
      guide: PullRequestReviewGuide,
      generatedBy?: Option.Option<UserId>,
    ) => Effect.Effect<void, PullRequestReviewGuideRepositoryError>;
  }
>()("t3/persistence/PullRequestReviewGuides/PullRequestReviewGuideRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const masker = yield* Effect.serviceOption(SecretMasker.SecretMasker);

  const findGuide = SqlSchema.findOneOption({
    Request: ThreadPullRequestKey,
    Result: GuideRow,
    execute: ({ host, repository, number }) =>
      sql`
        SELECT guide_json AS "guide"
        FROM pull_request_review_guides
        WHERE host = ${host} AND repository = ${repository} AND number = ${number}
      `,
  });
  const encodeGuide = Schema.encodeEffect(Schema.fromJsonString(PullRequestReviewGuide));

  return PullRequestReviewGuideRepository.of({
    get: Effect.fn("PullRequestReviewGuideRepository.get")(function (key) {
      return findGuide(key).pipe(
        NodeSqliteClient.readOnly,
        Effect.map(Option.map((row) => row.guide)),
        Effect.mapError((cause) =>
          Schema.isSchemaError(cause)
            ? PersistenceDecodeError.fromSchemaError("PullRequestReviewGuide", cause)
            : new PersistenceSqlError({ operation: "getPullRequestReviewGuide", cause }),
        ),
      );
    }),
    put: Effect.fn("PullRequestReviewGuideRepository.put")(function (key, unmasked, generatedBy) {
      // Spec 5 ticket 05: stored with the generating User's values as `[NAME]` (and masked again
      // for each viewer when read).
      const user = generatedBy ?? Option.none();
      return (
        Option.isNone(masker) || Option.isNone(user)
          ? Effect.succeed(unmasked)
          : // Values that cannot be read: not stored (the generation fails, and can be run again).
            masker.value.forUser(user.value).pipe(
              Effect.map((found) => found.maskDeep(unmasked)),
              Effect.orDie,
            )
      ).pipe(
        Effect.flatMap(encodeGuide),
        Effect.mapError((cause) =>
          PersistenceDecodeError.fromSchemaError("PullRequestReviewGuide", cause),
        ),
        Effect.flatMap((guideJson) =>
          sql`
            INSERT INTO pull_request_review_guides (host, repository, number, guide_json)
            VALUES (${key.host}, ${key.repository}, ${key.number}, ${guideJson})
            ON CONFLICT (host, repository, number) DO UPDATE SET guide_json = excluded.guide_json
          `.pipe(
            Effect.mapError(
              (cause) => new PersistenceSqlError({ operation: "putPullRequestReviewGuide", cause }),
            ),
          ),
        ),
        Effect.asVoid,
      );
    }),
  });
});

export const layer = Layer.effect(PullRequestReviewGuideRepository, make);
