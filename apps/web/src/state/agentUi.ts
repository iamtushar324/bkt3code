// T3-CUSTOM(expbkt3): agent UI surface atoms bound to the web connection.
import { createAgentUiEnvironmentAtoms } from "@t3tools/client-runtime/state/agentUi";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentUiEnvironment = createAgentUiEnvironmentAtoms(connectionAtomRuntime);
