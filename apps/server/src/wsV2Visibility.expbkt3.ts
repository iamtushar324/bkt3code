// T3-CUSTOM(expbkt3): team visibility follows the native V2 shell protocol.
import type {
  OrchestrationProjectShell,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ArchivedShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ArchivedShellStreamItem,
  OrchestrationV2ThreadShell,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type {
  ShellFeed,
  ShellFeedBatch,
  ShellFeedEntry,
  ThreadAccess,
} from "./orchestration-v2/ShellFeed.expbkt3.ts";
import type { ProjectService } from "./project/ProjectService.ts";

/** Owner or tagged member. Project membership alone does not reveal a project's threads. */
export const owns = (
  value: { readonly ownerUserId?: UserId | null; readonly memberUserIds?: ReadonlyArray<UserId> },
  actor: UserId,
) => value.ownerUserId === actor || (value.memberUserIds ?? []).includes(actor);

export function filterNativeShell<
  T extends OrchestrationV2ShellSnapshot | OrchestrationV2ArchivedShellSnapshot,
>(snapshot: T, actor: UserId | null): T {
  if (actor === null) return snapshot;
  const threads = snapshot.threads.filter((thread) => owns(thread, actor));
  const archivedThreads =
    "archivedThreads" in snapshot
      ? snapshot.archivedThreads.filter((thread) => owns(thread, actor))
      : [];
  const projectIds = new Set([...threads, ...archivedThreads].map((thread) => thread.projectId));
  return {
    ...snapshot,
    threads,
    ...("archivedThreads" in snapshot ? { archivedThreads } : {}),
    projects: snapshot.projects.filter(
      (project) => owns(project, actor) || projectIds.has(project.id),
    ),
  };
}

export type ActiveShellDelta = Extract<
  OrchestrationV2ShellStreamItem,
  { readonly sequence: number }
>;
export type ArchivedShellDelta = Exclude<
  OrchestrationV2ArchivedShellStreamItem,
  { readonly kind: "snapshot" }
>;

interface ShellViewInput {
  /** `null` is an unrestricted operator: nothing is filtered. */
  readonly actor: UserId | null;
  /** Live entries at or below this sequence are already in the client's snapshot. */
  readonly afterSequence: number;
  /** The client's snapshot, already filtered for `actor`. */
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly feed: Pick<ShellFeed, "projectHasVisibleThread">;
  readonly projectService: Pick<ProjectService["Service"], "getShell">;
}

/** A synchronized client gets no live delta for an unchanged shell; this resend moves its cursor. */
const CURSOR_ADVANCE_MS = 5_000;

/**
 * One active-shell subscriber's view of the shared feed: the same team visibility as the
 * snapshot filter, evaluated in memory. A thread the client never held is not sent at all, so a
 * member never learns another user's thread id; a thread it held is removed once.
 */
export function makeActiveShellView(
  input: ShellViewInput & {
    /**
     * True when the client state came from this stream's own snapshot. A resumed client holds a
     * cache this server never saw, so removals also go to anyone who may have held the thread.
     */
    readonly complete: boolean;
  },
) {
  const { actor } = input;
  const threads = new Map(input.threads.map((thread) => [thread.id, thread] as const));
  const synced = new Set<ThreadId>();
  const projects = new Set(input.projects.map((project) => project.id));
  let lastSentSequence = input.afterSequence;
  let lastSentAt: number | undefined;

  const mayHaveHeld = (previousAccess: ThreadAccess | null | "unknown") =>
    !input.complete &&
    (actor === null ||
      previousAccess === "unknown" ||
      (previousAccess !== null && owns(previousAccess, actor)));

  const applyEntry = Effect.fnUntraced(function* (
    entry: ShellFeedEntry,
    out: Array<ActiveShellDelta>,
  ) {
    if (entry.kind === "project") {
      const project = entry.project;
      if (
        project !== null &&
        (actor === null ||
          owns(project, actor) ||
          input.feed.projectHasVisibleThread(project.id, actor))
      ) {
        projects.add(project.id);
        out.push({ kind: "project.updated", sequence: entry.sequence, project });
        return;
      }
      if (projects.delete(entry.projectId) || actor === null || !input.complete) {
        out.push({ kind: "project.removed", sequence: entry.sequence, projectId: entry.projectId });
      }
      return;
    }
    const shell = entry.shell;
    if (shell !== null && shell.archivedAt === null && (actor === null || owns(shell, actor))) {
      if (actor !== null && !projects.has(shell.projectId)) {
        const project = yield* input.projectService
          .getShell(shell.projectId)
          .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationProjectShell>()));
        if (Option.isSome(project)) {
          projects.add(project.value.id);
          out.push({ kind: "project.updated", sequence: entry.sequence, project: project.value });
        }
      }
      if (entry.changed || !synced.has(shell.id)) {
        threads.set(shell.id, shell);
        synced.add(shell.id);
        out.push({
          kind: "thread.updated",
          sequence: entry.sequence,
          location: "active",
          thread: shell,
        });
      }
      return;
    }
    synced.delete(entry.threadId);
    if (threads.delete(entry.threadId) || mayHaveHeld(entry.previousAccess)) {
      out.push({
        kind: "thread.removed",
        sequence: entry.sequence,
        location: "active",
        threadId: entry.threadId,
      });
    }
  });

  const record = (out: ReadonlyArray<ActiveShellDelta>, now: number) => {
    for (const item of out) lastSentSequence = Math.max(lastSentSequence, item.sequence);
    if (out.length > 0) lastSentAt = now;
  };

  return {
    apply: Effect.fnUntraced(function* (batch: ShellFeedBatch) {
      const out: Array<ActiveShellDelta> = [];
      for (const entry of batch.entries) {
        if (entry.sequence > input.afterSequence) yield* applyEntry(entry, out);
      }
      const now = yield* Clock.currentTimeMillis;
      lastSentAt ??= now;
      record(out, now);
      if (
        out.length === 0 &&
        batch.highSequence > lastSentSequence &&
        now - lastSentAt >= CURSOR_ADVANCE_MS
      ) {
        // Every entry up to highSequence is applied or provably unchanged for this client, so an
        // unchanged row it already holds can carry that sequence.
        const held = threads.values().next();
        if (held.done !== true) {
          out.push({
            kind: "thread.updated",
            sequence: batch.highSequence,
            location: "active",
            thread: held.value,
          });
          record(out, now);
        }
      }
      return out as ReadonlyArray<ActiveShellDelta>;
    }),
    /** A resume gap's entries, all at or below the live start. */
    applyReplay: Effect.fnUntraced(function* (entries: ReadonlyArray<ShellFeedEntry>) {
      const out: Array<ActiveShellDelta> = [];
      for (const entry of entries) yield* applyEntry(entry, out);
      record(out, yield* Clock.currentTimeMillis);
      return out as ReadonlyArray<ActiveShellDelta>;
    }),
    /** Repository identity refreshes name only projects this client already sees or owns. */
    filterEnrichment: (
      item: Extract<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }>,
    ): Extract<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }> =>
      actor === null
        ? item
        : {
            ...item,
            snapshot: {
              ...item.snapshot,
              projects: item.snapshot.projects.filter(
                (project) => projects.has(project.id) || owns(project, actor),
              ),
            },
          },
  };
}

