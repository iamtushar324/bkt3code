/** T3-CUSTOM(expbkt3): Register the control tools with live server experiment gates. */
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";

import { T3ControlToolkitHandlersLive } from "./handlers.ts";
import { registerWithPlanSubmissionGate } from "./planSubmissionGate.ts";
import { T3ControlToolkit } from "./tools.ts";

export const T3ControlToolkitRegistrationLive = Layer.effectDiscard(
  registerWithPlanSubmissionGate(McpServer.registerToolkit(T3ControlToolkit)),
).pipe(Layer.provide(T3ControlToolkitHandlersLive), Layer.provide(McpServer.McpServer.layer));
