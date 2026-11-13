import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import {
  isProviderAvailable,
  isProviderTextGenerationCapable,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import {
  defaultTextGenerationModel,
  fallbackTextGenerationModelSelection,
} from "@t3tools/shared/serverSettings";
import * as ServerSettings from "../serverSettings.ts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import {
  AI_DIRECT_DRIVERS,
  HUB_RUNS_NO_AGENTS_MESSAGE,
  ProviderDriverKind,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import * as AiGatewaySessions from "../ai/AiGatewaySessions.ts";
import * as HubRunsAgents from "../environment/HubRunsAgents.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
  ThreadHandoffGenerationInput,
  ThreadHandoffGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";

export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "t3/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateReviewGuide"
  | "generateThreadHandoff";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

// Review guides investigate the checkout read-only; the other drivers reject that request.
const INVESTIGATING_DRIVERS = new Set(["codex", "claudeAgent"]);

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  // A Hub that runs no agents runs no provider CLI either: its callers ask the Thread's machine.
  const runsAgents = yield* HubRunsAgents.HubRunsAgents;
  const aiGatewaySessions = yield* Effect.serviceOption(AiGatewaySessions.AiGatewaySessions);
  const refusesLogin = (driver: string) =>
    Option.isNone(aiGatewaySessions) || !AI_DIRECT_DRIVERS.has(driver)
      ? Effect.succeed(false)
      : aiGatewaySessions.value.applies({ driver: ProviderDriverKind.make(driver) });
  const generate = Effect.fn("TextGeneration.generate")(function* <A>(
    operation: TextGenerationOp,
    selection: ModelSelection,
    invoke: (
      service: ProviderTextGeneration,
      modelSelection: ModelSelection,
    ) => Effect.Effect<A, TextGenerationError>,
  ) {
    if (!runsAgents) {
      return yield* new TextGenerationError({ operation, detail: HUB_RUNS_NO_AGENTS_MESSAGE });
    }
    const snapshots = yield* registry.listInstances.pipe(
      Effect.flatMap((instances) =>
        Effect.forEach(instances, (instance) => instance.snapshot.getSnapshot),
      ),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const limited = exhaustedUsageWindow(
      snapshots.find((provider) => provider.instanceId === selection.instanceId),
      now,
      selection.model,
    );
    // Spec 4 ticket 07: on a Hub running on AI accounts, a driver without a base URL never writes
    // titles, commit messages or summaries: it would sign in with the machine's login (the
    // Owner's Google account, for Antigravity). Another model writes them, or none does.
    const selected = yield* registry.getInstance(selection.instanceId);
    const loginRefused =
      selected !== undefined && (yield* refusesLogin(String(selected.driverKind)));
    if (limited || loginRefused) {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Could not read fallback model settings.",
              cause,
            }),
        ),
      );
      const fallback = fallbackTextGenerationModelSelection(
        settings.providerInstances,
        (instanceId, driver) => {
          const provider = snapshots.find((candidate) => candidate.instanceId === instanceId);
          return (
            instanceId !== selection.instanceId &&
            !(loginRefused && AI_DIRECT_DRIVERS.has(driver)) &&
            provider?.enabled === true &&
            resolveProjectProviderInstanceEnabled(settings, null, instanceId) &&
            provider.installed &&
            provider.auth.status !== "unauthenticated" &&
            isProviderAvailable(provider) &&
            isProviderTextGenerationCapable(provider) &&
            (operation !== "generateReviewGuide" || INVESTIGATING_DRIVERS.has(driver)) &&
            !exhaustedUsageWindow(provider, now, defaultTextGenerationModel(driver))
          );
        },
        { includeConfiguredInstances: true },
      );
      if (fallback === null && loginRefused) {
        return yield* new TextGenerationError({
          operation,
          detail:
            "This Hub runs on AI accounts, so this provider writes no titles, messages or summaries (it would sign in with the machine's account). Pick another text generation model in Settings.",
        });
      }
      selection = fallback ?? selection;
    }
    return yield* resolveInstance(registry, operation, selection.instanceId).pipe(
      Effect.flatMap((service) => invoke(service, selection)),
    );
  });
  return TextGeneration.of({
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return generate("generateCommitMessage", input.modelSelection, (service, modelSelection) =>
        service.generateCommitMessage({ ...input, modelSelection }),
      );
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return generate("generatePrContent", input.modelSelection, (service, modelSelection) =>
        service.generatePrContent({ ...input, modelSelection }),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return generate("generateBranchName", input.modelSelection, (service, modelSelection) =>
        service.generateBranchName({ ...input, modelSelection }),
      );
    }),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return generate("generateReviewGuide", input.modelSelection, (service, modelSelection) =>
        service.generateReviewGuide({ ...input, modelSelection }),
      );
    }),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function (input) {
      return generate(
        "generateThreadTitle",
        input.modelSelection,
        (textGeneration, modelSelection) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* textGeneration.generateThreadTitle({
              ...input,
              linkedContext,
              modelSelection,
            });
          }),
      );
    }),
    // The Thread's provider writes a moved Thread's summary; a machine without that instance (the
    // Hub machine, writing for an offline source) uses its own text generation model instead.
    generateThreadHandoff: Effect.fn("TextGeneration.generateThreadHandoff")(function* (input) {
      const own = yield* registry.getInstance(input.modelSelection.instanceId);
      const selection =
        own !== undefined
          ? input.modelSelection
          : (yield* serverSettings.getSettings.pipe(
              Effect.mapError(
                (cause) =>
                  new TextGenerationError({
                    operation: "generateThreadHandoff",
                    detail: "Could not read the text generation model settings.",
                    cause,
                  }),
              ),
            )).textGenerationModelSelection;
      return yield* generate("generateThreadHandoff", selection, (service, modelSelection) =>
        service.generateThreadHandoff === undefined
          ? Effect.fail(
              new TextGenerationError({
                operation: "generateThreadHandoff",
                detail: `Provider instance '${modelSelection.instanceId}' cannot write a handoff summary.`,
              }),
            )
          : service.generateThreadHandoff({ ...input, modelSelection }).pipe(
              // Say which instance wrote it: the fallback model, a usage-limit fallback, or its own.
              Effect.map((result) => ({
                ...result,
                providerInstanceId: modelSelection.instanceId,
              })),
            ),
      );
    }),
  });
});

export const layer = Layer.effect(TextGeneration, make);
