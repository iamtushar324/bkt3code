// T3-CUSTOM(expbkt3): workflow runs, hooks, store and definitions carry no owner, so in team
// mode `t3_workflow` serves only callers acting for no user, external operators and org admins.
// The websocket workflow RPCs apply the same rule in `ws.ts`.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ClerkDirectory } from "../../../auth/ClerkDirectory.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const requireWorkflowOperator = Effect.fn("mcp.workflow.requireOperator")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.actorUserId === null || McpInvocationContext.isExternalMcpOperator(scope)) return;
  const directory = yield* Effect.serviceOption(ClerkDirectory);
  if (Option.isSome(directory) && (yield* directory.value.isOrgAdmin(scope.actorUserId))) return;
  return yield* new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "Workflows are available to administrators only.",
  });
});
