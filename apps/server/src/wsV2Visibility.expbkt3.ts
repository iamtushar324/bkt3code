// T3-CUSTOM(expbkt3): team visibility follows the native V2 shell protocol.
import type {
  OrchestrationProjectShell,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ArchivedShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ArchivedShellStreamItem,
  OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type {
  ShellFeed,
  ShellFeedBatch,
  ShellFeedEntry,
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
  readonly feed: Pick<ShellFeed, "projectHasVisibleThread" | "projectVisibleTo">;
  readonly projectService: Pick<ProjectService["Service"], "getShell">;
}

/** An idle client is brought up to date after this long without a delta. */
const IDLE_CONVERGE_MS = 5_000;

const sameInstant = (left: DateTime.Utc, right: DateTime.Utc) =>
  DateTime.toEpochMillis(left) === DateTime.toEpochMillis(right);

/**
 * One active-shell subscriber's view of the shared feed: the same team visibility as the
 * snapshot filter, evaluated in memory. A removal goes only to a client that could hold the row,
 * so a member never learns another user's thread or project id.
 *
 * The client reducer drops a delta at or below its cursor (a new thread at the cursor excepted),
 * so every delta here carries a sequence above the previous one, and nothing is sent above a
 * row whose newest shell the client still lacks.
 */
export function makeActiveShellView(
  input: ShellViewInput & {
    /**
     * Rows a resumed client may hold beyond its snapshot: everything the user could see at its
     * cursor (`ShellFeed.visibleAt`). Its cache is one this stream never sent.
     */
    readonly held?: {
      readonly threadIds: Iterable<ThreadId>;
      readonly projectIds: Iterable<ProjectId>;
    };
    /**
     * An unrestricted operator's resume: it may hold any row, so every removal is sent. Never set
     * for a filtered user; their removals must name a row they could see.
     */
    readonly removeUnheld?: boolean;
  },
) {
  const { actor } = input;
  const removeUnheld = actor === null && input.removeUnheld === true;
  // The exact shell the client holds for each row.
  const shells = new Map(input.threads.map((thread) => [thread.id, thread] as const));
  // Rows whose newest shell differs from the client's only in `updatedAt`, not yet sent.
  const stale = new Map<
    ThreadId,
    { readonly shell: OrchestrationV2ThreadShell; readonly sequence: number }
  >();
  const heldThreads = new Set<ThreadId>([...shells.keys(), ...(input.held?.threadIds ?? [])]);
  const synced = new Set<ThreadId>();
  const projects = new Set<ProjectId>([
    ...input.projects.map((project) => project.id),
    ...(input.held?.projectIds ?? []),
  ]);
  // Projects the user stopped seeing when it lost their last thread. The thread's removal took
  // that sequence, so each waits for a later one.
  const hiddenProjects = new Set<ProjectId>();
  let lastSentSequence = input.afterSequence;
  let lastSentAt: number | undefined;
  let feedHighSequence = input.afterSequence;

  // Stale rows below `sequence` go first, at their own sequences: the cursor never passes them.
  const flushStale = (sequence: number, out: Array<ActiveShellDelta>) => {
    const due = [...stale.values()]
      .filter((row) => row.sequence < sequence)
      .sort((left, right) => left.sequence - right.sequence);
    for (const row of due) {
      stale.delete(row.shell.id);
      shells.set(row.shell.id, row.shell);
      out.push({
        kind: "thread.updated",
        sequence: row.sequence,
        location: "active",
        thread: row.shell,
      });
    }
  };

  const emit = (item: ActiveShellDelta, out: Array<ActiveShellDelta>) => {
    flushStale(item.sequence, out);
    out.push(item);
  };

  const projectVisible = (project: OrchestrationProjectShell) =>
    actor === null || owns(project, actor) || input.feed.projectHasVisibleThread(project.id, actor);

  const applyEntry = Effect.fnUntraced(function* (
    entry: ShellFeedEntry,
    out: Array<ActiveShellDelta>,
  ) {
    if (entry.kind === "project") {
      hiddenProjects.delete(entry.projectId);
      const project = entry.project;
      if (project !== null && projectVisible(project)) {
        projects.add(project.id);
        emit({ kind: "project.updated", sequence: entry.sequence, project }, out);
        return;
      }
      if (projects.delete(entry.projectId) || removeUnheld) {
        emit(
          { kind: "project.removed", sequence: entry.sequence, projectId: entry.projectId },
          out,
        );
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
          hiddenProjects.delete(project.value.id);
          emit({ kind: "project.updated", sequence: entry.sequence, project: project.value }, out);
        }
      }
      const held = shells.get(shell.id);
      if (entry.changed || !synced.has(shell.id) || held === undefined) {
        stale.delete(shell.id);
        emit(
          { kind: "thread.updated", sequence: entry.sequence, location: "active", thread: shell },
          out,
        );
        shells.set(shell.id, shell);
        heldThreads.add(shell.id);
        synced.add(shell.id);
      } else if (!sameInstant(shell.updatedAt, held.updatedAt)) {
        stale.set(shell.id, { shell, sequence: entry.sequence });
      } else {
        stale.delete(shell.id);
      }
      return;
    }
    const projectId = shell?.projectId ?? shells.get(entry.threadId)?.projectId;
    synced.delete(entry.threadId);
    shells.delete(entry.threadId);
    stale.delete(entry.threadId);
    if (heldThreads.delete(entry.threadId) || removeUnheld) {
      emit(
        {
          kind: "thread.removed",
          sequence: entry.sequence,
          location: "active",
          threadId: entry.threadId,
        },
        out,
      );
    }
    if (
      actor !== null &&
      projectId !== undefined &&
      projects.has(projectId) &&
      !input.feed.projectVisibleTo(projectId, actor)
    ) {
      hiddenProjects.add(projectId);
    }
  });

  /** One hidden project's removal, on a sequence above everything sent so far. */
  const removeHiddenProject = (sequence: number, out: Array<ActiveShellDelta>) => {
    for (const projectId of hiddenProjects) {
      hiddenProjects.delete(projectId);
      if (actor === null || input.feed.projectVisibleTo(projectId, actor)) continue;
      projects.delete(projectId);
      emit({ kind: "project.removed", sequence, projectId }, out);
      return;
    }
  };

  const record = (out: ReadonlyArray<ActiveShellDelta>, now: number) => {
    for (const item of out) lastSentSequence = Math.max(lastSentSequence, item.sequence);
    if (out.length > 0) lastSentAt = now;
  };

  return {
    /**
     * One merged feed batch. An empty batch with `highSequence` 0 is a timer tick: it applies
     * nothing and only lets an idle client converge.
     */
    apply: Effect.fnUntraced(function* (batch: ShellFeedBatch) {
      const now = yield* Clock.currentTimeMillis;
      lastSentAt ??= now;
      feedHighSequence = Math.max(feedHighSequence, batch.highSequence);
      const out: Array<ActiveShellDelta> = [];
      for (const entry of batch.entries) {
        if (entry.sequence > input.afterSequence) yield* applyEntry(entry, out);
      }
      const lastOut = () => Math.max(lastSentSequence, out.at(-1)?.sequence ?? 0);
      if (
        hiddenProjects.size > 0 &&
        feedHighSequence > lastOut() &&
        ![...stale.values()].some((row) => row.sequence >= feedHighSequence)
      ) {
        removeHiddenProject(feedHighSequence, out);
      }
      if (now - (out.length > 0 ? now : lastSentAt) >= IDLE_CONVERGE_MS) {
        // Idle: deliver every pending row, then let one unchanged row carry the cursor to the
        // feed's sequence. Every entry up to there is applied or held back in `stale`.
        flushStale(Number.POSITIVE_INFINITY, out);
        const held = shells.values().next();
        if (held.done !== true && feedHighSequence > lastOut()) {
          out.push({
            kind: "thread.updated",
            sequence: feedHighSequence,
            location: "active",
            thread: held.value,
          });
        }
      }
      record(out, now);
      return out as ReadonlyArray<ActiveShellDelta>;
    }),
    /** A resume gap's entries, all at or below the live start. */
    applyReplay: Effect.fnUntraced(function* (entries: ReadonlyArray<ShellFeedEntry>) {
      const out: Array<ActiveShellDelta> = [];
      for (const entry of entries) yield* applyEntry(entry, out);
      record(out, yield* Clock.currentTimeMillis);
      return out as ReadonlyArray<ActiveShellDelta>;
    }),
    /**
     * Repository identity refreshes name only projects the user can see now, by the project's
     * current audience and the threads it can see, so a revoked user gets nothing more.
     */
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
                (project) => !hiddenProjects.has(project.id) && projectVisible(project),
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
