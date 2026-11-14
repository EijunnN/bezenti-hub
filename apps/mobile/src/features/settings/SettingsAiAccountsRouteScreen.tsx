import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useHubConnection } from "../../state/use-remote-environment-registry";
import { AiAccountsList } from "../ai-accounts/AiAccountsList";
import { LocalCliKeys } from "../ai-accounts/LocalCliKeys";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsAiAccountsRouteScreen() {
  const hub = useHubConnection();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="AI accounts">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {hub === null ? (
          <Text className="text-foreground-muted">
            AI accounts live on a Hub: connect to one first.
          </Text>
        ) : (
          <>
            <AiAccountsList environmentId={hub.environmentId} />
            <LocalCliKeys environmentId={hub.environmentId} />
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
