/**
 * T3-CUSTOM(expbkt3): waiting for the next change a person or an agent cares
 * about, without polling.
 *
 * The cursor is an event sequence. The wait replays stored events after it
 * and then follows new ones as they commit, so a caller that passes back the
 * cursor it was given misses nothing between calls. A change is an event, not
 * a state: a request that opens, a run that ends. A session that already
 * waited before the cursor does not end the wait again; t3_inbox lists those.
 */
import type { OrchestrationV2StoredEvent, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import type { Caller } from "../../threadAccess.ts";
import { fail, visibleTo } from "./context.ts";
import { isSubagent } from "./view.ts";

export type WaitChange = "needs-human" | "finished" | "failed";

export const WAIT_CHANGES: ReadonlyArray<WaitChange> = ["needs-human", "finished", "failed"];

export interface WaitMatch {
  readonly sequence: number;
  readonly threadId: ThreadId;
  readonly change: WaitChange;
  /** What happened, in a few words. */
  readonly what: string;
}

export interface WaitOutcome {
  readonly match: WaitMatch | null;
  /** Pass this to the next wait: the newest event this one looked at. */
  readonly cursor: number;
}

const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

/** The change one stored event makes, if it is one the wait reports. */
export function changeOf(stored: OrchestrationV2StoredEvent): Omit<WaitMatch, "sequence"> | null {
  const event = stored.event;
  switch (event.type) {
    case "runtime-request.updated": {
      const request = event.payload;
      if (request.status !== "pending" || request.kind === "auth_refresh") return null;
      return {
        threadId: event.threadId,
        change: "needs-human",
        what:
          request.kind === "user_input" ? "asked a question" : `asks to approve a ${request.kind}`,
      };
    }
    case "run.updated": {
      const run = event.payload;
      if (run.status === "failed") {
        return { threadId: event.threadId, change: "failed", what: "the run failed" };
      }
      if (!FINISHED_STATUSES.has(run.status)) return null;
      return {
        threadId: event.threadId,
        change: "finished",
        what: run.status === "completed" ? "finished its turn" : `run ${run.status}`,
      };
    }
    case "turn-item.updated": {
      // A question the agent asked while it keeps working is a legacy
      // activity. Large inputs reach the stream as a one-line summary of
      // their JSON, so the kind is read from either form.
      const item = event.payload;
      if (item.type !== "dynamic_tool") return null;
      const asksQuestion =
        typeof item.input === "string"
          ? item.input.includes('"kind":"user-input.requested"')
          : Predicate.isObject(item.input) &&
            "forkLegacyActivity" in item.input &&
            Predicate.isObject(item.input.forkLegacyActivity) &&
            item.input.forkLegacyActivity.kind === "user-input.requested";
      if (!asksQuestion) return null;
      return {
        threadId: event.threadId,
        change: "needs-human",
        what: "asked a question and keeps working",
      };
    }
    default:
      return null;
  }
}

/**
 * Waits for the first change in `until` on a session the caller may see
 * (`threadIds`, or any), after `afterSequence`, for at most `timeoutMs`.
 */
export const waitForChange = Effect.fn("agentToolkit.waitForChange")(function* (input: {
  readonly caller: Caller;
  readonly afterSequence: number;
  readonly threadIds: ReadonlySet<string> | null;
  readonly until: ReadonlySet<WaitChange>;
  readonly timeoutMs: number;
  readonly includeSubagents?: boolean;
}) {
  const { caller } = input;
  const visible = visibleTo(caller.scope);
  const known = new Map<string, boolean>();
  let lastSeen = input.afterSequence;

  const mayReport = (threadId: ThreadId) =>
    Effect.gen(function* () {
      if (input.threadIds !== null) return input.threadIds.has(threadId);
      const cached = known.get(threadId);
      if (cached !== undefined) return cached;
      const shell = yield* caller.threads
        .getThreadShell(threadId)
        .pipe(Effect.orElseSucceed(() => null));
      const allowed =
        shell !== null && visible(shell) && (input.includeSubagents === true || !isSubagent(shell));
      known.set(threadId, allowed);
      return allowed;
    });

  const onlyThread =
    input.threadIds !== null && input.threadIds.size === 1
      ? ([...input.threadIds][0] as ThreadId)
      : undefined;

  const first = yield* caller.threads
    .streamStoredEventsFrom({
      afterSequence: input.afterSequence,
      ...(onlyThread === undefined ? {} : { threadId: onlyThread }),
    })
    .pipe(
      Stream.mapEffect((stored) =>
        Effect.gen(function* () {
          lastSeen = Math.max(lastSeen, stored.sequence);
          const change = changeOf(stored);
          if (change === null || !input.until.has(change.change)) return null;
          if (!(yield* mayReport(change.threadId))) return null;
          return { ...change, sequence: stored.sequence } satisfies WaitMatch;
        }),
      ),
      Stream.filter((match): match is WaitMatch => match !== null),
      Stream.runHead,
      Effect.timeoutOption(Duration.millis(input.timeoutMs)),
      Effect.mapError(() =>
        fail("unavailable", "T3 Code could not read session events just now. Try again."),
      ),
    );
  const match = Option.flatten(first);
  return {
    match: Option.getOrNull(match),
    cursor: Option.isSome(match) ? match.value.sequence : lastSeen,
  } satisfies WaitOutcome;
});
