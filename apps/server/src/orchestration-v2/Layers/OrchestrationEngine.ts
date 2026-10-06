/** T3-CUSTOM(expbkt3): retained fork commands dispatch through the one V2 event sink. */
import { OrchestrationCommand, OrchestrationEvent } from "@t3tools/contracts/orchestration";
import {
  OrchestrationV2Command,
  CommandId,
  RunId,
  RuntimeRequestId,
  type ThreadId,
  type ApplicationStoredEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2StoredEvent,
  type UserId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { OrchestrationEventStore } from "../../persistence/OrchestrationEventStore.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { CurrentOrchestrationActorUserId } from "../forkActor.expbkt3.ts";
import { legacyThreadShell, legacyActivities } from "../legacyProjection.expbkt3.ts";
import { makeForkProviderNameResolver } from "../forkProviderName.expbkt3.ts";
import { forkCompatibilityEvents } from "../forkCompatibilityEvents.expbkt3.ts";

const make = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const projections = yield* ProjectionStoreV2;
  const projectService = yield* ProjectService;
  const eventSink = yield* EventSinkV2;
  const applicationEvents = yield* OrchestrationEventStore;
  const sql = yield* SqlClient.SqlClient;
  const providerName = yield* makeForkProviderNameResolver;
  const invariant = (commandType: string, detail: string, cause?: unknown) =>
    new OrchestrationCommandInvariantError({
      commandType,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const dispatchNative = (command: unknown, actorUserId: UserId | null) =>
    Schema.decodeUnknownEffect(OrchestrationV2Command)(command).pipe(
      Effect.flatMap((decoded) => orchestrator.dispatch(decoded, { actorUserId })),
      Effect.map(({ sequence }) => ({ sequence })),
    );
  const dispatch: OrchestrationEngineShape["dispatch"] = (command, options) =>
    Effect.gen(function* () {
      const actorUserId =
        options?.actorUserId === undefined
          ? yield* CurrentOrchestrationActorUserId
          : options.actorUserId;
      if (
        command.type === "project.create" ||
        command.type === "project.meta.update" ||
        command.type === "project.delete" ||
        command.type === "project.member.add" ||
        command.type === "project.member.remove" ||
        command.type === "project.owner.transfer"
      ) {
        yield* projectService.dispatch({
          ...command,
          ...(command.type === "project.create" ||
          command.type === "project.member.add" ||
          command.type === "project.member.remove" ||
          command.type === "project.owner.transfer"
            ? { actorUserId }
            : {}),
        });
        return { sequence: yield* applicationEvents.latestApplicationSequence };
      }
      switch (command.type) {
        case "thread.create":
          return yield* dispatchNative(
            {
              ...command,
              createdBy: actorUserId === null ? "system" : "user",
              creationSource: "server",
            },
            actorUserId,
          );
        case "thread.meta.update": {
          if (command.parentThreadId != null && command.parentEnvironmentId == null) {
            let parentId: ThreadId | null | undefined = command.parentThreadId;
            const visited = new Set<string>([command.threadId]);
            while (parentId !== null && parentId !== undefined) {
              if (visited.has(parentId))
                return yield* invariant(command.type, "The parent would create a lineage cycle.");
              visited.add(parentId);
              const parent: OrchestrationV2ThreadShell | null =
                yield* projections.getThreadShell(parentId);
              parentId =
                parent?.parentEnvironmentId == null
                  ? (parent?.parentThreadId ?? parent?.lineage.parentThreadId)
                  : null;
            }
          }
          if (command.modelSelection !== undefined)
            yield* dispatchNative(
              {
                type: "thread.model-selection.set",
                commandId: CommandId.make(`${command.commandId}:model`),
                threadId: command.threadId,
                modelSelection: command.modelSelection,
              },
              actorUserId,
            );
          return yield* dispatchNative({ ...command, type: "thread.metadata.update" }, actorUserId);
        }
        case "thread.turn.start": {
          if (command.bootstrap?.createThread !== undefined) {
            const existing = yield* projections.getThreadShell(command.threadId);
            if (existing === null)
              yield* dispatchNative(
                {
                  ...command.bootstrap.createThread,
                  threadId: command.threadId,
                  commandId: CommandId.make(`${command.commandId}:create`),
                  type: "thread.create",
                  createdBy: actorUserId === null ? "agent" : "user",
                  creationSource: "server",
                  runtimeMode: command.runtimeMode,
                  interactionMode: command.interactionMode,
                },
                actorUserId,
              );
          }
          yield* dispatchNative(
            {
              type: "thread.runtime-mode.set",
              commandId: CommandId.make(`${command.commandId}:runtime`),
              threadId: command.threadId,
              runtimeMode: command.runtimeMode,
            },
            actorUserId,
          );
          yield* dispatchNative(
            {
              type: "thread.interaction-mode.set",
              commandId: CommandId.make(`${command.commandId}:interaction`),
              threadId: command.threadId,
              interactionMode: command.interactionMode,
            },
            actorUserId,
          );
          const shell = yield* projections.getThreadShell(command.threadId);
          return yield* dispatchNative(
            {
              ...command.message,
              type: "message.dispatch",
              commandId: command.commandId,
              threadId: command.threadId,
              createdBy: actorUserId === null ? "agent" : "user",
              creationSource: "server",
              dispatchMode: {
                type: shell?.activeRunId == null ? "start_immediately" : "steer_active",
                ...(shell?.activeRunId == null ? {} : { targetRunId: shell.activeRunId }),
              },
              ...(command.modelSelection === undefined
                ? {}
                : { modelSelection: command.modelSelection }),
              ...(command.titleSeed === undefined ? {} : { titleSeed: command.titleSeed }),
              ...(command.sourceProposedPlan === undefined
                ? {}
                : { sourcePlanRef: command.sourceProposedPlan }),
            },
            actorUserId,
          );
        }
        case "thread.message.user.append":
          return yield* dispatchNative(
            {
              ...command,
              ...command.message,
              type: "message.dispatch",
              createdBy: actorUserId === null ? "agent" : "user",
              creationSource: "server",
              dispatchMode: { type: "defer_start" },
            },
            actorUserId,
          );
        case "thread.turn.interrupt": {
          const shell = yield* projections.getThreadShell(command.threadId);
          const runId = command.turnId == null ? shell?.activeRunId : RunId.make(command.turnId);
          if (runId == null) return { sequence: yield* eventSink.latestSequence() };
          return yield* dispatchNative(
            {
              type: "run.interrupt",
              commandId: command.commandId,
              threadId: command.threadId,
              runId,
            },
            actorUserId,
          );
        }
        case "thread.approval.respond":
        case "thread.user-input.respond":
          return yield* dispatchNative(
            {
              ...command,
              type: "runtime-request.respond",
              requestId: RuntimeRequestId.make(command.requestId),
            },
            actorUserId,
          );
        case "thread.user-input.dismiss":
          return yield* dispatchNative(
            { ...command, requestId: RuntimeRequestId.make(command.requestId) },
            actorUserId,
          );
        case "thread.session.restart":
        case "thread.session.stop": {
          const projection = yield* projections.getThreadRecords(command.threadId, [
            "providerThreads",
            "providerSessions",
          ]);
          const sessionIds = [
            ...new Set([
              ...projection.providerThreads.flatMap((thread) =>
                thread.providerSessionId === null ? [] : [thread.providerSessionId],
              ),
              ...projection.providerSessions
                .filter((session) => session.status !== "stopped")
                .map((session) => session.id),
            ]),
          ];
          let sequence = yield* eventSink.latestSequence();
          for (const providerSessionId of sessionIds) {
            const result = yield* dispatchNative(
              {
                type: "provider-session.detach",
                commandId: CommandId.make(`${command.commandId}:detach:${providerSessionId}`),
                threadId: command.threadId,
                providerSessionId,
                reason: command.type,
              },
              actorUserId,
            );
            sequence = result.sequence;
          }
          return { sequence };
        }
        case "thread.checkpoint.revert":
        case "thread.conversation.revert": {
          const projection = yield* projections.getThreadRecords(command.threadId, ["checkpoints"]);
          const checkpoint = projection.checkpoints.find(
            (entry) => entry.appRunOrdinal === command.turnCount,
          );
          if (checkpoint === undefined)
            return yield* invariant(
              command.type,
              "The V2 checkpoint was not found. Historical V1 files remain available through archive reads.",
            );
          return yield* dispatchNative(
            {
              type: "checkpoint.rollback",
              commandId: command.commandId,
              threadId: command.threadId,
              checkpointId: checkpoint.id,
              scopeId: checkpoint.scopeId,
              restoreFiles: command.type === "thread.checkpoint.revert",
            },
            actorUserId,
          );
        }
        case "thread.activity.append":
          return yield* dispatchNative(command, actorUserId);
        default:
          return yield* dispatchNative(command, actorUserId);
      }
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(OrchestrationCommandInvariantError)(cause)
          ? cause
          : invariant(command.type, "The V2 command could not complete.", cause),
      ),
    );

  const eventView = (stored: ApplicationStoredEvent) =>
    Effect.gen(function* () {
      if (!("event" in stored)) {
        const payload =
          stored.type === "project.member-added"
            ? {
                ...stored.payload,
                addedByUserId: stored.metadata.actorUserId ?? null,
                addedAt: stored.occurredAt,
              }
            : stored.type === "project.member-removed"
              ? {
                  ...stored.payload,
                  removedByUserId: stored.metadata.actorUserId ?? null,
                  removedAt: stored.occurredAt,
                }
              : stored.type === "project.owner-transferred"
                ? {
                    ...stored.payload,
                    ownerUserId: stored.payload.userId,
                    previousOwnerUserId:
                      "previousOwnerUserId" in stored.payload
                        ? stored.payload.previousOwnerUserId
                        : null,
                    transferredByUserId: stored.metadata.actorUserId ?? null,
                    transferredAt: stored.occurredAt,
                  }
                : stored.payload;
        const { actorUserId, ...metadata } = stored.metadata;
        return [
          yield* Schema.decodeUnknownEffect(OrchestrationEvent)({
            ...stored,
            payload,
            metadata: { ...metadata, ...(actorUserId == null ? {} : { actorUserId }) },
          }),
        ];
      }
      const event = stored.event;
      const base = {
        sequence: stored.sequence,
        eventId: event.id,
        aggregateKind: "thread",
        aggregateId: event.threadId,
        occurredAt: DateTime.formatIso(event.occurredAt),
        commandId: stored.commandId ?? null,
        causationEventId: null,
        correlationId: stored.commandId ?? event.id,
        metadata: event.actorUserId == null ? {} : { actorUserId: event.actorUserId },
      };
      let type: string;
      let payload: unknown;
      switch (event.type) {
        case "thread.created":
          type = event.type;
          payload = {
            ...event.payload,
            threadId: event.payload.id,
            createdByUserId: event.payload.ownerUserId ?? null,
            createdAt: DateTime.formatIso(event.payload.createdAt),
            updatedAt: DateTime.formatIso(event.payload.updatedAt),
          };
          break;
        case "thread.deleted":
          type = event.type;
          payload = { threadId: event.threadId, deletedAt: base.occurredAt };
          break;
        case "thread.archived":
          type = event.type;
          payload = {
            threadId: event.threadId,
            archivedAt: base.occurredAt,
            updatedAt: base.occurredAt,
          };
          break;
        case "thread.unarchived":
          type = event.type;
          payload = { threadId: event.threadId, updatedAt: base.occurredAt };
          break;
        case "thread.metadata-updated": {
          const shell = yield* projections.getThreadShell(event.threadId);
          if (shell === null) return [];
          type = "thread.meta-updated";
          payload = {
            ...legacyThreadShell(shell),
            threadId: event.threadId,
            updatedAt: base.occurredAt,
          };
          break;
        }
        case "run.created":
        case "run.updated":
        case "provider-session.updated":
        case "provider-session.detached": {
          const shell = yield* projections.getThreadShell(event.threadId);
          if (shell === null) return [];
          type = "thread.session-set";
          payload = {
            threadId: event.threadId,
            session: legacyThreadShell(shell, yield* providerName(shell.providerInstanceId))
              .session,
          };
          break;
        }
        case "message.updated":
          type = "thread.message-sent";
          payload = {
            ...event.payload,
            threadId: event.threadId,
            messageId: event.payload.id,
            turnId: event.payload.runId,
            sentByUserId: event.payload.sentByUserId ?? null,
            createdAt: DateTime.formatIso(event.payload.createdAt),
            updatedAt: DateTime.formatIso(event.payload.updatedAt),
          };
          break;
        case "turn-item.updated": {
          const activities = legacyActivities({ turnItems: [event.payload] });
          if (activities.length === 0) return [];
          type = "thread.activity-appended";
          payload = { threadId: event.threadId, activity: activities[0] };
          break;
        }
        case "plan.updated":
          if (event.payload.kind !== "proposed_plan") return [];
          type = "thread.proposed-plan-upserted";
          payload = {
            threadId: event.threadId,
            proposedPlan: {
              id: event.payload.id,
              turnId: event.payload.runId,
              planMarkdown: event.payload.markdown,
              implementedAt: event.payload.status === "completed" ? base.occurredAt : null,
              implementationThreadId: null,
              createdAt: base.occurredAt,
              updatedAt: base.occurredAt,
            },
          };
          break;
        default:
          return [];
      }
      return [yield* Schema.decodeUnknownEffect(OrchestrationEvent)({ ...base, type, payload })];
    }).pipe(Effect.mapError(toPersistenceSqlError("V2 fork compatibility events")));
  const translate = (source: Stream.Stream<ApplicationStoredEvent, unknown>) =>
    source.pipe(
      Stream.mapEffect(eventView),
      Stream.flatMap((events) => Stream.fromIterable(events)),
      Stream.mapError(toPersistenceSqlError("V2 fork compatibility events")),
    );
  const liveEvents = forkCompatibilityEvents({
    latestSequence: applicationEvents.latestApplicationSequence,
    open: (afterSequence) => applicationEvents.streamApplicationEvents({ afterSequence }),
    replay: (afterSequence, throughSequence) =>
      applicationEvents.readApplicationEvents({ afterSequence, throughSequence }),
    translate: eventView,
  }).pipe(
    Stream.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Stream.failCause(cause).pipe(Stream.orDie)
        : Stream.fromEffect(
            Effect.logWarning("Fork compatibility event stream failed", { cause }),
          ).pipe(Stream.drain),
    ),
  );
  return {
    dispatch,
    readEvents: (fromSequenceExclusive, limit = 200) =>
      Stream.unwrap(
        applicationEvents.latestApplicationSequence.pipe(
          Effect.map((throughSequence) =>
            translate(
              applicationEvents.readApplicationEvents({
                afterSequence: fromSequenceExclusive,
                throughSequence,
              }),
            ).pipe(Stream.take(limit)),
          ),
        ),
      ),
    readThreadEvents: (input) =>
      translate(
        orchestrator.streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence: input.fromSequenceExclusive,
        }),
      ).pipe(
        Stream.takeWhile((event) => event.sequence <= input.toSequenceInclusive),
        Stream.take(input.limit ?? 200),
      ),
    getThreadReplayStats: (input) =>
      sql<{
        eventCount: number;
        payloadBytes: number;
        hasCreateEvent: number;
      }>`SELECT COUNT(*) AS eventCount, COALESCE(SUM(length(payload_json)),0) AS payloadBytes, COALESCE(MAX(event_type = 'thread.created'),0) AS hasCreateEvent FROM orchestration_events WHERE stream_id = ${input.threadId} AND sequence > ${input.fromSequenceExclusive} AND sequence <= ${input.toSequenceInclusive}`.pipe(
        Effect.map((rows) => ({
          ...(rows[0] ?? { eventCount: 0, payloadBytes: 0 }),
          hasCreateEvent: (rows[0]?.hasCreateEvent ?? 0) === 1,
        })),
        Effect.mapError(toPersistenceSqlError("V2 event replay stats")),
      ),
    streamDomainEvents: liveEvents,
    subscribeDomainEvents: applicationEvents.latestApplicationSequence.pipe(
      Effect.map((sequence) =>
        translate(applicationEvents.streamApplicationEvents({ afterSequence: sequence })).pipe(
          Stream.orDie,
        ),
      ),
      Effect.orDie,
    ),
    latestSequence: applicationEvents.latestApplicationSequence.pipe(Effect.orDie),
  } satisfies OrchestrationEngineShape;
});
export const OrchestrationEngineLive = Layer.effect(OrchestrationEngineService, make);
