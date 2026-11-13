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
  type UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";

import { machineNameOf } from "../environments/machineName.ts";
import { threadTurnOwner } from "../orchestration-v2/threadTurnOwner.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as AiAccounts from "./AiAccounts.ts";
import * as AiGatewayActivity from "./AiGatewayActivity.ts";
import * as AiGatewayKeys from "./AiGatewayKeys.ts";
import * as AllowedAiAccounts from "./AllowedAiAccounts.ts";

/** The machine a session's process starts on, and its executor contract. */
export interface GatewayTarget {
  readonly environmentId: EnvironmentId;
  readonly contractVersion: number;
}

/**
 * What a session of the Thread gets now, decided once per open and without a key: off the
 * gateway, refused (never a fallback to a login), or on it for this owner and account.
 */
export type GatewayPlan =
  | { readonly _tag: "off" }
  | { readonly _tag: "refused"; readonly error: AiGatewaySessionError }
  | {
      readonly _tag: "on";
      readonly ownerUserId: UserId;
      readonly account: ProviderSessionAiAccount;
      /** Names who the process acts for and on what: a session with another is not reused. */
      readonly fingerprint: string;
    };

/** A session on the gateway: what its process gets, and the account the Thread shows. */
export interface GatewaySession {
  readonly access: AiGatewayAccess;
  readonly account: ProviderSessionAiAccount;
}

/** The fingerprint of a session off the gateway. */
export const NO_GATEWAY = "none";

export const fingerprintOf = (plan: GatewayPlan) =>
  plan._tag === "on" ? plan.fingerprint : NO_GATEWAY;

export class AiGatewaySessions extends Context.Service<
  AiGatewaySessions,
  {
    /**
     * Whether `driver`'s sessions of the Thread go through the gateway: a driver that takes a base
     * URL, on a Hub with a usable AI account, or always in a Sandbox or dedicated machine (whose
     * logins are no longer used). Such a Thread gets a provider process of its own.
     */
    readonly applies: (input: {
      readonly driver: ProviderDriverKind;
      readonly environmentId?: EnvironmentId | undefined;
    }) => Effect.Effect<boolean>;
    /** What a session of the Thread gets now; unreadable state refuses (fails closed). */
    readonly plan: (input: {
      readonly threadId: ThreadId;
      readonly driver: ProviderDriverKind;
      readonly modelSelection: ModelSelection;
      readonly target: GatewayTarget;
    }) => Effect.Effect<GatewayPlan>;
    /** The key of a session about to start its process, for its plan's owner, revoked with it. */
    readonly issue: (input: {
      readonly threadId: ThreadId;
      readonly providerSessionId: string;
      readonly plan: Extract<GatewayPlan, { readonly _tag: "on" }>;
    }) => Effect.Effect<GatewaySession, AiGatewayKeys.AiGatewayKeyError>;
    /** Revokes a session's key: it closed, or never opened (its process never started). */
    readonly release: (
      providerSessionId: string,
      reason?: "session-closed" | "session-not-opened",
    ) => Effect.Effect<void>;
  }
>()("t3/ai/AiGatewaySessions") {}

