import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  SpaceId,
  TrimmedNonEmptyString,
  UserId,
} from "./baseSchemas.ts";
import {
  EnvironmentConnectionStatus,
  EnvironmentHostResources,
  EnvironmentProviderSummary,
} from "./environmentConnection.ts";
import { HUB_MACHINE_ENVIRONMENT_ID } from "./environmentExecutor.ts";
import { AuthReauth } from "./userAccounts.ts";

/**
 * The Hub machine runs in the Hub's own process; an external one joined with `t3 join`; a
 * Sandbox is the Space's own joined server, which the Hub runs for it.
 */
export const HubEnvironmentKind = Schema.Literals(["hub", "external", "sandbox"]);
export type HubEnvironmentKind = typeof HubEnvironmentKind.Type;

/**
 * `personal`: only its owner uses it, in any of their Spaces. `sandbox`: the Users who work in
 * its Space use it, for that Space's Threads. `dedicated` comes later.
 */
export const HubEnvironmentMode = Schema.Literals(["personal", "sandbox"]);
export type HubEnvironmentMode = typeof HubEnvironmentMode.Type;

export const HubEnvironmentName = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/**
 * A machine's connection, or a Sandbox's lifecycle while it is not connected: `stopped` (the Hub
 * starts it for work), `starting`, or `failed` (its last start failed; `startError` says why).
 */
export const HubEnvironmentStatus = Schema.Literals([
  ...EnvironmentConnectionStatus.literals,
  "stopped",
  "starting",
  "failed",
]);
export type HubEnvironmentStatus = typeof HubEnvironmentStatus.Type;

/** A Space's Sandbox has one id for its whole life, known before the Sandbox exists. */
export const sandboxEnvironmentIdOf = (spaceId: SpaceId): EnvironmentId =>
  EnvironmentId.make(`sandbox:${spaceId}`);

/** «<Space> Sandbox», as every client names it. */
export const sandboxEnvironmentName = (spaceName: string) =>
  `${spaceName.slice(0, 64 - " Sandbox".length).trim()} Sandbox`;

export const HubEnvironmentSummary = Schema.Struct({
  id: EnvironmentId,
  name: HubEnvironmentName,
  kind: HubEnvironmentKind,
  mode: HubEnvironmentMode,
  /** Null for the Hub machine, which belongs to the Installation, and for Sandboxes. */
  ownerUserId: Schema.NullOr(UserId),
  /** A Sandbox's Space; it runs only that Space's Threads. Absent from older Hubs. */
  spaceId: Schema.optionalKey(Schema.NullOr(SpaceId)),
  status: HubEnvironmentStatus,
  /** Why a `failed` Sandbox's last start failed. Absent from older Hubs. */
  startError: Schema.optionalKey(Schema.NullOr(Schema.String)),
  registeredAt: IsoDateTime,
  lastSeenAt: Schema.NullOr(IsoDateTime),
  os: Schema.NullOr(TrimmedNonEmptyString),
  hostname: Schema.NullOr(TrimmedNonEmptyString),
  providers: Schema.Array(EnvironmentProviderSummary),
  resources: Schema.NullOr(EnvironmentHostResources),
  runningThreadCount: NonNegativeInt,
});
export type HubEnvironmentSummary = typeof HubEnvironmentSummary.Type;

/**
 * Where a new Thread nobody placed starts, by the Hub and as clients preview it: the Project's
 * preferred Environment when the User may use it, it is online (a Sandbox counts while stopped or
 * starting, not once its start failed) and it has the provider (as far as it is known); otherwise
 * the Hub machine.
 */
export function previewThreadPlacement(input: {
  readonly preferred:
    | (Pick<HubEnvironmentSummary, "id" | "kind" | "status" | "providers"> & {
        readonly usable: boolean;
      })
    | undefined;
  readonly providerInstanceId: string;
}): EnvironmentId {
  const preferred = input.preferred;
  if (preferred === undefined || !preferred.usable) return HUB_MACHINE_ENVIRONMENT_ID;
  if (preferred.kind === "hub") return preferred.id;
  const provider = preferred.providers.find(
    (entry) => entry.instanceId === input.providerInstanceId,
  );
  if (preferred.kind === "sandbox" && preferred.status !== "online") {
    if (preferred.status === "failed") return HUB_MACHINE_ENVIRONMENT_ID;
    // Before it ever ran its providers are unknown; after, it must have this one.
    if (preferred.providers.length === 0) return preferred.id;
  } else if (preferred.status !== "online") {
    return HUB_MACHINE_ENVIRONMENT_ID;
  }
  return provider !== undefined && provider.enabled && provider.installed
    ? preferred.id
    : HUB_MACHINE_ENVIRONMENT_ID;
}

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

/** «Try again» on a Sandbox that failed to start: the Hub starts it, and answers at once. */
export const StartHubEnvironmentRequest = Schema.Struct({ environmentId: EnvironmentId });
export type StartHubEnvironmentRequest = typeof StartHubEnvironmentRequest.Type;

/**
 * A Sandbox's CPU, memory, PIDs and disk limits. In the Installation's defaults null is no limit;
 * in a Space's override null is the Installation's default.
 */
export const SandboxLimits = Schema.Struct({
  cpus: Schema.NullOr(
    Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(512)),
  ),
  memoryBytes: Schema.NullOr(PositiveInt),
  pids: Schema.NullOr(PositiveInt),
  diskBytes: Schema.NullOr(PositiveInt),
});
export type SandboxLimits = typeof SandboxLimits.Type;

