import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import Constants from "expo-constants";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import { LEGAL_URL } from "./lib/legal-document-url";

export function SettingsAboutRouteScreen() {
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title="About">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <AppSettingsSection />
      </ScrollView>
    </SettingsScreen>
  );
}

function AppSettingsSection() {
  const version = Constants.expoConfig?.version ?? "0.0.0";
  // Match app.config.ts's production fallback to avoid mislabeling builds as development.
  const variant = (Constants.expoConfig?.extra?.appVariant as string | undefined) ?? "production";
  const variantLabel = variant === "production" ? "" : capitalize(variant);
  const versionLabel = variantLabel ? `${version} · ${variantLabel}` : version;

  return (
    <SettingsSection title="App">
      <SettingsRow icon="internaldrive" label="Client Storage" target="SettingsClientStorage" />
      <SettingsRow icon="stethoscope" label="Diagnostics" target="SettingsDiagnostics" />
      <SettingsRow
        icon="doc.on.doc"
        label="Open source licenses"
        target="SettingsOpenSourceLicenses"
      />
      {LEGAL_URL === null ? null : (
        <SettingsRow icon="doc.text" label="Legal" fullScreenTarget="SettingsLegal" />
      )}
      <View className="flex-row items-center gap-4 p-4">
        <SymbolView
          name="info.circle"
          size={22}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
        <Text className="flex-1 text-lg text-foreground">Version</Text>
        <Text className="text-lg text-foreground-muted">{versionLabel}</Text>
      </View>
    </SettingsSection>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
