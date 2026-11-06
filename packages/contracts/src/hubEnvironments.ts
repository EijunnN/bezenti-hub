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
 * `t3 join` asks to join. It made the credential itself and sends only its SHA-256, so the
 * credential never leaves the machine; the PKCE challenge binds the request to that `t3 join`.
 */
export const EnvironmentJoinStartRequest = Schema.Struct({
  codeChallenge: TrimmedNonEmptyString,
  codeChallengeMethod: Schema.Literal("S256"),
  credentialHash: TrimmedNonEmptyString,
  name: HubEnvironmentName,
  os: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  hostname: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  /** A loopback port `t3 join` listens on, so a browser on the machine returns at once. */
  redirectUri: Schema.optionalKey(TrimmedNonEmptyString),
  state: Schema.optionalKey(TrimmedNonEmptyString),
});
export type EnvironmentJoinStartRequest = typeof EnvironmentJoinStartRequest.Type;

export const EnvironmentJoinStartResult = Schema.Struct({ requestId: TrimmedNonEmptyString });
export type EnvironmentJoinStartResult = typeof EnvironmentJoinStartResult.Type;

export const EnvironmentJoinRequestRef = Schema.Struct({ requestId: TrimmedNonEmptyString });
export type EnvironmentJoinRequestRef = typeof EnvironmentJoinRequestRef.Type;

/** What «Register this machine» shows. The labels come from `t3 join` on the machine. */
export const EnvironmentJoinRequestView = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  name: HubEnvironmentName,
  os: TrimmedNonEmptyString,
  hostname: TrimmedNonEmptyString,
  requestedAt: IsoDateTime,
  status: Schema.Literals(["pending", "approved", "denied"]),
});
export type EnvironmentJoinRequestView = typeof EnvironmentJoinRequestView.Type;

/** The Owner's approval, with a passkey or a password and code in the same request. */
export const EnvironmentJoinApproveRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  name: HubEnvironmentName,
  reauth: Schema.optionalKey(AuthReauth),
});
export type EnvironmentJoinApproveRequest = typeof EnvironmentJoinApproveRequest.Type;

/** Where the browser goes next: the machine's loopback port, or nowhere when there is none. */
export const EnvironmentJoinDecisionResult = Schema.Struct({
  redirectTo: Schema.NullOr(TrimmedNonEmptyString),
});
export type EnvironmentJoinDecisionResult = typeof EnvironmentJoinDecisionResult.Type;

export const EnvironmentJoinStatusRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  codeVerifier: TrimmedNonEmptyString,
});
export type EnvironmentJoinStatusRequest = typeof EnvironmentJoinStatusRequest.Type;

/** Asked again until it is not `pending`; the same approval answers every time. */
export const EnvironmentJoinStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["pending", "denied", "expired"]) }),
  Schema.Struct({
    status: Schema.Literal("approved"),
    environmentId: EnvironmentId,
    hubEnvironmentId: EnvironmentId,
    name: HubEnvironmentName,
  }),
]);
export type EnvironmentJoinStatus = typeof EnvironmentJoinStatus.Type;

export const EnvironmentLeaveResult = Schema.Struct({ removed: Schema.Boolean });
export type EnvironmentLeaveResult = typeof EnvironmentLeaveResult.Type;
