/**
 * T3-CUSTOM(expbkt3): one sidebar shell feed per server (TEC-1837).
 *
 * Every shell subscriber used to run its own pipeline: subscribe to committed events, read each
 * touched thread's shell, compare, filter and encode. A streaming reply flushes text every 50 ms,
 * so each streaming thread cost about 20 shell reads per second per connected client, nearly all
 * of them discarded as unchanged, and the main thread stalled for seconds. The feed reads each
 * touched thread once per batch, for every subscriber, and skips events that cannot change a
 * shell. Subscribers filter the result for their user in memory (wsV2Visibility.expbkt3.ts).
 */
import type {
  ApplicationStoredEvent,
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import {
  OrchestrationV2ThreadShell as ThreadShellSchema,
  ProjectId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as RcRef from "effect/RcRef";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { owns } from "../wsV2Visibility.expbkt3.ts";
import type { OrchestrationEventStore } from "../persistence/OrchestrationEventStore.ts";
import type { ProjectService } from "../project/ProjectService.ts";
import type { ThreadManagementService } from "./ThreadManagementService.ts";

export class ShellFeedError extends Schema.TaggedError<ShellFeedError>()("ShellFeedError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const shellFeedError = (message: string) => (cause: unknown) =>
  new ShellFeedError({ message, cause });

// ---------------------------------------------------------------------------
// Events and the shell relevance filter
// ---------------------------------------------------------------------------

/** A committed application event without its payload body. */
export type ShellFeedEvent =
  | {
      readonly aggregate: "project";
      readonly sequence: number;
      readonly projectId: ProjectId;
      readonly projectDeleted: boolean;
    }
  | {
      readonly aggregate: "thread";
      readonly sequence: number;
      readonly threadId: ThreadId;
      readonly type: string;
      readonly turnItem?: {
        readonly id: string;
        readonly type: string;
        readonly status: string;
        readonly runId: string | null;
      };
    };

export function toShellFeedEvent(stored: ApplicationStoredEvent): ShellFeedEvent {
  if ("aggregateKind" in stored) {
    return {
      aggregate: "project",
      sequence: stored.sequence,
      projectId: stored.aggregateId,
      projectDeleted: stored.type === "project.deleted",
    };
  }
  const event = stored.event;
  if (event.type === "turn-item.updated") {
    return {
      aggregate: "thread",
      sequence: stored.sequence,
      threadId: event.threadId,
      type: event.type,
      turnItem: {
        id: event.payload.id,
        type: event.payload.type,
        status: event.payload.status,
        runId: event.payload.runId,
      },
    };
  }
  return {
    aggregate: "thread",
    sequence: stored.sequence,
    threadId: event.threadId,
    type: event.type,
  };
}

/**
 * Event types whose projection writes only tables the thread shell never reads:
 * `node.updated` writes `orchestration_v2_projection_nodes` and `provider-turn.updated` writes
 * `orchestration_v2_projection_provider_turns` (ProjectionStore `apply`); the SQL shell
 * (`selectShellThreadRows`, `selectShellPendingTurnItemRows`, provider threads) and the
 * in-memory `threadShellFromProjection` read neither.
 */
const SHELL_INERT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "node.updated",
  "provider-turn.updated",
]);

/**
 * Turn items whose body never reaches a shell. The shell reads turn items only as counts per run
 * (`itemCount`, `visibleItemCount`), stop requests (`run_interrupt_request`), failed `error`
 * items, waiting `secret_request` items, `user_input_request` lifecycle, and pending execution
 * items (command, tool, subagent, file and search work). A text item can change none of those
 * except by being created or by moving to another run or status.
 */
const TEXT_TURN_ITEM_TYPES: ReadonlySet<string> = new Set([
  "assistant_message",
  "reasoning",
  "proposed_plan",
]);

const MAX_TRACKED_TEXT_ITEMS = 10_000;

/**
 * Keeps every event that can change a shell. A text turn item is dropped only when this filter
 * already saw the same item with the same status and run: its text grew and nothing else did.
 * The first sighting is always kept, because an update and a creation look the same.
 */
export function makeShellEventFilter(maxTrackedItems = MAX_TRACKED_TEXT_ITEMS) {
  const seen = new Map<string, string>();
  const relevant = (event: ShellFeedEvent): boolean => {
    if (event.aggregate === "project") return true;
    if (SHELL_INERT_EVENT_TYPES.has(event.type)) return false;
    const item = event.turnItem;
    if (item === undefined || !TEXT_TURN_ITEM_TYPES.has(item.type)) return true;
    const signature = `${item.status}\u0000${item.runId ?? ""}`;
    const previous = seen.get(item.id);
    seen.delete(item.id);
    seen.set(item.id, signature);
    if (seen.size > maxTrackedItems) {
      const oldest = seen.keys().next();
      if (oldest.done !== true) seen.delete(oldest.value);
    }
    return previous !== signature;
  };
  return Object.assign(relevant, { reset: () => seen.clear() });
}

// ---------------------------------------------------------------------------
// Feed state: last shells, thread access and access history
// ---------------------------------------------------------------------------

export interface ThreadAccess {
  readonly projectId: ProjectId;
  readonly ownerUserId: UserId | null;
  readonly memberUserIds: ReadonlyArray<UserId>;
}

export type ShellFeedEntry =
  | {
      readonly kind: "project";
      readonly sequence: number;
      readonly projectId: ProjectId;
      /** `null` when the project was deleted. */
      readonly project: OrchestrationProjectShell | null;
    }
  | {
      readonly kind: "thread";
      readonly sequence: number;
      readonly threadId: ThreadId;
      /** `null` when the thread is deleted or missing. */
      readonly shell: OrchestrationV2ThreadShell | null;
      /** False only when the feed already published an equal shell (ignoring `updatedAt`). */
      readonly changed: boolean;
      /**
       * The active-thread access before this entry: who could have had the thread in an active
       * sidebar. `null` when it was not active; `"unknown"` when the feed cannot tell.
       */
      readonly previousAccess: ThreadAccess | null | "unknown";
    };

export interface ShellFeedBatch {
  /** The highest committed sequence in the batch, filtered events included. */
  readonly highSequence: number;
  readonly entries: ReadonlyArray<ShellFeedEntry>;
}

export interface ShellFeedReads {
  readonly readThreadShells: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>, ShellFeedError>;
  readonly getProject: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ShellFeedError>;
}

const sameThreadShell = Schema.toEquivalence(ThreadShellSchema);

const MAX_CACHED_SHELLS = 5_000;
const MAX_ACCESS_HISTORY_THREADS = 10_000;
const MAX_ACCESS_CHANGES_PER_THREAD = 8;

export function accessOfShell(shell: OrchestrationV2ThreadShell): ThreadAccess {
  return {
    projectId: shell.projectId,
    ownerUserId: shell.ownerUserId ?? null,
    memberUserIds: shell.memberUserIds ?? [],
  };
}

function sameAccess(left: ThreadAccess | null, right: ThreadAccess | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.projectId === right.projectId &&
    left.ownerUserId === right.ownerUserId &&
    left.memberUserIds.length === right.memberUserIds.length &&
    left.memberUserIds.every((member) => right.memberUserIds.includes(member))
  );
}