/**
 * One archived-shell subscriber's view of the shared feed. Archived streams always start from a
 * full archived snapshot, so the client's rows are known exactly.
 */
export function makeArchivedShellView(
  input: Pick<ShellViewInput, "actor" | "afterSequence" | "threads">,
) {
  const { actor } = input;
  const threads = new Set(input.threads.map((thread) => thread.id));
  const synced = new Set<ThreadId>();
  return {
    apply: (batch: ShellFeedBatch): ReadonlyArray<ArchivedShellDelta> => {
      const out: Array<ArchivedShellDelta> = [];
      for (const entry of batch.entries) {
        if (entry.kind !== "thread" || entry.sequence <= input.afterSequence) continue;
        const shell = entry.shell;
        if (shell !== null && shell.archivedAt !== null && (actor === null || owns(shell, actor))) {
          if (entry.changed || !synced.has(shell.id)) {
            threads.add(shell.id);
            synced.add(shell.id);
            out.push({ kind: "thread.updated", sequence: entry.sequence, thread: shell });
          }
          continue;
        }
        synced.delete(entry.threadId);
        if (threads.delete(entry.threadId)) {
          out.push({ kind: "thread.removed", sequence: entry.sequence, threadId: entry.threadId });
        }
      }
      return out;
    },
  };
}
