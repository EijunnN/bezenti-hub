import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
  UserId,
} from "./baseSchemas.ts";
import {
  EnvironmentConnectionStatus,
  EnvironmentHostResources,
  EnvironmentProviderSummary,
} from "./environmentConnection.ts";
import { AuthReauth } from "./userAccounts.ts";

/** The Hub machine runs in the Hub's own process; every other one joined with `t3 join`. */
export const HubEnvironmentKind = Schema.Literals(["hub", "external"]);
export type HubEnvironmentKind = typeof HubEnvironmentKind.Type;

/** `personal`: only its owner uses it, in any of their Spaces. `dedicated` comes later. */
export const HubEnvironmentMode = Schema.Literals(["personal"]);
export type HubEnvironmentMode = typeof HubEnvironmentMode.Type;

export const HubEnvironmentName = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

export const HubEnvironmentSummary = Schema.Struct({
  id: EnvironmentId,
  name: HubEnvironmentName,
  kind: HubEnvironmentKind,
  mode: HubEnvironmentMode,
  /** Null for the Hub machine, which belongs to the Installation. */
  ownerUserId: Schema.NullOr(UserId),
  status: EnvironmentConnectionStatus,
  registeredAt: IsoDateTime,
  lastSeenAt: Schema.NullOr(IsoDateTime),
  os: Schema.NullOr(TrimmedNonEmptyString),
  hostname: Schema.NullOr(TrimmedNonEmptyString),
  providers: Schema.Array(EnvironmentProviderSummary),
  resources: Schema.NullOr(EnvironmentHostResources),
  runningThreadCount: NonNegativeInt,
});
export type HubEnvironmentSummary = typeof HubEnvironmentSummary.Type;

export const HubEnvironmentList = Schema.Struct({
  environments: Schema.Array(HubEnvironmentSummary),
});
export type HubEnvironmentList = typeof HubEnvironmentList.Type;

export const RenameHubEnvironmentRequest = Schema.Struct({
  environmentId: EnvironmentId,
  name: HubEnvironmentName,
});
export type RenameHubEnvironmentRequest = typeof RenameHubEnvironmentRequest.Type;

export const RemoveHubEnvironmentRequest = Schema.Struct({ environmentId: EnvironmentId });
export type RemoveHubEnvironmentRequest = typeof RemoveHubEnvironmentRequest.Type;

/**
 * The Owner's approval on the Hub's «Register this machine» page. Name, operating system and
 * hostname come from `t3 join` on the machine and are only labels; the name may be edited.
 */
export const EnvironmentJoinApproveRequest = Schema.Struct({
  redirectUri: TrimmedNonEmptyString,
  codeChallenge: TrimmedNonEmptyString,
  codeChallengeMethod: Schema.Literal("S256"),
  state: TrimmedNonEmptyString,
  name: HubEnvironmentName,
  os: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  hostname: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  /** A passkey, or a password with a code: required, checked by the Hub. */
  reauth: Schema.optionalKey(AuthReauth),
});
export type EnvironmentJoinApproveRequest = typeof EnvironmentJoinApproveRequest.Type;

export const EnvironmentJoinApproveResult = Schema.Struct({ redirectTo: TrimmedNonEmptyString });
export type EnvironmentJoinApproveResult = typeof EnvironmentJoinApproveResult.Type;

export const EnvironmentJoinTokenRequest = Schema.Struct({
  code: TrimmedNonEmptyString,
  codeVerifier: TrimmedNonEmptyString,
  redirectUri: TrimmedNonEmptyString,
});
export type EnvironmentJoinTokenRequest = typeof EnvironmentJoinTokenRequest.Type;

/** The only time the credential leaves the Hub; the Hub keeps its hash. */
export const EnvironmentJoinTokenResult = Schema.Struct({
  environmentId: EnvironmentId,
  hubEnvironmentId: EnvironmentId,
  name: HubEnvironmentName,
  credential: TrimmedNonEmptyString,
});
export type EnvironmentJoinTokenResult = typeof EnvironmentJoinTokenResult.Type;

export const EnvironmentLeaveResult = Schema.Struct({ removed: Schema.Boolean });
export type EnvironmentLeaveResult = typeof EnvironmentLeaveResult.Type;
