import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, Toolkit } from "effect/unstable/ai";

import { ServerSettingsService } from "../../../serverSettings.ts";
import { T3ControlToolkit, T3SubmitPlanTool } from "./tools.ts";

/** Keep existing MCP sessions in sync with the saved server-wide plan policy. */
export const registerT3ControlToolkit = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const changes = yield* settings.subscribeChanges;
  let enabled = (yield* settings.getSettings.pipe(Effect.orDie)).experimental
    .agentPlanSubmissionEnabled;
  const server = yield* McpServer.McpServer;
  const toolkit = Toolkit.make(
    ...Object.values({
      ...T3ControlToolkit.tools,
      t3_submit_plan: T3SubmitPlanTool.annotate(McpSchema.EnabledWhen, () => enabled),
    }),
  );
  yield* McpServer.registerToolkit(toolkit);
  yield* changes.pipe(
    Stream.runForEach((current) =>
      Effect.gen(function* () {
        const next = current.experimental.agentPlanSubmissionEnabled;
        if (next === enabled) return;
        enabled = next;
        yield* server.notifications["notifications/tools/list_changed"]({}).pipe(
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
});
