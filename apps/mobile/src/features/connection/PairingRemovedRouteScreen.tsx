import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SettingsScreen } from "../settings/components/SettingsScreen";

export const PAIRING_REMOVED_MESSAGE =
  "Pairing was removed. This app connects to one Hub: sign in to yours with «Add a Hub».";

/** Where an old `t3code://pair` link lands: pairing is gone, «Add a Hub» signs in instead. */
export function PairingRemovedRouteScreen() {
  const navigation = useNavigation();
  return (
    <SettingsScreen formSheet title="Pairing was removed">
      <View className="gap-4 px-5 pt-4">
        <Text accessibilityRole="alert" className="text-base">
          {PAIRING_REMOVED_MESSAGE}
        </Text>
        <Button label="Add a Hub" onPress={() => navigation.navigate("ConnectionsNew")} fullWidth />
      </View>
    </SettingsScreen>
  );
}
