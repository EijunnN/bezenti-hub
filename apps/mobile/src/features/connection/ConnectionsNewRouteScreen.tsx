import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import * as Haptics from "expo-haptics";
import {
  StackActions,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { AppText as Text, AppTextInput, type AppTextInputProps } from "../../components/ui/AppText";
import { parsePairingUrl } from "./pairing";
import { pairEnvironment, signInToHub } from "../../state/use-remote-environment-registry";
import { autoConnectReport, devAutoConnectAttemptAtom } from "./devAutoConnect";
import { leaveSettingsPage } from "../settings/settings-navigation";
import { workspaceHasColumns } from "../workspace/workspace-selection-store";

type ConnectionsNewRouteParams = {
  readonly mode?: string;
  readonly pairingUrl?: string;
  readonly autoConnect?: string;
  readonly routeFor?: EnvironmentId;
};

export function ConnectionsNewRouteScreen({
  route,
}: StaticScreenProps<ConnectionsNewRouteParams | undefined>) {
  const params = route.params ?? {};
  // Dev-only prefill prevents production links from supplying an attacker-chosen host and token.
  const routePairingUrl = __DEV__ ? (params.pairingUrl?.trim() ?? "") : "";
  // A new prefill link replaces whatever the form held.
  return (
    <PairingForm
      key={routePairingUrl}
      routePairingUrl={routePairingUrl}
      routeFor={params.routeFor}
    />
  );
}

function PairingForm({
  routePairingUrl,
  routeFor,
}: {
  readonly routePairingUrl: string;
  readonly routeFor: EnvironmentId | undefined;
}) {
  const navigation = useNavigation();
  const routeName = useRoute().name;
  const insets = useSafeAreaInsets();
  // A dev link prefills the address; its pairing code still pairs in a development build.
  const [addressInput, setAddressInput] = useState(routePairingUrl);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // The user's own edit or submit dismisses the dev auto-connect report.
  const [ownAttempt, setOwnAttempt] = useState(false);
  const autoConnect = autoConnectReport(
    useAtomValue(devAutoConnectAttemptAtom),
    routePairingUrl,
    ownAttempt,
  );
  const connecting = isSubmitting || autoConnect.connecting;
  const pairingConnectionError = submitError ?? autoConnect.error;

  const headerIconColor = useUniwindTheme()["--color-icon"];

  const connectDisabled = connecting || addressInput.trim().length === 0;

  const handleAddressChange = (value: string) => {
    setAddressInput(value);
    setSubmitError(null);
    setOwnAttempt(true);
  };

  const finish = (outcome: { readonly ok: boolean; readonly error: string | null }) => {
    setIsSubmitting(false);
    setSubmitError(outcome.error);
    void Haptics.notificationAsync(
      outcome.ok
        ? Haptics.NotificationFeedbackType.Success
        : Haptics.NotificationFeedbackType.Error,
    );
    if (!outcome.ok) return;
    // Replacing with Home would nest it inside any sheet below; return to the opener.
    if (!navigation.canGoBack()) {
      navigation.dispatch(StackActions.replace("Home"));
    } else {
      // Added from the Settings list, the new environment shows on Environments.
      leaveSettingsPage(navigation, workspaceHasColumns(), "SettingsEnvironments");
    }
  };

  const pair = async (pairingUrl: string) => {
    setOwnAttempt(true);
    setSubmitError(null);
    setIsSubmitting(true);
    finish(await pairEnvironment(pairingUrl, routeFor));
  };

  const handleSubmit = async () => {
    const address = addressInput.trim();
    // This app signs in to its Hub. Only a development build still pairs, from the dev link that
    // prefilled the form, so test runs can connect a local Hub without a browser.
    if (__DEV__ && address === routePairingUrl && parsePairingUrl(address).code !== "") {
      await pair(address);
      return;
    }
    setOwnAttempt(true);
    setSubmitError(null);
    setIsSubmitting(true);
    const outcome = await signInToHub(address, routeFor);
    if (outcome.cancelled) {
      setIsSubmitting(false);
      return;
    }
    finish(outcome);
  };

  return (
    <SettingsScreen
      formSheet={routeName === "ConnectionsNew"}
      title="Add a Hub"
      actions={[
        {
          accessibilityLabel: connecting ? "Signing in" : "Sign in",
          loading: connecting,
          icon: "checkmark",
          tintColor: headerIconColor,
          disabled: connectDisabled,
          onPress: () => {
            void handleSubmit();
          },
        },
      ]}
    >
      <ScrollView
        nestedScrollEnabled
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 4,
        }}
      >
        <View collapsable={false} className="gap-6.5">
          <View collapsable={false} className="gap-2">
            <View
              collapsable={false}
              className={cn(
                "overflow-hidden rounded-[26px] border-continuous border bg-grouped-card",
                pairingConnectionError ? "border-danger-foreground" : "border-transparent",
              )}
            >
              <PairingInputRow
                label="Hub"
                keyboardType="url"
                placeholder="hub.example.com"
                returnKeyType="go"
                value={addressInput}
                onChangeText={handleAddressChange}
                onSubmitEditing={() => {
                  if (!connectDisabled) void handleSubmit();
                }}
              />
            </View>
            <Text
              accessibilityLiveRegion="polite"
              className={cn(
                "px-4 text-sm leading-normal",
                pairingConnectionError ? "text-danger-foreground" : "text-foreground-muted",
              )}
            >
              {pairingConnectionError ??
                "Enter your Hub's address. You sign in with your passkey or password in the browser, then come back here."}
            </Text>
          </View>
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

function PairingInputRow({
  label,
  ...inputProps
}: Omit<AppTextInputProps, "accessibilityLabel" | "className"> & {
  readonly label: string;
}) {
  return (
    <View collapsable={false} className="h-13 flex-row items-center gap-3 px-4">
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="w-20 text-base leading-[23px] text-foreground-muted"
      >
        {label}
      </Text>
      <AppTextInput
        {...inputProps}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        className="min-h-0 flex-1 rounded-none border-0 bg-transparent p-0 text-base leading-[23px]"
      />
    </View>
  );
}
