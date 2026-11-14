import { createAiGatewayEnvironmentAtoms } from "@t3tools/client-runtime/state/ai-gateway";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * The Hub's AI accounts and gateway, from the one client-runtime source web uses. Mobile reads
 * accounts, usage and the User's own local CLI keys; it never calls the Owner's sign-in, account
 * management or gateway update commands (see `noOwnerControls.test.ts`).
 */
export const aiGatewayEnvironment = createAiGatewayEnvironmentAtoms(connectionAtomRuntime);
