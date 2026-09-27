/** T3-CUSTOM(expbkt3): environment-scoped Linear status query for lifecycle rows. */
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const linearIssueStatusesEnvironment = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:linear-issues:resolve",
    tag: WS_METHODS.linearIssuesResolve,
    staleTimeMs: 55_000,
    idleTtlMs: 120_000,
  },
);
