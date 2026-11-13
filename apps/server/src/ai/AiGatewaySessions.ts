/**
 * Spec 4 ticket 06: the one rule for a provider session on the Hub's AI gateway: whether it goes
 * through it, its AI account, and its key for the Thread's turn owner (SecretDelivery's rule),
 * revoked with the session. docs/internals/ai-gateway.md, «Agents through the gateway».
 */
import {
  AI_GATEWAY_CONTRACT_VERSION,
  AI_GATEWAY_DRIVERS,
  type AiGatewayAccess,
  AiGatewaySessionError,
  type EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderSessionAiAccount,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";

import { threadTurnOwner } from "../orchestration-v2/threadTurnOwner.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as AiGatewayActivity from "./AiGatewayActivity.ts";
import * as AiGatewayKeys from "./AiGatewayKeys.ts";
import * as AllowedAiAccounts from "./AllowedAiAccounts.ts";

/** The machine a session's process starts on, and its executor contract. */
export interface GatewayTarget {
  readonly environmentId: EnvironmentId;
  readonly contractVersion: number;
}

/** A session on the gateway: what its process gets, and the account the Thread shows. */
export interface GatewaySession {
  readonly access: AiGatewayAccess;
  readonly account: ProviderSessionAiAccount;
}

export class AiGatewaySessions extends Context.Service<
  AiGatewaySessions,
  {
    /**
     * Whether `driver`'s sessions of the Thread go through the gateway: a driver that takes a base
     * URL, on a Hub that has AI accounts, or in a Sandbox or dedicated machine (whose logins are no
     * longer used). One cheap query: such a Thread gets a provider process of its own.
     */
    readonly applies: (input: {
      readonly threadId: ThreadId;
      readonly driver: ProviderDriverKind;
      readonly environmentId?: EnvironmentId | undefined;
    }) => Effect.Effect<boolean>;
    /**
     * The gateway of a provider session about to start a process: the account and a new key for
     * the Thread's turn owner, revoked with `providerSessionId`. None off the gateway; a refusal
     * (never a fallback to a login) without an allowed account or on a machine before 11.
     */
    readonly forSession: (input: {
      readonly threadId: ThreadId;
      readonly providerSessionId: string;
      readonly driver: ProviderDriverKind;
      readonly modelSelection: ModelSelection;
      readonly target: GatewayTarget;
    }) => Effect.Effect<
      Option.Option<GatewaySession>,
      AiGatewaySessionError | AiGatewayKeys.AiGatewayKeyError
    >;
    /** Revokes the key of a session that did not open (its process never started). */
    readonly release: (providerSessionId: string) => Effect.Effect<void>;
  }
>()("t3/ai/AiGatewaySessions") {}

/** The AI account provider a driver speaks natively: preferred when the Thread chose none. */
const NATIVE_PROVIDER: Partial<Record<string, string>> = {
  claudeAgent: "claude",
  codex: "codex",
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const allowedAccounts = yield* AllowedAiAccounts.AllowedAiAccounts;
  const keys = yield* AiGatewayKeys.AiGatewayKeys;
  const activity = yield* Effect.serviceOption(AiGatewayActivity.AiGatewayActivity);

  /** A Sandbox or a dedicated machine: its volume's logins are never used (spec 3's are retired). */
  const isolatedMachine = (environmentId: EnvironmentId | undefined) =>
    environmentId === undefined || environmentId === HUB_MACHINE_ENVIRONMENT_ID
      ? Effect.succeed(false)
      : sql<{ readonly isolated: number }>`
          SELECT (kind = 'sandbox' OR mode IN ('sandbox', 'dedicated')) AS isolated
          FROM environments WHERE environment_id = ${environmentId}
        `.pipe(
          Effect.map((rows) => rows[0]?.isolated === 1),
          // Unreadable: the side that never runs on a login.
          Effect.orElseSucceed(() => true),
        );

  const hasAccounts = sql<{ readonly found: number }>`
    SELECT EXISTS (SELECT 1 FROM ai_accounts) AS found
  `.pipe(
    Effect.map((rows) => rows[0]?.found === 1),
    Effect.orElseSucceed(() => true),
  );

  const applies = Effect.fn("AiGatewaySessions.applies")(function* (input: {
    readonly threadId: ThreadId;
    readonly driver: ProviderDriverKind;
    readonly environmentId?: EnvironmentId | undefined;
  }) {
    if (!AI_GATEWAY_DRIVERS.has(input.driver)) return false;
    if (yield* hasAccounts) return true;
    return yield* isolatedMachine(input.environmentId);
  });

  const machineName = (environmentId: EnvironmentId) =>
    sql<{ readonly name: string }>`
      SELECT name FROM environments WHERE environment_id = ${environmentId}
    `.pipe(
      Effect.map((rows) => rows[0]?.name),
      Effect.orElseSucceed(() => undefined),
    );

  const forSession = Effect.fn("AiGatewaySessions.forSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: string;
    readonly driver: ProviderDriverKind;
    readonly modelSelection: ModelSelection;
    readonly target: GatewayTarget;
  }) {
    if (
      !(yield* applies({
        threadId: input.threadId,
        driver: input.driver,
        environmentId: input.target.environmentId,
      }))
    ) {
      return Option.none<GatewaySession>();
    }
    // Before the key: a machine too old for the gateway gets nothing, and says why.
    if (input.target.contractVersion < AI_GATEWAY_CONTRACT_VERSION) {
      const environmentName = yield* machineName(input.target.environmentId);
      return yield* new AiGatewaySessionError({
        reason: "outdated-machine",
        ...(environmentName === undefined ? {} : { environmentName }),
      });
    }
    // The Thread's turn owner in its Space now: the User every request of the key acts for.
    const space = yield* spaces
      .spaceOf({ kind: "thread", id: input.threadId })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const owner = yield* threadTurnOwner(sql, input.threadId).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(space) || Option.isNone(owner)) {
      return yield* new AiGatewaySessionError({ reason: "no-ai-account" });
    }
    // Through the gateway only: a direct credential is ticket 07's, never a gateway account.
    const allowed = (yield* allowedAccounts
      .for(owner.value, space.value.id)
      .pipe(Effect.orElseSucceed(() => []))).filter((account) => account.type !== "direct");
    const chosen = input.modelSelection.aiAccountId;
    let account: AllowedAiAccounts.AllowedAiAccount | undefined;
    if (chosen !== undefined) {
      account = allowed.find((candidate) => candidate.id === chosen);
      // Never another account in its place: the Thread chose this one.
      if (account === undefined) return yield* new AiGatewaySessionError({ reason: "not-allowed" });
    } else {
      // The highest priority allowed, of the driver's own provider first.
      const native = NATIVE_PROVIDER[input.driver];
      const byPriority = allowed.toSorted((a, b) => a.priority - b.priority);
      account = byPriority.find((candidate) => candidate.provider === native) ?? byPriority[0];
    }
    if (account === undefined) return yield* new AiGatewaySessionError({ reason: "no-ai-account" });
    const model = input.modelSelection.model.trim().length > 0 ? input.modelSelection.model : null;
    const issued = yield* keys.issueForThread(input.threadId, {
      providerSessionId: input.providerSessionId,
    });
    if (Option.isSome(activity) && model !== null) {
      yield* activity.value.noteInUse({ threadId: input.threadId, accountId: account.id, model });
    }
    return Option.some<GatewaySession>({
      access: {
        key: Redacted.value(issued.key),
        aiAccountId: account.id,
        aiAccountName: account.name,
        provider: account.provider,
        model,
      },
      account: { id: account.id, name: account.name, provider: account.provider, model },
    });
  });

  const release = (providerSessionId: string) =>
    keys.revokeSession(providerSessionId, "session-not-opened").pipe(
      Effect.catch((cause) =>
        Effect.logWarning("AiGatewaySessions: could not revoke an unopened session's key", {
          cause,
        }),
      ),
    );

  return AiGatewaySessions.of({ applies, forSession, release });
});

export const layer = Layer.effect(AiGatewaySessions, make);
