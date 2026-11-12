import { createFileRoute } from "@tanstack/react-router";

import { AiAccountsSettingsPanel } from "../components/settings/AiAccountsSettings";

export const Route = createFileRoute("/_chat/settings/ai-accounts")({
  component: AiAccountsSettingsPanel,
});
