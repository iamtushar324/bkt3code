import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { McpSchema, Toolkit } from "effect/ai";

import { ServerSettingsService } from "../../../serverSettings.ts";
import { T3ControlToolkit, T3SubmitPlanTool } from "./tools.ts";

/**
 * The control toolkit as `/mcp` lists it: `t3_submit_plan` follows the saved
 * server-wide plan policy. McpHttpServer registers it (its handlers are
 * McpToolAccess declarations) and passes the tools/list_changed notification
 * to `watchPolicy`, which keeps existing MCP sessions in sync with the policy.
 */
export const makeT3ControlToolkit = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const changes = yield* settings.subscribeChanges;
  let enabled = (yield* settings.getSettings.pipe(Effect.orDie)).experimental
    .agentPlanSubmissionEnabled;
  const toolkit = Toolkit.make(
    ...Object.values({
      ...T3ControlToolkit.tools,
      t3_submit_plan: T3SubmitPlanTool.annotate(McpSchema.EnabledWhen, () => enabled),
    }),
  );
  const watchPolicy = <E, R>(notifyToolsChanged: Effect.Effect<unknown, E, R>) =>
    changes.pipe(
      Stream.runForEach((current) =>
        Effect.gen(function* () {
          const next = current.experimental.agentPlanSubmissionEnabled;
          if (next === enabled) return;
          enabled = next;
          yield* notifyToolsChanged.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("Could not notify MCP clients of the plan policy change", {
                    cause,
                  }),
            ),
          );
        }),
      ),
      Effect.forkScoped,
    );
  return { toolkit, watchPolicy };
});
