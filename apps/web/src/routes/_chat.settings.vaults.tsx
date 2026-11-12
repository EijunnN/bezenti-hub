import { createFileRoute } from "@tanstack/react-router";

import { VaultsSettings } from "../components/settings/VaultsSettings";

export const Route = createFileRoute("/_chat/settings/vaults")({
  component: VaultsSettings,
});
