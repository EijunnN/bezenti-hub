/**
 * Each Environment's map from Project to its local checkout (`environment_project_checkouts`,
 * migration 095). An Environment's executor answers from it, so a logical workspace path resolves
 * against that machine's own checkout (`docs/internals/overview.md`, «Logical workspace paths»).
 */
import { EnvironmentId, HUB_MACHINE_ENVIRONMENT_ID, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  joinUnderRoot,
  projectCheckoutSlug,
  resolveOnEnvironment,
  type WorkspaceLocation,
  type WorkspaceLocationUnavailableError,
} from "./WorkspaceLocation.ts";

export class ProjectCheckoutsError extends Schema.TaggedError<ProjectCheckoutsError>()(
  "ProjectCheckoutsError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Project checkout operation '${this.operation}' failed.`;
  }
}

export class ProjectCheckouts extends Context.Service<
  ProjectCheckouts,
  {
    /** The checkout chosen on an Environment, if one was. */
    readonly chosen: (input: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
    }) => Effect.Effect<Option.Option<string>, ProjectCheckoutsError>;
    /** Records an existing checkout in place of the default. The Hub machine's is fixed. */
    readonly choose: (input: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly checkoutPath: string;
    }) => Effect.Effect<void, ProjectCheckoutsError>;
  }
>()("t3/environment/ProjectCheckouts") {}

export const layer: Layer.Layer<ProjectCheckouts, never, SqlClient.SqlClient> = Layer.effect(
  ProjectCheckouts,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const mapError =
      (operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.mapError((cause) => new ProjectCheckoutsError({ operation, cause })));
    return ProjectCheckouts.of({
      chosen: Effect.fn("ProjectCheckouts.chosen")(function* (input) {
        const rows = yield* sql<{ readonly checkoutPath: string }>`
          SELECT checkout_path AS "checkoutPath"
          FROM environment_project_checkouts
          WHERE environment_id = ${input.environmentId} AND project_id = ${input.projectId}
        `.pipe(mapError("chosen"));
        return Option.fromUndefinedOr(rows[0]?.checkoutPath);
      }),
      choose: Effect.fn("ProjectCheckouts.choose")(function* (input) {
        if (input.environmentId === HUB_MACHINE_ENVIRONMENT_ID) {
          return yield* new ProjectCheckoutsError({
            operation: "choose",
            cause: "The Hub machine's checkout of a Project is its workspace root.",
          });
        }
        const chosenAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO environment_project_checkouts (environment_id, project_id, checkout_path, chosen_at)
          VALUES (${input.environmentId}, ${input.projectId}, ${input.checkoutPath}, ${chosenAt})
          ON CONFLICT(environment_id, project_id)
          DO UPDATE SET checkout_path = excluded.checkout_path, chosen_at = excluded.chosen_at
        `.pipe(mapError("choose"));
      }),
    });
  }),
);

/** How one Environment's executor turns logical workspace paths into its own. */
export interface EnvironmentWorkspacePaths {
  /** None when the Project is unknown. */
  readonly checkout: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<string>, ProjectCheckoutsError>;
  readonly resolve: (input: {
    readonly projectId: ProjectId;
    readonly location: WorkspaceLocation;
  }) => Effect.Effect<string, ProjectCheckoutsError | WorkspaceLocationUnavailableError>;
}

const makePaths = (
  environmentId: EnvironmentId,
  checkout: EnvironmentWorkspacePaths["checkout"],
): EnvironmentWorkspacePaths => ({
  checkout,
  resolve: Effect.fn("EnvironmentWorkspacePaths.resolve")(function* (input) {
    const resolved = resolveOnEnvironment({
      environmentId,
      projectId: input.projectId,
      checkout: Option.getOrNull(yield* checkout(input.projectId)),
      location: input.location,
    });
    return typeof resolved === "string" ? resolved : yield* resolved;
  }),
});

const hubMachineRoot = (projects: ProjectStore.ProjectStoreV2["Service"], projectId: ProjectId) =>
  projects.get(projectId, { includeDeleted: true }).pipe(
    Effect.map(Option.map((project) => project.workspaceRoot)),
    Effect.mapError((cause) => new ProjectCheckoutsError({ operation: "checkout", cause })),
  );

/** The Hub machine keeps each Project where it is: its checkout is the Project's workspace root. */
export const hubMachinePaths = (
  projects: ProjectStore.ProjectStoreV2["Service"],
): EnvironmentWorkspacePaths =>
  makePaths(HUB_MACHINE_ENVIRONMENT_ID, (projectId) => hubMachineRoot(projects, projectId));

/**
 * Another Environment: the checkout chosen there, else `<workspace root>/<Project slug>`. The
 * workspace root is the Environment's own, as it reports it.
 */
export const environmentPaths = (input: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly checkouts: ProjectCheckouts["Service"];
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
}): EnvironmentWorkspacePaths =>
  makePaths(
    input.environmentId,
    Effect.fn("EnvironmentWorkspacePaths.checkout")(function* (projectId) {
      const chosen = yield* input.checkouts.chosen({
        environmentId: input.environmentId,
        projectId,
      });
      if (Option.isSome(chosen)) return chosen;
      return Option.map(yield* hubMachineRoot(input.projects, projectId), (hubCheckout) =>
        joinUnderRoot(input.workspaceRoot, projectCheckoutSlug({ projectId, hubCheckout })),
      );
    }),
  );
