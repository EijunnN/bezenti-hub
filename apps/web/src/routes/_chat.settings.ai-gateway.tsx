import { createFileRoute } from "@tanstack/react-router";

import { AiGatewaySettingsPanel } from "../components/settings/AiGatewaySettings";

export const Route = createFileRoute("/_chat/settings/ai-gateway")({
  component: AiGatewaySettingsPanel,
});
