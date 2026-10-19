/**
 * T3-CUSTOM(expbkt3): a provider-native subagent thread follows its parent into
 * and out of the archive.
 *
 * Claude's Task/Agent tool children, and other providers' native subagents, are
 * mirrored as threads (`isProviderNativeSubagentThread`) that every client
 * hides. Archiving or deleting the parent never touched them, so a finished
 * subagent stayed in every active shell read for good: on bkt3 on 2026-10-19,
 * 318 of the 1,144 active threads were subagents of an archived parent.
 *
 * - `thread.archived` or `thread.deleted` of a parent archives its
 *   provider-native subagent children, and `thread.unarchived` unarchives them.
 * - A child whose subagent record is still pending, running or waiting is not
 *   archived. It follows its parent when that record stops being live.
 * - Once per start, after activation, every provider-native subagent whose
 *   parent is archived, deleted or gone is archived. That pass is the cleanup of
 *   the orphans that predate this rule, and heals a cascade a restart cut short.
 *
 * Every archive also starts a history export (`ArchiveExportReactor`) that runs
 * git in the worktree, so nothing here moves children in a burst: live moves are
 * at least `cascadePause` apart, and the startup pass queues one orphan per
 * `startupPause` between them. delegate_task children (`creationSource: "mcp"`)
 * and forks keep their own lifecycle. Each child is re-read just before it
 * moves, so a later event that reverses an earlier one wins.
 */