/** The model the gateway serves for a selection: without the gateway provider's `t3/`. */
const gatewayModelOf = (model: string) => (model.startsWith("t3/") ? model.slice(3) : model);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const allowedAccounts = yield* AllowedAiAccounts.AllowedAiAccounts;
  const accounts = yield* AiAccounts.AiAccounts;
  const keys = yield* AiGatewayKeys.AiGatewayKeys;
  const activity = yield* Effect.serviceOption(AiGatewayActivity.AiGatewayActivity);

  // No session survives a Hub restart (each machine drops what the Hub no longer knows): the keys
  // issued for them stop working now.
  yield* keys
    .revokeLiveThreadKeys("hub-restarted")
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("AiGatewaySessions: could not revoke earlier sessions' keys", { cause }),
      ),
    );

  /** A Sandbox or a dedicated machine: its volume's logins are never used. */
  const isolatedMachine = Effect.fn("AiGatewaySessions.isolatedMachine")(function* (
    environmentId: EnvironmentId | undefined,
  ) {
    if (environmentId === undefined || environmentId === HUB_MACHINE_ENVIRONMENT_ID) return false;
    const rows = yield* sql<{ readonly isolated: number }>`
      SELECT (kind = 'sandbox' OR mode IN ('sandbox', 'dedicated')) AS isolated
      FROM environments WHERE environment_id = ${environmentId}
    `.pipe(Effect.orElseSucceed(() => [{ isolated: 1 }]));
    // Unknown or unreadable: the side that never runs on a login.
    return rows[0] === undefined || rows[0].isolated === 1;
  });

  /** An account the gateway can route to: not deleted, not disabled, not a direct credential. */
  const hasAccounts = sql<{ readonly found: number }>`
    SELECT EXISTS (
      SELECT 1 FROM ai_accounts
      WHERE deleted_at IS NULL AND disabled = 0 AND type <> 'direct'
    ) AS found
  `.pipe(
    Effect.map((rows) => rows[0]?.found === 1),
    Effect.orElseSucceed(() => true),
  );

  const applies = Effect.fn("AiGatewaySessions.applies")(function* (input: {
    readonly driver: ProviderDriverKind;
    readonly environmentId?: EnvironmentId | undefined;
  }) {
    if (!AI_GATEWAY_DRIVERS.has(input.driver)) return false;
    if (yield* hasAccounts) return true;
    return yield* isolatedMachine(input.environmentId);
  });

  const refused = (error: AiGatewaySessionError): GatewayPlan => ({ _tag: "refused", error });

  const plan = Effect.fn("AiGatewaySessions.plan")(function* (input: {
    readonly threadId: ThreadId;
    readonly driver: ProviderDriverKind;
    readonly modelSelection: ModelSelection;
    readonly target: GatewayTarget;
  }) {
    if (!(yield* applies({ driver: input.driver, environmentId: input.target.environmentId }))) {
      return { _tag: "off" } satisfies GatewayPlan;
    }
    // A machine too old for the gateway gets nothing, and says why.
    if (input.target.contractVersion < AI_GATEWAY_CONTRACT_VERSION) {
      const environmentName = yield* machineNameOf(sql, input.target.environmentId);
      return refused(
        new AiGatewaySessionError({
          reason: "outdated-machine",
          ...(environmentName === undefined ? {} : { environmentName }),
        }),
      );
    }
    // The Thread's turn owner in its Space now: the User every request of the key acts for.
    const space = yield* spaces
      .spaceOf({ kind: "thread", id: input.threadId })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const owner = yield* threadTurnOwner(sql, input.threadId).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(space) || Option.isNone(owner)) {
      return refused(new AiGatewaySessionError({ reason: "no-ai-account" }));
    }
    // Through the gateway only, by global priority: what the gateway itself routes to.
    const allowed = (yield* allowedAccounts
      .for(owner.value, space.value.id)
      .pipe(Effect.orElseSucceed(() => []))).filter((account) => account.type !== "direct");
    if (allowed.length === 0) {
      return refused(new AiGatewaySessionError({ reason: "no-ai-account" }));
    }
    const model = input.modelSelection.model.trim().length > 0 ? input.modelSelection.model : null;
    const served = model === null ? null : gatewayModelOf(model);
    const chosen = input.modelSelection.aiAccountId;
    let account: AllowedAiAccounts.AllowedAiAccount | undefined;
    if (chosen !== undefined) {
      account = allowed.find((candidate) => candidate.id === chosen);
      // Never another account in its place: the Thread chose this one.
      if (account === undefined) {
        return refused(new AiGatewaySessionError({ reason: "not-allowed" }));
      }
    } else if (served === null) {
      account = allowed[0];
    } else {
      // The first allowed that serves the model, as the gateway picks it (`planRoute`).
      for (const candidate of allowed) {
        const models = yield* accounts
          .modelsOf(candidate.id)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        if (models.includes(served)) {
          account = candidate;
          break;
        }
      }
      if (account === undefined) {
        return refused(new AiGatewaySessionError({ reason: "model-not-served", model: served }));
      }
    }
    if (account === undefined) {
      return refused(new AiGatewaySessionError({ reason: "no-ai-account" }));
    }
    return {
      _tag: "on",
      ownerUserId: owner.value,
      account: {
        id: account.id,
        name: account.name,
        provider: account.provider,
        model: served,
      },
      fingerprint: `${owner.value}\u0000${space.value.id}\u0000${account.id}`,
    } satisfies GatewayPlan;
  });

  const issue = Effect.fn("AiGatewaySessions.issue")(function* (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: string;
    readonly plan: Extract<GatewayPlan, { readonly _tag: "on" }>;
  }) {
    const issued = yield* keys.issueForThread(input.threadId, {
      providerSessionId: input.providerSessionId,
    });
    const account = input.plan.account;
    if (Option.isSome(activity) && account.model !== null) {
      yield* activity.value.noteInUse({
        threadId: input.threadId,
        accountId: account.id,
        model: account.model,
      });
    }
    return {
      access: {
        key: Redacted.value(issued.key),
        aiAccountId: account.id,
        aiAccountName: account.name,
        provider: account.provider,
        model: account.model,
      },
      account,
    } satisfies GatewaySession;
  });

  const release = Effect.fn("AiGatewaySessions.release")(function* (
    providerSessionId: string,
    reason: "session-closed" | "session-not-opened" = "session-not-opened",
  ) {
    yield* keys
      .revokeSession(providerSessionId, reason)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("AiGatewaySessions: could not revoke a session's key", { cause }),
        ),
      );
  });

  return AiGatewaySessions.of({ applies, plan, issue, release });
});

export const layer = Layer.effect(AiGatewaySessions, make);
