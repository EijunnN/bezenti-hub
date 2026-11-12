import { createAiGatewayEnvironmentAtoms } from "@t3tools/client-runtime/state/ai-gateway";

import { connectionAtomRuntime } from "../connection/runtime";

export const aiGatewayEnvironment = createAiGatewayEnvironmentAtoms(connectionAtomRuntime);