/** Insert or refresh a key at the newest end of an insertion-ordered map, then trim the oldest. */
function setNewest<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  max: number,
  onEvict?: (value: V) => void,
) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.entries().next();
    if (oldest.done === true) break;
    map.delete(oldest.value[0]);
    onEvict?.(oldest.value[1]);
  }
}

/**
 * The feed's pure state. One instance per server; `process` turns a batch of committed events
 * into one batched shell read and the entries every subscriber filters.
 */
export function makeShellFeedCore(input: {
  readonly reads: ShellFeedReads;
  /** Active threads and their access when the feed started. */
  readonly access: Iterable<readonly [ThreadId, ThreadAccess]>;
  /** The feed knows every access change after this sequence. */
  readonly coveredFromSequence: number;
}) {
  const filter = makeShellEventFilter();
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const access = new Map<ThreadId, ThreadAccess>();
  const threadsByProject = new Map<ProjectId, Set<ThreadId>>();
  const history = new Map<
    ThreadId,
    Array<{ readonly sequence: number; readonly previous: ThreadAccess | null }>
  >();
  let historyKnownFrom = input.coveredFromSequence;

  const setAccess = (threadId: ThreadId, next: ThreadAccess | null) => {
    const previous = access.get(threadId);
    if (previous !== undefined) threadsByProject.get(previous.projectId)?.delete(threadId);
    if (next === null) {
      access.delete(threadId);
      return;
    }
    access.set(threadId, next);
    const members = threadsByProject.get(next.projectId) ?? new Set<ThreadId>();
    members.add(threadId);
    threadsByProject.set(next.projectId, members);
  };
  for (const [threadId, threadAccess] of input.access) setAccess(threadId, threadAccess);

  const forget = (changes: ReadonlyArray<{ readonly sequence: number }>) => {
    for (const change of changes) historyKnownFrom = Math.max(historyKnownFrom, change.sequence);
  };
  const remember = (threadId: ThreadId, sequence: number, previous: ThreadAccess | null) => {
    const changes = [...(history.get(threadId) ?? []), { sequence, previous }];
    if (changes.length > MAX_ACCESS_CHANGES_PER_THREAD) forget(changes.splice(0, 1));
    setNewest(history, threadId, changes, MAX_ACCESS_HISTORY_THREADS, forget);
  };

  const recordThread = (
    threadId: ThreadId,
    sequence: number,
    shell: OrchestrationV2ThreadShell | null,
  ): ShellFeedEntry => {
    const previousShell = shells.get(threadId);
    const changed =
      shell === null ||
      previousShell === undefined ||
      !sameThreadShell({ ...shell, updatedAt: previousShell.updatedAt }, previousShell);
    if (shell === null) shells.delete(threadId);
    else setNewest(shells, threadId, shell, MAX_CACHED_SHELLS);
    const previousAccess = access.get(threadId) ?? null;
    const nextAccess = shell !== null && shell.archivedAt === null ? accessOfShell(shell) : null;
    if (!sameAccess(previousAccess, nextAccess)) remember(threadId, sequence, previousAccess);
    setAccess(threadId, nextAccess);
    return { kind: "thread", sequence, threadId, shell, changed, previousAccess };
  };

  const process = Effect.fnUntraced(function* (events: Iterable<ShellFeedEvent>) {
    let highSequence = 0;
    const threads = new Map<ThreadId, number>();
    const projects = new Map<ProjectId, { readonly sequence: number; readonly deleted: boolean }>();
    for (const event of events) {
      highSequence = Math.max(highSequence, event.sequence);
      if (!filter(event)) continue;
      if (event.aggregate === "project") {
        const existing = projects.get(event.projectId);
        if (existing === undefined || existing.sequence < event.sequence) {
          projects.set(event.projectId, {
            sequence: event.sequence,
            deleted: event.projectDeleted,
          });
        }
      } else {
        threads.set(event.threadId, Math.max(threads.get(event.threadId) ?? 0, event.sequence));
      }
    }
    const projectEntries = [...projects];
    const [read, projectShells] = yield* Effect.all([
      threads.size === 0
        ? Effect.succeed(new Map<ThreadId, OrchestrationV2ThreadShell>())
        : input.reads.readThreadShells([...threads.keys()]),
      Effect.forEach(
        projectEntries,
        ([projectId, { deleted }]) =>
          deleted
            ? Effect.succeed(null)
            : input.reads.getProject(projectId).pipe(Effect.map(Option.getOrNull)),
        { concurrency: 8 },
      ),
    ]).pipe(
      // The filter already marked this batch's text items as seen; forget them so the retry
      // of this batch keeps them again.
      Effect.tapError(() => Effect.sync(filter.reset)),
    );
    const entries: Array<ShellFeedEntry> = projectEntries.map(
      ([projectId, { sequence }], index) => ({
        kind: "project" as const,
        sequence,
        projectId,
        project: projectShells[index] ?? null,
      }),
    );
    for (const [threadId, sequence] of threads) {
      entries.push(recordThread(threadId, sequence, read.get(threadId) ?? null));
    }
    entries.sort((left, right) => left.sequence - right.sequence);
    return { highSequence, entries } satisfies ShellFeedBatch;
  });

  return {
    process,
    /** Project access through threads, as `canAccessProject` grants it, without a shell scan. */
    projectHasVisibleThread: (projectId: ProjectId, actor: UserId): boolean => {
      for (const threadId of threadsByProject.get(projectId) ?? []) {
        const threadAccess = access.get(threadId);
        if (threadAccess !== undefined && owns(threadAccess, actor)) return true;
      }
      return false;
    },
    /** The active-thread access a thread had at `afterSequence`, for a resume replay. */
    accessAt: (threadId: ThreadId, afterSequence: number): ThreadAccess | null | "unknown" => {
      if (afterSequence < historyKnownFrom) return "unknown";
      const change = history.get(threadId)?.find((entry) => entry.sequence > afterSequence);
      return change !== undefined ? change.previous : (access.get(threadId) ?? null);
    },
  };
}

