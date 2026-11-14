import { useAtomValue } from "@effect/atom-react";
import { ownKeys } from "@t3tools/client-runtime/ai-accounts-view";
import type { AiGatewayKeyListResult, AiGatewayUserKey, EnvironmentId } from "@t3tools/contracts";
import { gatewayOrigin, localCliSetup } from "@t3tools/shared/aiGatewayLocalCli";
import * as Redacted from "effect/Redacted";
import { useEffect, useEffectEvent, useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListSection } from "../../components/ui/ListSection";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { aiGatewayEnvironment } from "../../state/aiGateway";
import { readHubLinkOrigin } from "../../state/hubLinks";
import { useSpaceSelections } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailureMessage } from "./failureMessage";

const DEFAULT_KEY_NAME = "From my phone";

/**
 * The User's own local CLI keys (spec 4 ticket 10) on a phone: make one (for their Personal
 * space), copy it once at creation, revoke. The Hub never lists a key again and shows none here.
 * Making and revoking follow the session's grant for the command; the Hub decides again.
 */
export function LocalCliKeys(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const list = useAtomCommand(aiGatewayEnvironment.listKeys, "list your local CLI keys");
  const create = useAtomCommand(aiGatewayEnvironment.createKey, "make a local CLI key");
  const revoke = useAtomCommand(aiGatewayEnvironment.revokeKey, "revoke a local CLI key");
  const mayCreate = useAtomValue(aiGatewayEnvironment.createKey.permissionAtom(environmentId));
  const mayRevoke = useAtomValue(aiGatewayEnvironment.revokeKey.permissionAtom(environmentId));
  const viewerId = useSpaceSelections().get(environmentId)?.view?.userId ?? null;
  const [listed, setListed] = useState<AiGatewayKeyListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [made, setMade] = useState<{
    readonly key: AiGatewayUserKey;
    readonly secret: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useEffectEvent((target: EnvironmentId) =>
    list({ environmentId: target, input: {} }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the User's own local CLI keys from the Hub when the section opens.
  useEffect(() => {
    let cancelled = false;
    void load(environmentId).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") setListed(result.value);
      else setError(commandFailureMessage(result, "Could not read your local CLI keys."));
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  const mine = listed === null ? [] : ownKeys(listed.keys, viewerId);
  const origin = gatewayOrigin(readHubLinkOrigin(environmentId) ?? "");
  const setup = made === null || origin === null ? null : localCliSetup(origin, made.secret);

  const make = async () => {
    setPending(true);
    setError(null);
    const result = await create({
      environmentId,
      input: { name: name.trim().length === 0 ? DEFAULT_KEY_NAME : name.trim() },
    });
    if (result._tag === "Success") {
      setMade({ key: result.value.created, secret: Redacted.value(result.value.key) });
      setName("");
      const refreshed = await list({ environmentId, input: {} });
      if (refreshed._tag === "Success") setListed(refreshed.value);
    } else {
      setError(commandFailureMessage(result, "Could not make the key."));
    }
    setPending(false);
  };

  const copy = async (what: string, value: string) => {
    setNotice((await tryCopyTextWithHaptic(value)) ? `${what} copied.` : "Could not copy it.");
  };

  const drop = async (key: AiGatewayUserKey) => {
    setPending(true);
    const result = await revoke({ environmentId, input: { keyId: key.keyId } });
    if (result._tag === "Success") {
      setListed(result.value);
      if (made?.key.keyId === key.keyId) setMade(null);
      setError(null);
    } else {
      setError(commandFailureMessage(result, "Could not revoke the key."));
    }
    setPending(false);
  };

  return (
    <ListSection
      title="Local CLI keys"
      footer="Point Claude Code or Codex on your own machine at this Hub's AI gateway. A key is shown once, when you make it."
    >
      {error === null ? null : (
        <Text accessibilityRole="alert" className="px-4 py-2 text-sm text-danger-foreground">
          {error}
        </Text>
      )}
      {made === null ? null : (
        <View className="gap-2 px-4 py-3">
          <Text className="text-sm text-foreground">
            Copy «{made.key.name}» now: it is not shown again. Anyone with it uses your AI accounts.
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Button label="Copy key" size="compact" onPress={() => void copy("Key", made.secret)} />
            {setup === null ? null : (
              <>
                <Button
                  label="Copy Claude Code setup"
                  size="compact"
                  onPress={() => void copy("Setup", setup.claudeCode)}
                />
                <Button
                  label="Copy Codex setup"
                  size="compact"
                  onPress={() => void copy("Setup", setup.codex)}
                />
              </>
            )}
            <Button
              label="Done"
              tone="text"
              size="compact"
              onPress={() => {
                setMade(null);
                setNotice(null);
              }}
            />
          </View>
          {notice === null ? null : (
            <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
              {notice}
            </Text>
          )}
        </View>
      )}
      {listed === null ? null : mine.length === 0 ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">No local CLI key yet.</Text>
      ) : (
        mine.map((key) => (
          <View key={key.keyId} className="gap-1 px-4 py-3">
            <Text className="text-base text-foreground">{key.name}</Text>
            <Text className="text-xs text-foreground-muted">
              {key.spaceName ?? "A Space that no longer exists"}
              {key.userName === null ? "" : ` · ${key.userName}`}
              {key.lastUsedAt === null ? " · never used" : ` · used ${key.lastUsedAt}`}
            </Text>
            {mayRevoke ? (
              <Button
                label="Revoke"
                accessibilityLabel={`Revoke ${key.name}`}
                tone="danger"
                size="compact"
                disabled={pending}
                onPress={() => void drop(key)}
              />
            ) : null}
          </View>
        ))
      )}
      {mayCreate ? (
        <View className="gap-2 px-4 py-3">
          <TextInput
            accessibilityLabel="Key name"
            placeholder={DEFAULT_KEY_NAME}
            value={name}
            onChangeText={setName}
            editable={!pending}
            autoCorrect={false}
            spellCheck={false}
          />
          <Button
            label="Make key"
            accessibilityLabel="Make a key"
            tone="primary"
            size="compact"
            disabled={pending}
            onPress={() => void make()}
          />
        </View>
      ) : null}
    </ListSection>
  );
}