import {
  CommandId,
  isProviderNativeSubagentThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { forkParked, ServerActivation } from "../serverActivation.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { randomUuidV4 } from "./RandomUuid.ts";

/** ~318 startup archives on bkt3 spread over ~11 minutes, with their history exports. */
const DEFAULT_STARTUP_PAUSE = Duration.seconds(2);

/** A parent with 63 subagents (bkt3's largest) archives them over ~30 seconds. */
const DEFAULT_CASCADE_PAUSE = Duration.millis(500);

/** The startup pass logs its progress once per this many orphans. */
const STARTUP_PROGRESS_EVERY = 50;

type CascadeDirection = "archive" | "unarchive";

type CascadeRequest =
  /** A parent moved: its children follow. */
  | {
      readonly type: "follow";
      readonly direction: CascadeDirection;
      readonly parentThreadId: ThreadId;
      readonly projectId: ProjectId;
    }
  /** A subagent record stopped being live: its thread follows an archived parent. */
  | { readonly type: "finished"; readonly threadId: ThreadId }
  | { readonly type: "startup-orphan"; readonly threadId: ThreadId }
  | { readonly type: "startup-summary" };

/** Which children a read covers: every one, one parent's, or a single child. */
type ChildScope =
  | { readonly kind: "all" }
  | { readonly kind: "parent"; readonly parentThreadId: ThreadId; readonly projectId: ProjectId }
  | { readonly kind: "child"; readonly threadId: ThreadId };

interface ChildRow {
  readonly thread_id: string;
}

/** The work a domain event starts, or null when no child has anything to follow. */
function cascadeRequestFor(event: OrchestrationV2DomainEvent): CascadeRequest | null {
  if (event.type === "subagent.updated") {
    const subagent = event.payload;
    const live =
      subagent.status === "pending" ||
      subagent.status === "running" ||
      subagent.status === "waiting";
    return subagent.origin === "provider_native" && subagent.childThreadId !== null && !live
      ? { type: "finished", threadId: subagent.childThreadId }
      : null;
  }
  if (
    event.type !== "thread.archived" &&
    event.type !== "thread.unarchived" &&
    event.type !== "thread.deleted"
  ) {
    return null;
  }
  // A provider-native subagent has no provider-native children, so its own
  // archive (most are sent from here) needs no lookup.
  if (isProviderNativeSubagentThread(event.payload)) return null;
  return {
    type: "follow",
    direction: event.type === "thread.unarchived" ? "unarchive" : "archive",
    parentThreadId: event.threadId,
    projectId: event.payload.projectId,
  };
}

export const make = (
  options: {
    readonly startupPause?: Duration.Input;
    readonly cascadePause?: Duration.Input;
  } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const activation = (yield* ServerActivation) ?? Effect.void;
    const startupPause = Duration.fromInputUnsafe(options.startupPause ?? DEFAULT_STARTUP_PAUSE);
    const cascadePauseMillis = Duration.toMillis(options.cascadePause ?? DEFAULT_CASCADE_PAUSE);
    // Completed once the startup pass has queued its last orphan.
    const startupQueued = yield* Deferred.make<void>();
    const startupPass = { candidates: 0, processed: 0, archived: 0 };
    let lastLiveMoveAt: number | null = null;

    /**
     * Provider-native subagents in `scope` that are not where their parent is.
     * To archive: the child is unarchived, its parent is archived, deleted or
     * gone, and its subagent record is not live. To unarchive: the child is
     * archived and its parent is active. A child shares its parent's project, so
     * a parent's read stays on the project index; a child's is a key lookup.
     */
    const selectChildren = (direction: CascadeDirection, scope: ChildScope) =>
      sql<ChildRow>`
        SELECT child.thread_id AS thread_id
        FROM orchestration_v2_projection_threads AS child
        LEFT JOIN orchestration_v2_projection_threads AS parent
          ON parent.thread_id = CASE WHEN json_valid(child.payload_json)
            THEN json_extract(child.payload_json, '$.lineage.parentThreadId') END
        WHERE child.deleted_at IS NULL${
          scope.kind === "parent"
            ? sql` AND child.project_id = ${scope.projectId}`
            : scope.kind === "child"
              ? sql` AND child.thread_id = ${scope.threadId}`
              : sql``
        }
          AND ${direction === "archive" ? sql`child.archived_at IS NULL` : sql`child.archived_at IS NOT NULL`}
          AND CASE WHEN json_valid(child.payload_json) THEN
            json_extract(child.payload_json, '$.lineage.parentThreadId') ${
              scope.kind === "parent" ? sql`= ${scope.parentThreadId}` : sql`IS NOT NULL`
            }
            AND json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
            AND json_extract(child.payload_json, '$.creationSource') = 'provider'
          ELSE 0 END
          AND ${
            direction === "archive"
              ? sql`(
                parent.thread_id IS NULL
                OR parent.archived_at IS NOT NULL
                OR parent.deleted_at IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_subagents AS subagent
                WHERE subagent.child_thread_id = child.thread_id
                  AND subagent.status IN ('pending', 'running', 'waiting')
              )`
              : sql`(
                parent.thread_id IS NOT NULL
                AND parent.archived_at IS NULL
                AND parent.deleted_at IS NULL
              )`
          }
        ORDER BY child.created_at ASC, child.thread_id ASC
      `;

    /** Waits until the last live move is `cascadePause` old. */
    const paceLiveMove = Effect.gen(function* () {
      if (lastLiveMoveAt === null) return;
      const wait = lastLiveMoveAt + cascadePauseMillis - (yield* Clock.currentTimeMillis);
      if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
    });

    const isDue = (direction: CascadeDirection, threadId: ThreadId) =>
      selectChildren(direction, { kind: "child", threadId }).pipe(
        Effect.map((rows) => rows.length > 0),
      );

    /**
     * Re-reads one child and moves it when it still needs to; true when the
     * orchestrator accepted the command. A live move waits for its pace, then
     * reads the child again, so a check with nothing to do never waits.
     */
    const moveChild = (
      direction: CascadeDirection,
      threadId: ThreadId,
      source: "cascade" | "startup",
    ) =>
      Effect.gen(function* () {
        if (!(yield* isDue(direction, threadId))) return false;
        if (source === "cascade" && lastLiveMoveAt !== null && cascadePauseMillis > 0) {
          yield* paceLiveMove;
          if (!(yield* isDue(direction, threadId))) return false;
        }
        const uuid = yield* randomUuidV4;
        const commandId = CommandId.make(
          `server:subagent-${direction}-${source}:${threadId}:${uuid}`,
        );
        const command: OrchestrationV2ServerCommand =
          direction === "archive"
            ? { type: "thread.archive", commandId, threadId }
            : { type: "thread.unarchive", commandId, threadId };
        yield* orchestrator.dispatch(command);
        if (source === "cascade") lastLiveMoveAt = yield* Clock.currentTimeMillis;
        return true;
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("subagent archive cascade: a child did not follow its parent", {
                threadId,
                direction,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
        ),
      );

    const processRequest = Effect.fn("SubagentArchiveCascade.process")(function* (
      request: CascadeRequest,
    ) {
      switch (request.type) {
        case "follow": {
          const children = yield* selectChildren(request.direction, {
            kind: "parent",
            parentThreadId: request.parentThreadId,
            projectId: request.projectId,
          });
          if (children.length === 0) return;
          let moved = 0;
          for (const child of children) {
            if (yield* moveChild(request.direction, ThreadId.make(child.thread_id), "cascade")) {
              moved += 1;
            }
          }
          yield* Effect.logInfo("subagent archive cascade: subagents followed their parent", {
            parentThreadId: request.parentThreadId,
            direction: request.direction,
            candidates: children.length,
            moved,
          });
          return;
        }
        case "finished":
          if (yield* moveChild("archive", request.threadId, "cascade")) {
            yield* Effect.logInfo(
              "subagent archive cascade: a finished subagent followed its archived parent",
              { threadId: request.threadId },
            );
          }
          return;
        case "startup-orphan": {
          if (yield* moveChild("archive", request.threadId, "startup")) {
            startupPass.archived += 1;
          }
          startupPass.processed += 1;
          if (
            startupPass.processed % STARTUP_PROGRESS_EVERY === 0 &&
            startupPass.processed < startupPass.candidates
          ) {
            yield* Effect.logInfo("subagent archive cascade: startup pass progress", {
              ...startupPass,
            });
          }
          return;
        }
        case "startup-summary":
          yield* Effect.logInfo(
            "subagent archive cascade: archived the subagents of archived or deleted parents",
            { ...startupPass },
          );
          return;
      }
    });

    // Items wait for activation. Live work and startup orphans share this one
    // worker, so they never race each other on the same child.
    const worker = yield* makeDrainableWorker((request: CascadeRequest) =>
      activation.pipe(
        Effect.andThen(processRequest(request)),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("subagent archive cascade: request failed", {
                request,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
    );

    /** Queues the orphans one per pause, so live work runs between them. */
    const queueStartupPass = Effect.gen(function* () {
      const orphans = yield* selectChildren("archive", { kind: "all" });
      startupPass.candidates = orphans.length;
      for (const [index, orphan] of orphans.entries()) {
        if (index > 0 && !Duration.isZero(startupPause)) yield* Effect.sleep(startupPause);
        yield* worker.enqueue({
          type: "startup-orphan",
          threadId: ThreadId.make(orphan.thread_id),
        });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("subagent archive cascade: startup pass failed", {
              cause: Cause.pretty(cause),
            }),
      ),
      Effect.andThen(worker.enqueue({ type: "startup-summary" })),
      Effect.ensuring(Deferred.succeed(startupQueued, undefined)),
    );

    const start = Effect.fn("SubagentArchiveCascade.start")(function* () {
      // Read from the current head: an event that lands before the parked
      // stream subscribes is replayed rather than lost.
      const afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
      yield* forkParked(
        eventSink.stream({ afterSequence }).pipe(
          Stream.runForEach((stored) => {
            const request = cascadeRequestFor(stored.event);
            return request === null ? Effect.void : worker.enqueue(request);
          }),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("subagent archive cascade: event stream failed", {
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      );
      yield* forkParked(queueStartupPass);
    });

    return {
      start,
      /** After `start`: waits for the whole startup pass, then for every queued item. */
      drain: Deferred.await(startupQueued).pipe(Effect.andThen(worker.drain)),
    };
  });

/** Starts the cascade with the server; one marked line in `server.ts` provides it. */
export const layer = Layer.effectDiscard(Effect.flatMap(make(), (cascade) => cascade.start()));
