// T3-CUSTOM(expbkt3): per-thread API-level cost atoms bound to the mobile connection.
import { createThreadUsageEnvironmentAtoms } from "@t3tools/client-runtime/state/threadUsage";

import { connectionAtomRuntime } from "../connection/runtime";

export const threadUsageEnvironment = createThreadUsageEnvironmentAtoms(connectionAtomRuntime);