// ---------------------------------------------------------------------------
// The shared feed
// ---------------------------------------------------------------------------

export interface ShellFeed {
  /**
   * Subscribe before loading a snapshot: every batch published after this returns reaches the
   * subscription, so a snapshot read afterwards misses nothing.
   */
  readonly subscribe: Effect.Effect<PubSub.Subscription<ShellFeedBatch>, never, Scope.Scope>;
  /** Fails when the feed stops, so every subscriber ends and its client resynchronizes. */
  readonly failed: Effect.Effect<never, ShellFeedError>;
  readonly projectHasVisibleThread: (projectId: ProjectId, actor: UserId) => boolean;
  readonly accessAt: (threadId: ThreadId, afterSequence: number) => ThreadAccess | null | "unknown";
}

export interface ShellFeedSources extends ShellFeedReads {
  readonly latestSequence: Effect.Effect<number, ShellFeedError>;
  /** Committed events after `afterSequence`: a catch-up read, then the live tail. */
  readonly events: (afterSequence: number) => Stream.Stream<ShellFeedEvent, ShellFeedError>;
  /** Every active thread's access, read once when the feed starts. */
  readonly loadAccess: Effect.Effect<
    ReadonlyArray<readonly [ThreadId, ThreadAccess]>,
    ShellFeedError
  >;
}

