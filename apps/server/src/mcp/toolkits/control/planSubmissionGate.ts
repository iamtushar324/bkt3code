/** T3-CUSTOM(expbkt3): Hide and reject the plan submission tool until the server experiment is enabled. */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { ServerSettingsService } from "../../../serverSettings.ts";

/** Keep the normal toolkit registration and its handlers; only change plan tool visibility. */
export const registerWithPlanSubmissionGate = Effect.fn("McpControl.registerPlanSubmissionGate")(
  function* <E, R>(registerTools: Effect.Effect<void, E, R>) {
    const server = yield* McpServer.McpServer;
    const settingsService = yield* ServerSettingsService;
    // Acquire the subscription before the snapshot so a concurrent settings update cannot be lost.
    const changes = yield* settingsService.subscribeChanges;
    let enabled = (yield* settingsService.getSettings).experimental.planSubmissionToolEnabled;

    yield* Stream.runForEach(changes, (settings) =>
      Effect.gen(function* () {
        const nextEnabled = settings.experimental.planSubmissionToolEnabled;
        if (enabled === nextEnabled) return;
        enabled = nextEnabled;
        yield* server.notifications["notifications/tools/list_changed"]({});
      }),
    ).pipe(Effect.forkScoped);

    yield* registerTools.pipe(
      Effect.provideService(McpServer.McpServer, {
        ...server,
        addTool: (options) =>
          server.addTool(
            options.tool.name === "t3_submit_plan"
              ? {
                  ...options,
                  annotations: Context.add(
                    options.annotations,
                    McpSchema.EnabledWhen,
                    () => enabled,
                  ),
                }
              : options,
          ),
      }),
    );
  },
);
