// T3-CUSTOM(expbkt3): retained BK behavior at the native V2 boundary.
import type { UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";

/** The authenticated caller follows native service methods without mutable actor state. */
export const CurrentOrchestrationActorUserId = Context.Reference<UserId | null>(
  "t3/fork/CurrentOrchestrationActorUserId",
  { defaultValue: () => null },
);
