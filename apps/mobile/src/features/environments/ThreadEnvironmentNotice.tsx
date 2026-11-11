import { useNavigation } from "@react-navigation/native";
import {
  SANDBOX_RETRY_LABEL,
  canMoveThread,
  environmentNameOf,
  moveStepLabel,
  startRemoteHubEnvironment,
} from "@t3tools/client-runtime/environment/hub-environments";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { runtime } from "../../lib/runtime";
import { refreshHubEnvironments, useHubEnvironments } from "../../state/hubEnvironments";
import { useThreadRolePermissions } from "../../state/spaces";
import { useHubConnection } from "../../state/use-remote-environment-registry";
import {
  type ThreadEnvironmentPresentation,
  threadEnvironmentNoticeText,
} from "./threadEnvironmentText";

/**
 * Above a Thread's messages while where it runs needs the User: a move under way (with its step
 * and «Cancel move» in the move screen), a turn paused because its machine is offline, a Thread
 * whose machine was removed, or its Sandbox starting or failed to start («Try again»). The
 * paused and removed ones offer the move.
 */
export function ThreadEnvironmentNotice(props: {
  readonly thread: EnvironmentThreadShell;
  readonly runsOn: ThreadEnvironmentPresentation | null;
}) {
  const navigation = useNavigation();
  const environments = useHubEnvironments();
  const hub = useHubConnection();
  const role = useThreadRolePermissions(props.thread.environmentId, props.thread.source);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const move = props.thread.move?.status === "running" ? props.thread.move : null;
  const state = props.runsOn?.state ?? null;
  if (move === null && state === null) return null;
  const openMove = () =>
    navigation.navigate("ThreadMove", {
      environmentId: props.thread.environmentId,
      threadId: props.thread.id,
    });
  const activeEnvironmentId = props.thread.activeEnvironmentId;
  const retry =
    hub === null || hub.bearerToken === null || activeEnvironmentId == null
      ? null
      : () => {
          setRetrying(true);
          setRetryError(null);
          void runtime
            .runPromise(
              startRemoteHubEnvironment({
                httpBaseUrl: hub.httpBaseUrl,
                bearerToken: hub.bearerToken ?? "",
                environmentId: activeEnvironmentId,
              }),
            )
            .then(
              () => refreshHubEnvironments(),
              () => setRetryError("The Sandbox could not be started. Try again later."),
            )
            .finally(() => setRetrying(false));
        };
  const message =
    move !== null
      ? `Moving to ${environmentNameOf(environments, move.targetEnvironmentId)}: ${moveStepLabel(move)}`
      : (threadEnvironmentNoticeText(props.runsOn) ?? "");
  return (
    <View
      accessibilityRole={move !== null || state === "sandbox-starting" ? undefined : "alert"}
      accessibilityLiveRegion="polite"
      className="mx-4 mt-2 flex-row items-center gap-3 rounded-2xl border-continuous bg-grouped-card px-4 py-3"
    >
      <View className="flex-1">
        <Text className="text-sm">{message}</Text>
        {retryError === null ? null : (
          <Text className="text-xs text-danger-foreground">{retryError}</Text>
        )}
      </View>
      {!role.canContinue ? null : move !== null ? (
        <Button label="Details" size="compact" tone="secondary" onPress={openMove} />
      ) : state === "sandbox-failed" ? (
        retry === null ? null : (
          <Button
            label={SANDBOX_RETRY_LABEL}
            size="compact"
            tone="secondary"
            disabled={retrying}
            onPress={retry}
          />
        )
      ) : state === "sandbox-starting" ? null : canMoveThread({
          canContinue: role.canContinue,
          environmentCount: environments.length,
          activeEnvironmentId,
        }) ? (
        <Button label="Move" size="compact" tone="secondary" onPress={openMove} />
      ) : null}
    </View>
  );
}
