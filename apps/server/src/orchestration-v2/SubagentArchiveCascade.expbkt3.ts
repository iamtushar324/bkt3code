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
 * - Once per start, after activation, every provider-native subagent whose
 *   parent is archived, deleted or gone is archived. That pass is the cleanup of
 *   the orphans that predate this rule, and heals a cascade a restart cut short.
 *
 * delegate_task children (`creationSource: "mcp"`) and forks keep their own
 * lifecycle, and a child with an unfinished run is left alone. Both directions
 * read where the parent is now, so a later event that reverses an earlier one
 * wins.
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { forkParked, ServerActivation } from "../serverActivation.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { randomUuidV4 } from "./RandomUuid.ts";

/** Commands in flight at once, so a startup pass of hundreds does not crowd out live work. */
const DISPATCH_CONCURRENCY = 4;

type CascadeDirection = "archive" | "unarchive";

type CascadeRequest =
  | { readonly type: "startup" }
  | {
      readonly type: "follow";
      readonly direction: CascadeDirection;
      readonly parentThreadId: ThreadId;
      readonly projectId: ProjectId;
    };

interface ChildRow {
  readonly thread_id: string;
}

/** The cascade a domain event starts, or null when its children have nothing to follow. */
function cascadeRequestFor(event: OrchestrationV2DomainEvent): CascadeRequest | null {
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

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSinkV2;
  const sql = yield* SqlClient.SqlClient;
  const activation = (yield* ServerActivation) ?? Effect.void;

  /**
   * A parent's provider-native subagents that are not yet where the parent is.
   * A child shares its parent's project, so the project index bounds the scan.
   */
  const selectChildren = (request: Extract<CascadeRequest, { readonly type: "follow" }>) =>
    sql<ChildRow>`
      SELECT child.thread_id AS thread_id
      FROM orchestration_v2_projection_threads AS child
      WHERE child.project_id = ${request.projectId}
        AND child.deleted_at IS NULL
        AND ${request.direction === "archive" ? sql`child.archived_at IS NULL` : sql`child.archived_at IS NOT NULL`}
        AND CASE WHEN json_valid(child.payload_json) THEN
          json_extract(child.payload_json, '$.lineage.parentThreadId') = ${request.parentThreadId}
          AND json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
          AND json_extract(child.payload_json, '$.creationSource') = 'provider'
        ELSE 0 END
        AND ${request.direction === "archive" ? sql`NOT EXISTS` : sql`EXISTS`} (
          SELECT 1
          FROM orchestration_v2_projection_threads AS parent
          WHERE parent.thread_id = ${request.parentThreadId}
            AND parent.archived_at IS NULL
            AND parent.deleted_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM orchestration_v2_projection_runs AS run
          WHERE run.thread_id = child.thread_id
            AND run.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
        )
      ORDER BY child.created_at ASC, child.thread_id ASC
    `;

  /** Unarchived provider-native subagents whose parent is archived, deleted or gone. */
  const selectOrphans = () =>
    sql<ChildRow>`
      SELECT child.thread_id AS thread_id
      FROM orchestration_v2_projection_threads AS child
      LEFT JOIN orchestration_v2_projection_threads AS parent
        ON parent.thread_id = CASE WHEN json_valid(child.payload_json)
          THEN json_extract(child.payload_json, '$.lineage.parentThreadId') END
      WHERE child.deleted_at IS NULL
        AND child.archived_at IS NULL
        AND CASE WHEN json_valid(child.payload_json) THEN
          json_extract(child.payload_json, '$.lineage.parentThreadId') IS NOT NULL
          AND json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
          AND json_extract(child.payload_json, '$.creationSource') = 'provider'
        ELSE 0 END
        AND (
          parent.thread_id IS NULL
          OR parent.archived_at IS NOT NULL
          OR parent.deleted_at IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM orchestration_v2_projection_runs AS run
          WHERE run.thread_id = child.thread_id
            AND run.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
        )
      ORDER BY child.created_at ASC, child.thread_id ASC
    `;

  /** Dispatches one archive or unarchive per child; returns how many were accepted. */
  const moveChildren = (
    direction: CascadeDirection,
    rows: ReadonlyArray<ChildRow>,
    source: "cascade" | "startup",
  ) =>
    Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(row.thread_id);
          const uuid = yield* randomUuidV4;
          const commandId = CommandId.make(
            `server:subagent-${direction}-${source}:${threadId}:${uuid}`,
          );
          const command: OrchestrationV2ServerCommand =
            direction === "archive"
              ? { type: "thread.archive", commandId, threadId }
              : { type: "thread.unarchive", commandId, threadId };
          yield* orchestrator.dispatch(command);
          return true;
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("subagent archive cascade: a child did not follow its parent", {
                  threadId: row.thread_id,
                  direction,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(false)),
          ),
        ),
      { concurrency: DISPATCH_CONCURRENCY },
    ).pipe(Effect.map((accepted) => accepted.filter(Boolean).length));

  const processRequest = Effect.fn("SubagentArchiveCascade.process")(function* (
    request: CascadeRequest,
  ) {
    if (request.type === "startup") {
      const orphans = yield* selectOrphans();
      const archived = yield* moveChildren("archive", orphans, "startup");
      yield* Effect.logInfo(
        "subagent archive cascade: archived the subagents of archived or deleted parents",
        { candidates: orphans.length, archived },
      );
      return;
    }
    const children = yield* selectChildren(request);
    if (children.length === 0) return;
    const moved = yield* moveChildren(request.direction, children, "cascade");
    yield* Effect.logInfo("subagent archive cascade: subagents followed their parent", {
      parentThreadId: request.parentThreadId,
      direction: request.direction,
      candidates: children.length,
      moved,
    });
  });

  // Items wait for activation, so the startup pass queued in `start` runs
  // after the server is up and `drain` still covers it.
  const worker = yield* makeDrainableWorker((request: CascadeRequest) =>
    activation.pipe(
      Effect.andThen(processRequest(request)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("subagent archive cascade: request failed", {
              request: request.type === "startup" ? "startup" : request.parentThreadId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const start = Effect.fn("SubagentArchiveCascade.start")(function* () {
    // Read from the current head: an event that lands before the parked
    // stream subscribes is replayed rather than lost.
    const afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
    yield* worker.enqueue({ type: "startup" });
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
  });

  return { start, drain: worker.drain };
});

/** Starts the cascade with the server; one marked line in `server.ts` provides it. */
export const layer = Layer.effectDiscard(Effect.flatMap(make, (cascade) => cascade.start()));
