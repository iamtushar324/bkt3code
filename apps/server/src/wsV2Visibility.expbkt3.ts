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
  readonly feed: Pick<ShellFeed, "projectHasVisibleThread">;
  readonly projectService: Pick<ProjectService["Service"], "getShell">;
}

/**
 * A synchronized client gets no delta for a shell that changed only its `updatedAt`. After this
 * long a row is resent anyway, so the client converges on the newest shell and its cursor moves.
 */
const RESEND_AFTER_MS = 5_000;

/**
 * One active-shell subscriber's view of the shared feed: the same team visibility as the
 * snapshot filter, evaluated in memory. A removal goes only to a client that could hold the row,
 * so a member never learns another user's thread or project id.
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
  // The exact shell the client has for each row, and the newest one the feed has read for it.
  const shells = new Map(input.threads.map((thread) => [thread.id, thread] as const));
  const latest = new Map(shells);
  const sentAt = new Map<ThreadId, number>();
  const heldThreads = new Set<ThreadId>([...shells.keys(), ...(input.held?.threadIds ?? [])]);
  const synced = new Set<ThreadId>();
  const projects = new Set<ProjectId>([
    ...input.projects.map((project) => project.id),
    ...(input.held?.projectIds ?? []),
  ]);
  let lastSentSequence = input.afterSequence;
  let lastSentAt: number | undefined;
  let feedHighSequence = input.afterSequence;

  const send = (
    shell: OrchestrationV2ThreadShell,
    sequence: number,
    now: number,
    out: Array<ActiveShellDelta>,
  ) => {
    shells.set(shell.id, shell);
    latest.set(shell.id, shell);
    heldThreads.add(shell.id);
    synced.add(shell.id);
    sentAt.set(shell.id, now);
    out.push({ kind: "thread.updated", sequence, location: "active", thread: shell });
  };

  const applyEntry = Effect.fnUntraced(function* (
    entry: ShellFeedEntry,
    now: number,
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
      if (projects.delete(entry.projectId) || removeUnheld) {
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
      latest.set(shell.id, shell);
      if (
        entry.changed ||
        !synced.has(shell.id) ||
        now - (sentAt.get(shell.id) ?? 0) >= RESEND_AFTER_MS
      ) {
        send(shell, entry.sequence, now, out);
      }
      return;
    }
    synced.delete(entry.threadId);
    shells.delete(entry.threadId);
    latest.delete(entry.threadId);
    sentAt.delete(entry.threadId);
    if (heldThreads.delete(entry.threadId) || removeUnheld) {
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

  /** A row whose newest shell the client lacks, else any row it holds exactly. */
  const rowToResend = () => {
    for (const [threadId, shell] of latest) {
      if (shells.get(threadId) !== shell) return shell;
    }
    const held = shells.values().next();
    return held.done === true ? undefined : held.value;
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
        if (entry.sequence > input.afterSequence) yield* applyEntry(entry, now, out);
      }
      record(out, now);
      if (
        out.length === 0 &&
        feedHighSequence > lastSentSequence &&
        now - lastSentAt >= RESEND_AFTER_MS
      ) {
        // Every entry up to feedHighSequence is applied or carries no change this client lacks
        // beyond `updatedAt`, so one row can carry that sequence. A stale row's newest shell goes
        // first; the client would drop a second row at the same sequence.
        const shell = rowToResend();
        if (shell !== undefined) {
          send(shell, feedHighSequence, now, out);
          record(out, now);
        }
      }
      return out as ReadonlyArray<ActiveShellDelta>;
    }),
    /** A resume gap's entries, all at or below the live start. */
    applyReplay: Effect.fnUntraced(function* (entries: ReadonlyArray<ShellFeedEntry>) {
      const out: Array<ActiveShellDelta> = [];
      const now = yield* Clock.currentTimeMillis;
      for (const entry of entries) yield* applyEntry(entry, now, out);
      record(out, now);
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
