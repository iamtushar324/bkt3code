// T3-CUSTOM(expbkt3): environment-scoped Linear status query for the BK sidebar.
// Same RPC and cache window as web; mobile reads it to tell sub-issues from
// main issues and to title each tag in the "open which tag?" menu.
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const linearIssueStatusesEnvironment = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "mobile:linear-issues:resolve",
    tag: WS_METHODS.linearIssuesResolve,
    staleTimeMs: 55_000,
    idleTtlMs: 120_000,
  },
);
