/** T3-CUSTOM(expbkt3): the bridge consumes only an unchanged, idle, directly shared thread. */
import {
  CommandId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type UserId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { isActiveExternalGrant } from "../mcp/UserMcpProfileStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isOwnerOrMember } from "./accessRules.ts";
import type { EventSinkV2 } from "./EventSink.ts";
import type { ProjectStoreV2 } from "./ProjectStore.ts";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";

export interface ManagerDispatchOptions {
  /** T3-CUSTOM(expbkt3): fixed callback destination, checked inside the native lock. */
  readonly sessionWebhookId?: string;
  readonly backgroundGrantHash?: string;
  readonly expectedRevision?: number;
  readonly managerBootstrapGrant?: { readonly hash: string; readonly projectId: ProjectId };
}
export class ManagerDispatchError extends Schema.TaggedError<ManagerDispatchError>()(
  "ManagerDispatchError",
  {
    detail: Schema.String,
  },
) {}

export const managerThreadIsIdle = (
  thread: OrchestrationV2ThreadShell,
  restartCancelled = false,
): boolean =>
  thread.archivedAt === null &&
  thread.deletedAt === null &&
  thread.snoozedUntil == null &&
  thread.activeRunId === null &&
  (thread.status === "idle" ||
    thread.status === "completed" ||
    thread.status === "failed" ||
    restartCancelled) &&
  thread.pendingRuntimeRequest === null &&
  !thread.hasPendingAsyncUserInput &&
  !thread.hasActionableProposedPlan &&
  (thread.pendingBackgroundTasks?.length ?? 0) === 0;

/** Process loss is distinct from a user's stop. Recovery uses a persisted, deterministic command. */
export const managerThreadRestartCancelled = Effect.fn("manager.restartCancelled")(function* (
  thread: OrchestrationV2ThreadShell,
  events: EventSinkV2["Service"],
) {
  if (
    thread.status !== "cancelled" ||
    thread.latestRunId === null ||
    thread.latestRunCompletedAt == null
  )
    return false;
  for (const trigger of ["startup", "shutdown"]) {
    const rows = yield* events
      .readByCommandId({
        commandId: CommandId.make(
          `command:runtime-reconcile:${trigger}:${thread.id}:${DateTime.formatIso(thread.latestRunCompletedAt)}`,
        ),
      })
      .pipe(Stream.runCollect);
    if (
      Array.from(rows).some(
        (stored) =>
          stored.event.type === "run.updated" &&
          stored.event.payload.id === thread.latestRunId &&
          stored.event.payload.status === "cancelled",
      )
    )
      return true;
  }
  return false;
});

export const assertManagerGrant = Effect.fn("manager.assertGrant")(function* (
  actorUserId: UserId,
  grantHash: string,
) {
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  if (
    Option.isNone(settings) ||
    !(yield* settings.value.getSettings).experimental.externalMcp.enabled ||
    !(yield* isActiveExternalGrant(actorUserId, grantHash))
  )
    return yield* new ManagerDispatchError({ detail: "manager-grant-revoked" });
});

/** Bootstrap commands use permanent IDs, so a transient grant refusal must not poison their receipts. */
export const assertManagerBootstrapDispatch = Effect.fn("manager.assertBootstrapDispatch")(
  function* (
    command: OrchestrationV2ServerCommand,
    actorUserId: UserId | null,
    grant: NonNullable<ManagerDispatchOptions["managerBootstrapGrant"]>,
    projections: ProjectionStoreV2["Service"],
    projects: ProjectStoreV2["Service"],
    events: EventSinkV2["Service"],
  ) {
    const reject = (detail: string) => new ManagerDispatchError({ detail });
    if (
      actorUserId === null ||
      (command.type !== "thread.create" &&
        command.type !== "thread.pin" &&
        command.type !== "thread.auto-settle.set") ||
      command.threadId !== `manager:${actorUserId}` ||
      (command.type === "thread.create" && command.projectId !== grant.projectId) ||
      (command.type === "thread.auto-settle.set" && command.enabled)
    )
      return yield* reject("manager-invalid-command");
    yield* assertManagerGrant(actorUserId, grant.hash);
    const project = yield* projects.get(grant.projectId);
    if (Option.isNone(project) || !isOwnerOrMember(project.value, actorUserId))
      return yield* reject("manager-control-denied");
    const shell = yield* projections.getThreadShell(command.threadId);
    if (shell !== null) {
      if (shell.ownerUserId !== actorUserId || shell.projectId !== grant.projectId)
        return yield* reject("manager-control-denied");
      if (
        shell.archivedAt !== null ||
        shell.deletedAt !== null ||
        shell.snoozedUntil != null ||
        shell.status === "interrupted" ||
        (shell.status === "cancelled" && !(yield* managerThreadRestartCancelled(shell, events)))
      )
        return yield* reject("manager-paused");
    } else {
      const existing = yield* projections.getThread(command.threadId).pipe(
        Effect.map(Option.some),
        Effect.catchTag("ProjectionStoreThreadNotFoundError", () => Effect.succeed(Option.none())),
      );
      if (Option.isSome(existing)) return yield* reject("manager-paused");
      if (command.type !== "thread.create") return yield* reject("manager-paused");
    }
  },
);

/** Called inside the native thread lock, after receipt deduplication and before planning effects. */
export const assertManagerDispatch = Effect.fn("manager.assertDispatch")(function* (
  command: OrchestrationV2ServerCommand,
  actorUserId: UserId | null,
  options: ManagerDispatchOptions,
  projections: ProjectionStoreV2["Service"],
  events: EventSinkV2["Service"],
) {
  const reject = (detail: string) => new ManagerDispatchError({ detail });
  if (
    command.type !== "message.dispatch" ||
    actorUserId === null ||
    options.backgroundGrantHash === undefined ||
    options.expectedRevision === undefined ||
    command.dispatchMode.type !== "start_immediately" ||
    command.text.trimStart().startsWith("/")
  )
    return yield* reject("manager-invalid-command");
  yield* assertManagerGrant(actorUserId, options.backgroundGrantHash);
  const shell = yield* projections.getThreadShell(command.threadId);
  if (shell === null || !isOwnerOrMember(shell, actorUserId))
    return yield* reject("manager-control-denied");
  const state = yield* projections.getThreadRecords(command.threadId, ["runs", "messages"], {
    messageIds: [command.messageId],
  });
  if (state.messages.length > 0) return yield* reject("manager-message-conflict");
  const applicationEvents = yield* Effect.serviceOption(OrchestrationEventStore);
  const head = Option.isSome(applicationEvents)
    ? yield* applicationEvents.value.latestApplicationSequence
    : yield* events.latestSequence();
  if (
    !managerThreadIsIdle(shell, yield* managerThreadRestartCancelled(shell, events)) ||
    state.runs.some((run) =>
      ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
    ) ||
    options.expectedRevision > head ||
    (yield* events.latestSequence({ threadId: command.threadId })) > options.expectedRevision
  )
    return yield* reject("manager-stale-or-busy");
});
