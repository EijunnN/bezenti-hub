import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
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
 * The Hub machine runs in the Hub's own process (and runs Threads only in development,
 * `T3CODE_HUB_RUNS_AGENTS`); an external one joined with `t3 join`; a Sandbox is the Space's own
 * joined server, which the Hub runs for it.
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

type PlacementCandidate = Pick<HubEnvironmentSummary, "id" | "kind" | "status" | "providers"> & {
  readonly usable: boolean;
};

/**
 * Whether a new Thread can start on the Environment now: the User may use it, it is online (a
 * Sandbox counts while stopped or starting, not once its start failed: the Hub starts it for the
 * work) and it has the provider, as far as it is known (a Sandbox that never ran reported none).
 */
export function canStartThreadOn(
  candidate: PlacementCandidate,
  providerInstanceId: string,
  /** Whether the Hub runs Sandboxes at all: one it cannot run takes no Thread. */
  sandboxesRun = true,
): boolean {
  if (!candidate.usable) return false;
  if (candidate.kind === "hub") return true;
  if (candidate.kind === "sandbox" && !sandboxesRun) return false;
  if (candidate.kind === "sandbox" && candidate.status !== "online") {
    if (candidate.status === "failed") return false;
    if (candidate.providers.length === 0) return true;
  } else if (candidate.status !== "online") {
    return false;
  }
  const provider = candidate.providers.find((entry) => entry.instanceId === providerInstanceId);
  return provider !== undefined && provider.enabled && provider.installed;
}

/**
 * Where a new Thread nobody placed starts, by the Hub and as clients preview it: the preferred
 * Environment while it can take the Thread, else the Space's Sandbox (even stopped or failed: its
 * work starts it), or the Hub machine instead while it runs agents (`T3CODE_HUB_RUNS_AGENTS`).
 * Null: nothing can run it.
 */
export function previewThreadPlacement(input: {
  readonly preferred: PlacementCandidate | undefined;
  readonly providerInstanceId: string;
  /** Whether the Hub machine runs Threads; the Hub lists it only then. */
  readonly hubMachine: boolean;
  /** The Space's Sandbox, when the User may run Threads there. */
  readonly spaceSandbox: { readonly id: EnvironmentId } | undefined;
  /** Whether the Hub runs Sandboxes (`sandboxesUnavailable` null); true when not known. */
  readonly sandboxesRun?: boolean;
}): EnvironmentId | null {
  const preferred = input.preferred;
  const sandboxesRun = input.sandboxesRun ?? true;
  if (
    preferred !== undefined &&
    canStartThreadOn(preferred, input.providerInstanceId, sandboxesRun)
  ) {
    return preferred.id;
  }
  if (input.hubMachine) return HUB_MACHINE_ENVIRONMENT_ID;
  return sandboxesRun ? (input.spaceSandbox?.id ?? null) : null;
}

/** What the Hub and the composer say when a new Thread has nowhere to run, and why. */
export const NO_ENVIRONMENT_TITLE = "No Environment can run this Thread";
export const noEnvironmentMessage = (why: string) => `${NO_ENVIRONMENT_TITLE}: ${why}`;

/** Why a Hub runs no Sandboxes, when it cannot say more (older Hubs, tests). */
export const SANDBOXES_NEED_PODMAN =
  "Sandboxes need Podman on the Hub, which this Hub does not have yet.";

/** What a User without a place for a new Thread can do about it. */
export const NO_ENVIRONMENT_ADVICE =
  "Choose one of your own machines, or see «Run Threads in your Space's Sandbox» in the install guide.";

export const HubEnvironmentList = Schema.Struct({
  environments: Schema.Array(HubEnvironmentSummary),
  /**
   * Why this Hub runs no Sandboxes (no rootless Podman or image, not on loopback only, turned
   * off); null while it runs them. Absent from older Hubs.
   */
  sandboxesUnavailable: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