const FEED_BATCH_SIZE = 512;
const FEED_BATCH_WINDOW = Duration.millis(50);
// A failed read or an overflowed event buffer resumes from the last published batch.
const FEED_RETRY = Schedule.spaced("250 millis").pipe(Schedule.upTo({ times: 5 }));

export const makeShellFeed = Effect.fn("ShellFeed.make")(function* (
  sources: ShellFeedSources,
  onFailure: Effect.Effect<void> = Effect.void,
) {
  const hub = yield* PubSub.unbounded<ShellFeedBatch>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(hub));
  const failed = yield* Deferred.make<never, ShellFeedError>();
  const startSequence = yield* sources.latestSequence;
  const access = yield* sources.loadAccess;
  // Changes between the first read and the access load are replayed but not recorded as history.
  const coveredFromSequence = yield* sources.latestSequence;
  const core = makeShellFeedCore({ reads: sources, access, coveredFromSequence });
  let lastSequence = startSequence;

  yield* Stream.suspend(() => sources.events(lastSequence)).pipe(
    Stream.groupedWithin(FEED_BATCH_SIZE, FEED_BATCH_WINDOW),
    Stream.mapEffect((events) =>
      core.process(events).pipe(
        Effect.tap((batch) =>
          Effect.sync(() => {
            lastSequence = Math.max(lastSequence, batch.highSequence);
          }),
        ),
      ),
    ),
    Stream.retry(FEED_RETRY),
    Stream.runForEach((batch) => PubSub.publish(hub, batch)),
    Effect.exit,
    Effect.flatMap((exit) =>
      Exit.isFailure(exit)
        ? Effect.logWarning("The shell feed stopped; shell subscribers will resynchronize.").pipe(
            Effect.andThen(Deferred.failCause(failed, exit.cause)),
            Effect.andThen(onFailure),
          )
        : Deferred.fail(failed, new ShellFeedError({ message: "The shell feed ended." })).pipe(
            Effect.andThen(onFailure),
          ),
    ),
    Effect.forkScoped,
  );

  return {
    subscribe: PubSub.subscribe(hub),
    failed: Deferred.await(failed),
    projectHasVisibleThread: core.projectHasVisibleThread,
    accessAt: core.accessAt,
  } satisfies ShellFeed;
});

// ---------------------------------------------------------------------------
// One feed per server
// ---------------------------------------------------------------------------

export interface ShellFeedServices {
  readonly sql: SqlClient.SqlClient;
  readonly eventStore: Pick<
    OrchestrationEventStore["Service"],
    "latestApplicationSequence" | "streamProjectedApplicationEvents"
  >;
  readonly readThreadShells: ThreadManagementService["Service"]["getThreadShells"];
  readonly getProject: ProjectService["Service"]["getShell"];
}

const decodeMemberUserIds = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

// A narrow indexed read of every active thread's audience, once per feed start.
const loadActiveThreadAccess = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly thread_id: string;
    readonly project_id: string;
    readonly owner_user_id: string | null;
    readonly member_user_ids: string | null;
  }>`
    SELECT
      thread_id,
      project_id,
      json_extract(payload_json, '$.ownerUserId') AS owner_user_id,
      json_extract(payload_json, '$.memberUserIds') AS member_user_ids
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL
      AND json_extract(payload_json, '$.archivedAt') IS NULL
  `.pipe(
    NodeSqliteClient.readOnly,
    Effect.map((rows) =>
      rows.map(
        (row) =>
          [
            ThreadId.make(row.thread_id),
            {
              projectId: ProjectId.make(row.project_id),
              // Blank ids would throw in `make` and stop the feed for every client.
              ownerUserId:
                row.owner_user_id === null || row.owner_user_id.trim() === ""
                  ? null
                  : UserId.make(row.owner_user_id),
              memberUserIds:
                row.member_user_ids === null
                  ? []
                  : Option.getOrElse(decodeMemberUserIds(row.member_user_ids), () => [])
                      .filter((member) => member.trim() !== "")
                      .map((member) => UserId.make(member)),
            },
          ] as const,
      ),
    ),
    Effect.mapError(shellFeedError("Failed to read thread access for the shell feed")),
  );