/**
 * Which limits this Hub enforces on its Sandboxes. CPU, memory and PIDs need the Sandbox runtime
 * to give each container a cgroup of its own; disk is the Hub's own periodic check. `note` says,
 * in words for the Owner, why one is not enforced.
 */
export const SandboxLimitEnforcement = Schema.Struct({
  cpus: Schema.Boolean,
  memory: Schema.Boolean,
  pids: Schema.Boolean,
  disk: Schema.Boolean,
  note: Schema.NullOr(Schema.String),
});
export type SandboxLimitEnforcement = typeof SandboxLimitEnforcement.Type;

/** What a Sandbox uses now (CPU and memory while running) and its home's size when last measured. */
export const SandboxUsage = Schema.Struct({
  /** Percent of one CPU. */
  cpuPercent: Schema.NullOr(Schema.Number),
  memoryBytes: Schema.NullOr(Schema.Number),
  diskBytes: Schema.NullOr(Schema.Number),
  diskMeasuredAt: Schema.NullOr(IsoDateTime),
});
export type SandboxUsage = typeof SandboxUsage.Type;

/** One Sandbox as Settings → Environments «Sandboxes» shows it. */
export const HubSandboxDetail = Schema.Struct({
  environmentId: EnvironmentId,
  spaceId: SpaceId,
  name: HubEnvironmentName,
  status: HubEnvironmentStatus,
  /** Why it is `failed`: its start, or its disk being over its limit. */
  error: Schema.NullOr(Schema.String),
  runtime: Schema.Literals(["process", "podman"]),
  /** The image version it last started with, once the Hub records one. */
  imageVersion: Schema.NullOr(Schema.String),
  /** Since when it runs; null while it does not. */
  startedAt: Schema.NullOr(IsoDateTime),
  /** The limits it starts with: the Space's override over the Installation's defaults. */
  limits: SandboxLimits,
  /** The Space's own values; null where it takes the default. */
  overrides: SandboxLimits,
  usage: SandboxUsage,
  /** Whether the viewer (the Owner) may start, stop, restart it and change its limits. */
  manageable: Schema.Boolean,
});
export type HubSandboxDetail = typeof HubSandboxDetail.Type;

export const HubSandboxList = Schema.Struct({
  /** The Installation's default limits; the Owner changes them. */
  defaults: SandboxLimits,
  enforcement: SandboxLimitEnforcement,
  sandboxes: Schema.Array(HubSandboxDetail),
  /** Whether the viewer is the Owner, who changes the defaults. */
  manageable: Schema.Boolean,
});
export type HubSandboxList = typeof HubSandboxList.Type;

/** The Owner starts, stops or restarts a Sandbox by hand. Answers at once for a start. */
export const HubSandboxActionRequest = Schema.Struct({
  environmentId: EnvironmentId,
  action: Schema.Literals(["start", "stop", "restart"]),
});
export type HubSandboxActionRequest = typeof HubSandboxActionRequest.Type;

/**
 * The Owner changes the Installation's defaults (no `environmentId`) or one Space's override.
 * Takes effect on the Sandbox's next start; the disk limit at its next check.
 */
export const HubSandboxLimitsRequest = Schema.Struct({
  environmentId: Schema.optionalKey(EnvironmentId),
  limits: SandboxLimits,
});
export type HubSandboxLimitsRequest = typeof HubSandboxLimitsRequest.Type;

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

/**
 * What «Register this machine» shows. The labels come from `t3 join` on the machine, and only a
 * viewer who may approve gets them.
 */
export const EnvironmentJoinRequestView = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  name: Schema.optionalKey(HubEnvironmentName),
  os: Schema.optionalKey(TrimmedNonEmptyString),
  hostname: Schema.optionalKey(TrimmedNonEmptyString),
  requestedAt: Schema.optionalKey(IsoDateTime),
  status: Schema.Literals(["pending", "awaiting-confirmation", "approved", "denied"]),
  /**
   * Whether the browser's signed-in User may approve it (the Owner, or `environments.registerOwn`);
   * absent when that is unknown, as when nobody is signed in. Approving checks again.
   */
  viewerMayApprove: Schema.optionalKey(Schema.Boolean),
  /** Why they may not, when they may not. */
  denialMessage: Schema.optionalKey(TrimmedNonEmptyString),
});
export type EnvironmentJoinRequestView = typeof EnvironmentJoinRequestView.Type;

/** The approval, with a passkey or a password and code in the same request. */
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

/** Who approved a machine joining, so `t3 join` can check it is whom it expected. */
export const EnvironmentJoinApprover = Schema.Struct({
  userId: UserId,
  displayName: TrimmedNonEmptyString,
  /** Null for a User who signs in with a passkey only; they are named by `userId`. */
  loginName: Schema.NullOr(Schema.String),
});
export type EnvironmentJoinApprover = typeof EnvironmentJoinApprover.Type;

/** `t3 join` accepts the approver it was told about, registering the machine, or refuses them. */
export const EnvironmentJoinConfirmRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  codeVerifier: TrimmedNonEmptyString,
  accept: Schema.Boolean,
});
export type EnvironmentJoinConfirmRequest = typeof EnvironmentJoinConfirmRequest.Type;

/**
 * Asked again until it is neither `pending` nor `awaiting-confirmation`; the same approval answers
 * every time. Once approved on the page the machine is told by whom and confirms (or refuses)
 * before anything is registered.
 */
export const EnvironmentJoinStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["pending", "denied", "expired"]) }),
  Schema.Struct({
    status: Schema.Literal("awaiting-confirmation"),
    name: HubEnvironmentName,
    approvedBy: EnvironmentJoinApprover,
  }),
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
