/** T3-CUSTOM(expbkt3): narrow user-owned bridge operations over the native durable runtime. */
import {
  CommandId,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type UserId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { isOwnerOrMember } from "./accessRules.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { legacyActivities, legacyThreadShell } from "./legacyProjection.expbkt3.ts";
import {
  ManagerDispatchError,
  managerThreadIsIdle,
  managerThreadRestartCancelled,
} from "./managerGuard.expbkt3.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProjectStoreV2 } from "./ProjectStore.ts";
import type { EventFeedQuery } from "./eventFeedHttp.expbkt3.ts";

export const ManagerPrompt = Schema.Struct({
  sessionId: ThreadId,
  commandId: CommandId,
  messageId: MessageId,
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  prompt: Schema.String,
  createdAt: Schema.optional(Schema.String),
});
export const ManagerBootstrap = Schema.Struct({
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export class ManagerError extends Schema.TaggedError<ManagerError>()("ManagerError", {
  status: Schema.Number,
  detail: Schema.String,
}) {}
export interface ManagerActor {
  readonly userId: UserId;
  readonly grantHash: string;
}
const fail = (status: number, detail: string) => new ManagerError({ status, detail });
const iso = (date: DateTime.Utc | null | undefined) =>
  date == null ? null : DateTime.formatIso(date);
const executionState = (status: string | undefined) =>
  status === "preparing" || status === "queued" || status === "starting"
    ? "queued"
    : status === "running" || status === "waiting"
      ? "running"
      : status === "completed"
        ? "completed"
        : status === "interrupted" ||
            status === "failed" ||
            status === "cancelled" ||
            status === "rolled_back"
          ? "error"
          : "unknown";

interface ManagerFeedEvent {
  readonly sequence: number;
  readonly type: string;
  readonly aggregateKind: "thread";
  readonly aggregateId: ThreadId;
  readonly occurredAt: string;
  readonly payload: unknown;
}
function feedEvent(
  stored: OrchestrationV2StoredEvent,
  shell: OrchestrationV2ThreadShell,
): ManagerFeedEvent | undefined {
  const event = stored.event;
  const base = {
    sequence: stored.sequence,
    aggregateKind: "thread" as const,
    aggregateId: event.threadId,
    occurredAt: DateTime.formatIso(event.occurredAt),
  };
  switch (event.type) {
    case "message.updated":
      return {
        ...base,
        type: "thread.message-sent",
        payload: {
          threadId: event.threadId,
          messageId: event.payload.id,
          turnId: event.payload.runId,
          role: event.payload.role,
          text: event.payload.text,
          streaming: event.payload.streaming,
          createdAt: iso(event.payload.createdAt),
          updatedAt: iso(event.payload.updatedAt),
        },
      };
    case "turn-item.updated": {
      const activity = legacyActivities({ turnItems: [event.payload] })[0];
      return activity === undefined
        ? undefined
        : {
            ...base,
            type: "thread.activity-appended",
            payload: { threadId: event.threadId, activity },
          };
    }
    case "plan.updated":
      return event.payload.kind !== "proposed_plan"
        ? undefined
        : {
            ...base,
            type: "thread.proposed-plan-upserted",
            payload: { threadId: event.threadId, proposedPlan: { id: event.payload.id } },
          };
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
      return { ...base, type: event.type, payload: { threadId: event.threadId } };
    case "run.created":
    case "run.updated":
    case "thread.created":
    case "thread.metadata-updated":
    case "provider-session.updated":
    case "provider-session.detached":
      return {
        ...base,
        type: "thread.session-set",
        payload: { threadId: event.threadId, session: legacyThreadShell(shell).session },
      };
    default:
      return undefined;
  }
}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const projects = yield* ProjectStoreV2;
  const events = yield* EventSinkV2;
  const applicationEvents = yield* OrchestrationEventStore;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const orchestrator = yield* OrchestratorV2;
  const requireThread = Effect.fn("manager.requireThread")(function* (
    actor: ManagerActor,
    threadId: ThreadId,
  ) {
    const thread = yield* projections.getThreadShell(threadId);
    if (thread === null || !isOwnerOrMember(thread, actor.userId))
      return yield* fail(403, "control-denied");
    return thread;
  });
  const sessions = Effect.fn("manager.sessions")(function* (actor: ManagerActor) {
    // Capture the earlier watermark: any concurrent change is replayed after this inventory.
    const snapshotSequence = yield* applicationEvents.latestApplicationSequence;
    const active = yield* projections.getShellSnapshot();
    const archived = yield* projections.getShellSnapshot({ location: "archive" });
    const threads = [...active.threads, ...archived.archivedThreads].filter((thread) =>
      isOwnerOrMember(thread, actor.userId),
    );
    const projectIds = new Set(threads.map((thread) => thread.projectId));
    const visibleProjects = (yield* projects.listShells()).filter(
      (project) => isOwnerOrMember(project, actor.userId) || projectIds.has(project.id),
    );
    return {
      userId: actor.userId,
      snapshotSequence,
      projects: visibleProjects,
      threads: yield* Effect.forEach(
        threads,
        (thread) =>
          Effect.gen(function* () {
            const restartCancelled = yield* managerThreadRestartCancelled(thread, events);
            // Only potentially idle threads need history: a held queue can
            // coexist with a completed shell. Archived histories stay unread.
            const idle =
              managerThreadIsIdle(thread, restartCancelled) &&
              !(yield* projections.getThreadRecords(thread.id, ["runs"])).runs.some((run) =>
                ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
              );
            const legacy = legacyThreadShell(thread);
            return {
              ...legacy,
              deletedAt: iso(thread.deletedAt),
              revision: snapshotSequence,
              canControl: true,
              idle,
              session: {
                ...legacy.session,
                status:
                  (thread.status === "cancelled" && !restartCancelled) ||
                  thread.status === "interrupted"
                    ? "interrupted"
                    : legacy.session?.status,
              },
            };
          }),
        { concurrency: 2 },
      ),
    };
  });
  const feed = Effect.fn("manager.events")(function* (actor: ManagerActor, query: EventFeedQuery) {
    const headBefore = yield* applicationEvents.latestApplicationSequence;
    if (query.after > headBefore) return yield* fail(410, "cursor-invalid");
    const read = Effect.gen(function* () {
      const head = yield* applicationEvents.latestApplicationSequence;
      const rows = yield* applicationEvents
        .readApplicationEvents({ afterSequence: query.after, throughSequence: head })
        .pipe(Stream.take(query.limit), Stream.runCollect);
      return Array.from(rows);
    });
    let raw = yield* read;
    if (raw.length === 0 && query.waitSeconds > 0) {
      // The application stream replays from the captured cursor before it tails.
      yield* applicationEvents
        .streamApplicationEvents({ afterSequence: query.after })
        .pipe(Stream.runHead, Effect.timeoutOption(Duration.seconds(query.waitSeconds)));
      raw = yield* read;
    }
    const visible: ManagerFeedEvent[] = [];
    const shells = new Map<ThreadId, OrchestrationV2ThreadShell | null>();
    for (const stored of raw) {
      if (!("event" in stored)) continue;
      const threadId = stored.event.threadId;
      if (!shells.has(threadId)) shells.set(threadId, yield* projections.getThreadShell(threadId));
      const shell = shells.get(threadId);
      if (shell == null || !isOwnerOrMember(shell, actor.userId)) continue;
      const event = feedEvent(stored, shell);
      if (event !== undefined) visible.push(event);
    }
    return {
      events: visible,
      nextAfter: raw.at(-1)?.sequence ?? query.after,
      headSequence: yield* applicationEvents.latestApplicationSequence,
    };
  });
  const receipt = Effect.fn("manager.receipt")(function* (
    actor: ManagerActor,
    sessionId: ThreadId,
    commandId: CommandId,
  ) {
    yield* requireThread(actor, sessionId);
    const receipt = yield* receipts.getByCommandId(commandId);
    if (Option.isNone(receipt) || receipt.value.threadId !== sessionId)
      return { status: "unknown" as const };
    if (receipt.value.status !== "accepted")
      return {
        status: "rejected" as const,
        sequence: receipt.value.resultSequence,
        error: receipt.value.error,
      };
    const committed = yield* events.readByCommandId({ commandId }).pipe(Stream.runCollect);
    const created = Array.from(committed).find((entry) => entry.event.type === "run.created");
    const runId = created?.event.type === "run.created" ? created.event.payload.id : undefined;
    const messageId =
      created?.event.type === "run.created" ? created.event.payload.userMessageId : undefined;
    const runs =
      runId === undefined
        ? []
        : (yield* projections.getThreadRecords(sessionId, ["runs"], { runIds: [runId] })).runs;
    const run = runs[0];
    return {
      status: "accepted" as const,
      sequence: receipt.value.resultSequence,
      messageId,
      execution: {
        state: executionState(run?.status),
        ...(run?.startedAt == null ? {} : { turnId: run.id }),
      },
    };
  });
  const prompt = Effect.fn("manager.prompt")(function* (
    actor: ManagerActor,
    input: typeof ManagerPrompt.Type,
  ) {
    if (
      input.prompt.trim().length === 0 ||
      input.prompt.length > 65_536 ||
      (input.createdAt !== undefined && !Number.isFinite(Date.parse(input.createdAt)))
    )
      return yield* fail(400, "invalid-request");
    yield* requireThread(actor, input.sessionId);
    const result = yield* orchestrator
      .dispatch(
        {
          type: "message.dispatch",
          threadId: input.sessionId,
          commandId: input.commandId,
          createdBy: "agent",
          creationSource: "mcp",
          messageId: input.messageId,
          text: input.prompt,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        },
        {
          actorUserId: actor.userId,
          backgroundGrantHash: actor.grantHash,
          expectedRevision: input.expectedRevision,
        },
      )
      .pipe(Effect.mapError(() => fail(409, "stale-or-busy")));
    const messageEvent = result.storedEvents.find(
      (entry) => entry.event.type === "message.updated" && entry.event.payload.role === "user",
    );
    if (
      messageEvent?.event.type !== "message.updated" ||
      messageEvent.event.payload.id !== input.messageId ||
      messageEvent.event.payload.text !== input.prompt ||
      messageEvent.event.payload.sentByUserId !== actor.userId
    )
      return yield* fail(409, "command-conflict");
    return {
      accepted: true as const,
      sequence: result.sequence,
      sessionId: input.sessionId,
      messageId: input.messageId,
    };
  });
  const bootstrap = Effect.fn("manager.bootstrap")(function* (
    actor: ManagerActor,
    input: typeof ManagerBootstrap.Type,
  ) {
    const dispatch = (command: Parameters<typeof orchestrator.dispatch>[0]) =>
      orchestrator
        .dispatch(command, {
          actorUserId: actor.userId,
          managerBootstrapGrant: { hash: actor.grantHash, projectId: input.projectId },
        })
        .pipe(
          Effect.mapError((error) => {
            const cause = "cause" in error ? error.cause : undefined;
            const detail = cause instanceof ManagerDispatchError ? cause.detail : "manager-paused";
            return fail(
              detail === "manager-grant-revoked"
                ? 401
                : detail === "manager-control-denied"
                  ? 403
                  : 409,
              detail.replace("manager-", ""),
            );
          }),
        );
    const project = yield* projects.get(input.projectId);
    if (Option.isNone(project) || !isOwnerOrMember(project.value, actor.userId))
      return yield* fail(403, "control-denied");
    const sessionId = ThreadId.make(`manager:${actor.userId}`);
    const createId = CommandId.make(`${sessionId}:create:v1`);
    const existing = yield* projections.getThreadShell(sessionId);
    if (existing !== null) {
      if (existing.ownerUserId !== actor.userId || existing.projectId !== input.projectId)
        return yield* fail(403, "control-denied");
      if (
        existing.archivedAt !== null ||
        existing.deletedAt !== null ||
        existing.snoozedUntil != null ||
        existing.status === "interrupted" ||
        (existing.status === "cancelled" &&
          !(yield* managerThreadRestartCancelled(existing, events)))
      )
        return yield* fail(409, "paused");
    } else if (Option.isSome(yield* receipts.getByCommandId(createId)))
      return yield* fail(409, "paused");
    if (existing === null)
      yield* dispatch({
        type: "thread.create",
        commandId: createId,
        threadId: sessionId,
        projectId: input.projectId,
        createdBy: "agent",
        creationSource: "mcp",
        title: "Manager",
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode ?? "approval-required",
        interactionMode: input.interactionMode ?? "default",
        branch: null,
        worktreePath: null,
      });
    yield* dispatch({
      type: "thread.pin",
      commandId: CommandId.make(`${sessionId}:pin:v1`),
      threadId: sessionId,
    });
    const result = yield* dispatch({
      type: "thread.auto-settle.set",
      commandId: CommandId.make(`${sessionId}:auto-settle:v1`),
      threadId: sessionId,
      enabled: false,
    });
    return { sessionId, sequence: result.sequence };
  });
  return { sessions, feed, receipt, prompt, bootstrap };
});
export class ManagerService extends Context.Service<ManagerService, Effect.Success<typeof make>>()(
  "t3/orchestration-v2/ManagerService",
) {}
// The production runtime exposes the shared application receipt repository, not
// its V2 adapter. Reuse that repository instead of creating another persistence layer.
export const layer = Layer.effect(ManagerService, make).pipe(
  Layer.provide(CommandReceiptStore.layerFromApplicationReceipts),
);
