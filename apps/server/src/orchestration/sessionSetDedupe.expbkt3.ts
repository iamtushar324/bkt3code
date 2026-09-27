/**
 * T3-CUSTOM(expbkt3): drop provider status pings that would not change the
 * projected session.
 *
 * Claude reports `system/status: requesting` on every model request inside a
 * turn, and the adapter maps each one to `session.state.changed`. Ingestion
 * used to turn every one of those into a `thread.session.set` whose only new
 * value was `updatedAt`: 2,040 of 2,666 session-set events in a 3.6 h prod
 * sample. Each one is an event row, a projection write, a push to every
 * subscriber and a replay item on reconnect.
 *
 * Only `session.state.changed` is filtered. Turn and session lifecycle events
 * always dispatch, because readers of `session.updatedAt` (reaper idle window,
 * settled-turn completion time, snooze wake-on-error) key off real
 * transitions, which are never no-ops here.
 */
import type { OrchestrationCommand, OrchestrationSession } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

type ThreadSessionSetCommand = Extract<OrchestrationCommand, { type: "thread.session.set" }>;

/** True when `next` differs from `current` in nothing but `updatedAt`. */
export const isNoOpSessionSet = (
  current: OrchestrationSession | null | undefined,
  next: OrchestrationSession,
): boolean =>
  current !== null &&
  current !== undefined &&
  current.threadId === next.threadId &&
  current.status === next.status &&
  current.providerName === next.providerName &&
  (current.providerInstanceId ?? null) === (next.providerInstanceId ?? null) &&
  (current.providerThreadId ?? null) === (next.providerThreadId ?? null) &&
  current.runtimeMode === next.runtimeMode &&
  current.activeTurnId === next.activeTurnId &&
  current.lastError === next.lastError;

/**
 * Returns a `thread.session.set` dispatcher that skips the command when it is a
 * `session.state.changed` echo of the session already projected for the thread.
 */
export const dispatchSessionSetUnlessNoOp =
  <E, R>(
    engine: {
      readonly dispatch: (command: ThreadSessionSetCommand) => Effect.Effect<unknown, E, R>;
    },
    runtimeEventType: string,
    current: OrchestrationSession | null | undefined,
  ) =>
  (command: ThreadSessionSetCommand): Effect.Effect<void, E, R> =>
    runtimeEventType === "session.state.changed" && isNoOpSessionSet(current, command.session)
      ? Effect.void
      : Effect.asVoid(engine.dispatch(command));