export const shellFeedSources = (services: ShellFeedServices): ShellFeedSources => ({
  latestSequence: services.eventStore.latestApplicationSequence.pipe(
    Effect.mapError(shellFeedError("Failed to read the latest application sequence")),
  ),
  events: (afterSequence) =>
    services.eventStore
      .streamProjectedApplicationEvents({ afterSequence, project: toShellFeedEvent })
      .pipe(Stream.mapError(shellFeedError("Failed while streaming application events"))),
  loadAccess: loadActiveThreadAccess(services.sql),
  readThreadShells: (threadIds) =>
    services
      .readThreadShells(threadIds)
      .pipe(Effect.mapError(shellFeedError("Failed to read thread shells"))),
  getProject: (projectId) =>
    services
      .getProject(projectId)
      .pipe(Effect.mapError(shellFeedError("Failed to read a project"))),
});

/**
 * The event store is one object per server, so it keys the server's feed without a new layer in
 * server wiring. The feed starts with its first subscriber and stops with its last.
 */
const feeds = new WeakMap<object, RcRef.RcRef<ShellFeed, ShellFeedError>>();

/** Borrow the server's shell feed for the current scope, starting it when needed. */
export const acquireShellFeed = Effect.fnUntraced(function* (services: ShellFeedServices) {
  let ref = feeds.get(services.eventStore);
  if (ref === undefined) {
    const scope = yield* Scope.make();
    const created: RcRef.RcRef<ShellFeed, ShellFeedError> = yield* RcRef.make({
      acquire: Effect.suspend(() =>
        makeShellFeed(shellFeedSources(services), RcRef.invalidate(created)),
      ),
    }).pipe(Scope.provide(scope));
    const raced = feeds.get(services.eventStore);
    if (raced === undefined) {
      feeds.set(services.eventStore, created);
      ref = created;
    } else {
      yield* Scope.close(scope, Exit.void);
      ref = raced;
    }
  }
  return yield* RcRef.get(ref);
});

/**
 * Distinct threads and projects a resume gap touched, read once each. Entries carry the access
 * the thread had at `afterSequence`, so a replay can remove a thread the client may hold.
 */
export const readShellReplay = Effect.fnUntraced(function* <E>(input: {
  readonly events: Stream.Stream<ApplicationStoredEvent, E>;
  readonly reads: ShellFeedReads;
  readonly accessAt: ShellFeed["accessAt"];
  readonly afterSequence: number;
}) {
  const threads = new Map<ThreadId, number>();
  const projects = new Map<ProjectId, { readonly sequence: number; readonly deleted: boolean }>();
  yield* Stream.runForEach(input.events, (stored) =>
    Effect.sync(() => {
      const event = toShellFeedEvent(stored);
      if (event.aggregate === "project") {
        const existing = projects.get(event.projectId);
        if (existing === undefined || existing.sequence < event.sequence) {
          projects.set(event.projectId, {
            sequence: event.sequence,
            deleted: event.projectDeleted,
          });
        }
      } else if (!SHELL_INERT_EVENT_TYPES.has(event.type)) {
        threads.set(event.threadId, Math.max(threads.get(event.threadId) ?? 0, event.sequence));
      }
    }),
  );
  const projectEntries = [...projects];
  const [shells, projectShells] = yield* Effect.all([
    threads.size === 0
      ? Effect.succeed(new Map<ThreadId, OrchestrationV2ThreadShell>())
      : input.reads.readThreadShells([...threads.keys()]),
    Effect.forEach(
      projectEntries,
      ([projectId, { deleted }]) =>
        deleted
          ? Effect.succeed(null)
          : input.reads.getProject(projectId).pipe(Effect.map(Option.getOrNull)),
      { concurrency: 8 },
    ),
  ]);
  const entries: Array<ShellFeedEntry> = projectEntries.map(([projectId, { sequence }], index) => ({
    kind: "project" as const,
    sequence,
    projectId,
    project: projectShells[index] ?? null,
  }));
  for (const [threadId, sequence] of threads) {
    entries.push({
      kind: "thread",
      sequence,
      threadId,
      shell: shells.get(threadId) ?? null,
      changed: true,
      previousAccess: input.accessAt(threadId, input.afterSequence),
    });
  }
  return entries.sort((left, right) => left.sequence - right.sequence);
});
