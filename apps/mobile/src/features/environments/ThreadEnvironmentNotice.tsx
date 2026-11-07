import { useNavigation } from "@react-navigation/native";
import {
  environmentNameOf,
  moveStepLabel,
} from "@t3tools/client-runtime/environment/hub-environments";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { canMoveThread } from "@t3tools/client-runtime/environment/hub-environments";
import { useHubEnvironments } from "../../state/hubEnvironments";
import { useThreadRolePermissions } from "../../state/spaces";
import type { ThreadEnvironmentPresentation } from "./threadEnvironmentText";

/**
 * Above a Thread's messages while where it runs needs the User: a move under way (with its step
 * and «Cancel move» in the move screen), a turn paused because its machine is offline, or a
 * Thread whose machine was removed. The last two offer the move.
 */
export function ThreadEnvironmentNotice(props: {
  readonly thread: EnvironmentThreadShell;
  readonly runsOn: ThreadEnvironmentPresentation | null;
}) {
  const navigation = useNavigation();
  const environments = useHubEnvironments();
  const role = useThreadRolePermissions(props.thread.environmentId, props.thread.source);
  const move = props.thread.move?.status === "running" ? props.thread.move : null;
  const state = props.runsOn?.state ?? null;
  if (move === null && state === null) return null;
  const openMove = () =>
    navigation.navigate("ThreadMove", {
      environmentId: props.thread.environmentId,
      threadId: props.thread.id,
    });
  const message =
    move !== null
      ? `Moving to ${environmentNameOf(environments, move.targetEnvironmentId)}: ${moveStepLabel(move)}`
      : state === "needs-environment"
        ? "Needs an environment: the machine this Thread ran on was removed or no longer runs Threads. Move it to continue."
        : `${props.runsOn?.text ?? ""}. The turn resumes when the machine comes back, or move the Thread.`;
  return (
    <View
      accessibilityRole={move !== null ? undefined : "alert"}
      accessibilityLiveRegion="polite"
      className="mx-4 mt-2 flex-row items-center gap-3 rounded-2xl border-continuous bg-grouped-card px-4 py-3"
    >
      <Text className="flex-1 text-sm">{message}</Text>
      {!role.canContinue ? null : move !== null ? (
        <Button label="Details" size="compact" tone="secondary" onPress={openMove} />
      ) : canMoveThread({
          canContinue: role.canContinue,
          environmentCount: environments.length,
          activeEnvironmentId: props.thread.activeEnvironmentId,
        }) ? (
        <Button label="Move" size="compact" tone="secondary" onPress={openMove} />
      ) : null}
    </View>
  );
}
