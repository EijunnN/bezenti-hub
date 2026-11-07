import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListSection } from "../../components/ui/ListSection";
import { removeKeptConnection, chooseKeptConnectionAsHub } from "../../connection/onboarding";
import { type KeptConnection, useHubState } from "../../connection/singleHub";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

/** What the kept connections' section says, with or without a Hub. */
export function keptConnectionsFooter(hasHub: boolean): string {
  return hasHub
    ? "This app connects to one Hub and sees every Thread there, whichever machine runs it. These connections were saved before and stay on this phone, unconnected. To use one instead, remove your Hub first."
    : "Choose your Hub: this app connects to one Hub and sees every Thread there. None of these answered as a Hub, so none is connected until you choose.";
}

/**
 * Connections saved before this app connected to one Hub: never deleted silently, never
 * connected on their own. Each can be removed, or, while there is no Hub, used as the Hub.
 */
export function KeptSavedConnectionsNotice() {
  const { hub, kept } = useHubState();
  const remove = useAtomCommand(removeKeptConnection, { reportFailure: false });
  const chooseAsHub = useAtomCommand(chooseKeptConnectionAsHub, { reportFailure: false });
  const [pending, setPending] = useState<string | null>(null);
  if (kept.length === 0) return null;
  const run = async (connection: KeptConnection, action: "remove" | "use") => {
    setPending(connection.environmentId);
    const result =
      action === "remove" ? await remove(connection.environmentId) : await chooseAsHub(connection);
    setPending(null);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        action === "remove" ? "Could not remove it" : "Could not use it as your Hub",
        error instanceof Error ? error.message : "Try again.",
      );
    }
  };
  return (
    <ListSection
      title={hub === null ? "Choose your Hub" : "Saved, not connected"}
      footer={keptConnectionsFooter(hub !== null)}
    >
      {kept.map((connection) => (
        <View key={connection.environmentId} className="flex-row items-center gap-2 px-4 py-3">
          <Text className="flex-1 text-base" numberOfLines={1}>
            {connection.label}
          </Text>
          {hub === null ? (
            <Button
              label="Use as my Hub"
              accessibilityLabel={`Use ${connection.label} as my Hub`}
              size="compact"
              loading={pending === connection.environmentId}
              disabled={pending !== null}
              onPress={() => void run(connection, "use")}
            />
          ) : null}
          <Button
            label="Remove"
            accessibilityLabel={`Remove ${connection.label}`}
            size="compact"
            tone="danger"
            disabled={pending !== null}
            onPress={() => void run(connection, "remove")}
          />
        </View>
      ))}
    </ListSection>
  );
}
