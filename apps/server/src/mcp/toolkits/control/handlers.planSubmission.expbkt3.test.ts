/** T3-CUSTOM(expbkt3): A stale tool list cannot create a plan or review after the setting is disabled. */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../../../serverSettings.ts";
import { OrchestrationCommandDispatcher } from "../../../orchestration/dispatchCommand.ts";
import { OrchestrationAccessControl } from "../../../orchestration/Services/AccessControl.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PlannotatorManager } from "../../../plannotator/PlannotatorManager.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { __testing } from "./handlers.ts";

it.effect("rejects a disabled submission before it accesses any plan or review service", () =>
  Effect.gen(function* () {
    const error = yield* __testing
      .submitPlan({ format: "md", content: "# Plan" })
      .pipe(Effect.flip);
    expect(error.operation).toBe("submit-plan");
    expect(error.message).toBe(
      "The plan submission tool is disabled. Write the plan in chat instead.",
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettingsService.layerTest(),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: () => Effect.die("The disabled tool accessed a thread."),
        }),
        Layer.mock(OrchestrationCommandDispatcher)({
          dispatch: () => Effect.die("The disabled tool wrote a plan."),
        }),
        Layer.mock(PlannotatorManager)({
          start: () => Effect.die("The disabled tool started a review."),
        }),
        Layer.mock(OrchestrationAccessControl)({ actorFor: () => Option.none() }),
        Layer.succeed(McpInvocationContext, {
          principal: "provider-session",
          actorUserId: null,
          environmentId: EnvironmentId.make("plan-disabled-test"),
          threadId: ThreadId.make("plan-disabled-test"),
          providerSessionId: "plan-disabled-test",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["t3.plan"] as const),
          issuedAt: 1,
        }),
        NodeServices.layer,
      ),
    ),
  ),
);
