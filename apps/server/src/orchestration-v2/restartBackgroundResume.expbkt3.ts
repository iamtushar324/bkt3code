// T3-CUSTOM(expbkt3): wake a settled run whose background work a server restart cancelled.
//
// Upstream (#15604) resumes only an unfinished root turn after a restart and
// reports cancelled background work on the next user turn. An agent that had
// finished its turn and was waiting on a Monitor, a background shell or a
// subagent is then idle until a human types. The fork queues the same
// `provider-runtime.continue` effect for that settled run, so the agent is
// prompted with the restart note and can re-arm what it still needs.
//
// Gated by `T3_RESTART_WAKE_SETTLED_BACKGROUND` (on in deploy/stage/start.sh) on top
// of `continueThreadsAfterServerUpdate`: upstream's own tests assert that a
// settled run stays asleep, and the switch lets a merge regression be isolated.
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import {
  CommandId,
  type OrchestrationV2Run,
  type ProviderThreadId,
  type RunId,
} from "@t3tools/contracts";

import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";

export const RESTART_WAKE_ENV = "T3_RESTART_WAKE_SETTLED_BACKGROUND";

export function settledBackgroundWakeEnabled(): boolean {
  const configured = process.env[RESTART_WAKE_ENV]?.trim().toLowerCase();
  return configured === "1" || configured === "true" || configured === "on";
}

type WakeProjection = Pick<
  ProjectionRuntimeRecoveryState,
  "thread" | "runs" | "providerThreads" | "providerSessions" | "turnItems"
>;

type Item = WakeProjection["turnItems"][number];

function isBackgroundWorkItem(item: Item): boolean {
  if (item.status !== "pending" && item.status !== "running" && item.status !== "waiting")
    return false;
  if (item.type === "subagent") {
    // A delegate_task child reports back through the app; it is not lost.
    return !(item.origin === "app_owned" && item.childThreadId !== null);
  }
  return item.type === "command_execution" || item.type === "dynamic_tool";
}

/**
 * Provider threads whose background work shutdown reconciliation is about to
 * cancel: open background-capable items and the provider-reported roster.
 * Startup recovery passes the work it actually cancelled instead.
 */
function providerThreadsWithOpenBackgroundWork(
  projection: WakeProjection,
): ReadonlySet<ProviderThreadId> {
  const ids = new Set<ProviderThreadId>();
  for (const item of projection.turnItems) {
    if (!isBackgroundWorkItem(item)) continue;
    const providerThreadId =
      item.providerThreadId ??
      projection.runs.find((run) => run.id === item.runId)?.providerThreadId;
    if (providerThreadId != null) ids.add(providerThreadId);
  }
  for (const thread of projection.providerThreads) {
    if (thread.ownerNodeId === null && (thread.pendingBackgroundTasks?.length ?? 0) > 0)
      ids.add(thread.id);
  }
  return ids;
}

/**
 * The settled run to wake after a restart, if any. Mirrors the guards of
 * `restartContinuationRun`, with two additions: the provider session must have
 * been live when the restart hit (a stopped session's open records are stale
 * leftovers, which is what #15604 guarded against), and only a top-level
 * thread with no queued work is woken.
 *
 * `lostWork` holds the provider threads whose background work startup
 * recovery cancelled; without it the projection's open work is used, which is
 * what shutdown preparation sees before reconciliation cancels it.
 */
export function settledBackgroundWakeRun(
  projection: WakeProjection,
  lostWork?: { readonly has: (providerThreadId: ProviderThreadId) => boolean },
): OrchestrationV2Run | undefined {
  if (!settledBackgroundWakeEnabled()) return;
  const { thread } = projection;
  if (thread.archivedAt !== null || thread.deletedAt !== null) return;
  // A delegated child already reported its result when its turn settled.
  if (thread.lineage.relationshipToParent === "subagent") return;
  // The user's queued message carries the note when the queue is released.
  if (projection.runs.some((run) => run.status === "queued")) return;
  const run = projection.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, candidate) => (!latest || runRanAfter(candidate, latest) ? candidate : latest),
    undefined,
  );
  if (!run || (run.status !== "completed" && run.status !== "waiting")) return;
  if (run.providerThreadId === null) return;
  if (!(lostWork ?? providerThreadsWithOpenBackgroundWork(projection)).has(run.providerThreadId))
    return;
  if (thread.providerInstanceId !== run.providerInstanceId) return;
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  if (
    !providerThread ||
    providerThread.appThreadId !== thread.id ||
    providerThread.ownerNodeId !== null ||
    providerThread.providerInstanceId !== run.providerInstanceId ||
    providerThread.nativeThreadRef?.nativeId == null ||
    providerThread.nativeThreadRef.strength !== "strong" ||
    providerThread.nativeThreadRef.driver !== providerThread.driver ||
    providerThread.status === "closed" ||
    providerThread.status === "archived"
  )
    return;
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread.providerSessionId,
  );
  if (
    session === undefined ||
    session.providerInstanceId !== run.providerInstanceId ||
    session.driver !== providerThread.driver ||
    session.status === "stopped" ||
    session.status === "error"
  )
    return;
  return run;
}

/**
 * Marks the continuation effect of a woken settled run. Upstream continuations
 * only ever target a running (or admitted, starting) run, so they stay unmarked.
 */
export function settledBackgroundWakeRequest(run: Pick<OrchestrationV2Run, "status">): {
  readonly wakeSettledRun?: true;
} {
  return run.status === "completed" || run.status === "waiting" ? { wakeSettledRun: true } : {};
}

/** The wake's own command id, which the orchestrator admits for a settled source. */
export const settledBackgroundWakeCommandId = (sourceRunId: RunId) =>
  CommandId.make(`command:restart-background-wake:${sourceRunId}`);

/** The wake prompt: the restart note, then what the agent is expected to do. */
export function settledBackgroundWakePrompt(note: string): string {
  return `${note}\n\nYour last turn had already finished. Start again any of this work you still need (re-arm monitors and watchers, relaunch subagents or background commands), then carry on. If none of it is needed any more, say so briefly and stop.`;
}
