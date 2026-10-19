/**
 * T3-CUSTOM(expbkt3): which threads a periodic pull-request sweep checks.
 *
 * Each check starts several git processes, and every start forks the whole
 * server process on the event loop. With 1,100 unsettled threads the sweep ran
 * for 50-95 s of every two minutes and kept the loop saturated, so clients
 * timed out while connecting. A thread with no run or message for a day is
 * now checked on a rotation, once every IDLE_SWEEP_EVERY_PASSES all-thread
 * passes. Its own events (a run ending, a checkpoint, an unsettle) still queue
 * an immediate one-thread check, so activity is never waited on.
 */
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const IDLE_SWEEP_AFTER_MS = 24 * 60 * 60 * 1000;
export const IDLE_SWEEP_EVERY_PASSES = 30;

type SweepThread = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "activeRunId"
  | "activityRunStatus"
  | "createdAt"
  | "latestUserMessageAt"
  | "latestRunRequestedAt"
  | "latestRunStartedAt"
  | "latestRunCompletedAt"
>;

const latestActivityMs = (thread: SweepThread) =>
  Math.max(
    ...[
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestRunRequestedAt,
      thread.latestRunStartedAt,
      thread.latestRunCompletedAt,
    ].map((at) => (at == null ? Number.NEGATIVE_INFINITY : DateTime.toEpochMillis(at))),
  );

export const isIdleForSweep = (thread: SweepThread, nowMs: number) =>
  thread.activeRunId === null &&
  thread.activityRunStatus == null &&
  nowMs - latestActivityMs(thread) >= IDLE_SWEEP_AFTER_MS;

/** The pass, modulo IDLE_SWEEP_EVERY_PASSES, on which an idle thread is checked. */
export const idleSweepSlot = (threadId: string) => {
  let hash = 0;
  for (let index = 0; index < threadId.length; index += 1) {
    hash = (Math.imul(hash, 31) + threadId.charCodeAt(index)) >>> 0;
  }
  return hash % IDLE_SWEEP_EVERY_PASSES;
};

/** Whether all-thread pass number `pass` checks this thread. */
export const includeInPeriodicSweep = (thread: SweepThread, nowMs: number, pass: number) =>
  !isIdleForSweep(thread, nowMs) || idleSweepSlot(thread.id) === pass % IDLE_SWEEP_EVERY_PASSES;
