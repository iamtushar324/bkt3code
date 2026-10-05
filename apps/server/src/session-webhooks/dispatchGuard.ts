/** T3-CUSTOM(expbkt3): webhook admission is checked inside the native thread command lock. */
import { type OrchestrationV2ServerCommand, type UserId } from "@t3tools/contracts";
import { SessionWebhookError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isOwnerOrMember } from "../orchestration-v2/accessRules.ts";
import type { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import {
  managerThreadIsIdle,
  managerThreadRestartCancelled,
} from "../orchestration-v2/managerGuard.expbkt3.ts";
import type { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import type { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { decisionNotification, parseDecisionCallback, receiverTrustBinding } from "./protocol.ts";
import { ToolyardIntegration } from "../toolyard/ToolyardIntegration.ts";

export const assertSessionWebhookDispatch = Effect.fn("sessionWebhook.assertDispatch")(function* (
  command: OrchestrationV2ServerCommand,
  actorUserId: UserId | null,
  webhookId: string,
  projections: ProjectionStoreV2["Service"],
  events: EventSinkV2["Service"],
  projects: ProjectStoreV2["Service"],
) {
  const reject = (detail: string) => new SessionWebhookError({ status: 409, detail });
  if (
    command.type !== "message.dispatch" ||
    command.dispatchMode.type !== "start_immediately" ||
    actorUserId === null
  )
    return yield* reject("invalid-webhook-command");
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    owner_user_id: string;
    thread_id: string;
    instance_id: string;
    trust_binding: string;
    status: string;
  }>`
    SELECT owner_user_id,thread_id,instance_id,trust_binding,status FROM session_webhooks WHERE id=${webhookId}`;
  const row = rows[0];
  if (
    !row ||
    row.status !== "active" ||
    row.owner_user_id !== actorUserId ||
    row.thread_id !== command.threadId
  )
    return yield* reject("webhook-disabled");
  const event = (yield* sql<{
    event_id: string;
    payload: string;
  }>`SELECT event_id,payload FROM session_webhook_events WHERE webhook_id=${webhookId} AND command_id=${command.commandId}`)[0];
  if (
    !event ||
    command.messageId !== `${command.commandId}:message` ||
    command.attachments.length !== 0 ||
    command.modelSelection !== undefined ||
    command.text !== decisionNotification(parseDecisionCallback(event.payload, event.event_id))
  )
    return yield* reject("invalid-webhook-command");
  const integration = yield* ToolyardIntegration;
  const binding = yield* integration.callbackBinding(actorUserId);
  if (!binding || !binding.enabled || receiverTrustBinding(binding) !== row.trust_binding)
    return yield* reject("integration-disabled-or-replaced");
  yield* integration
    .assertConnectionOwner(actorUserId)
    .pipe(Effect.mapError(() => reject("owner-disabled")));

  const localOwner = yield* integration.isLocalOwner(actorUserId);
  const shell = yield* projections.getThreadShell(command.threadId);
  const project = shell ? yield* projects.get(shell.projectId) : Option.none();
  if (
    !shell ||
    Option.isNone(project) ||
    (localOwner
      ? shell.ownerUserId != null || project.value.ownerUserId != null
      : !isOwnerOrMember(shell, actorUserId))
  )
    return yield* reject("destination-unauthorized-or-deleted");
  const restartCancelled = yield* managerThreadRestartCancelled(shell, events);
  if (
    shell.archivedAt !== null ||
    shell.deletedAt !== null ||
    shell.snoozedUntil != null ||
    shell.status === "interrupted" ||
    (shell.status === "cancelled" && !restartCancelled)
  )
    return yield* reject("destination-paused-or-archived");
  const runs = (yield* projections.getThreadRecords(command.threadId, ["runs"])).runs;
  if (
    !managerThreadIsIdle(shell, restartCancelled) ||
    runs.some((run) =>
      ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
    )
  )
    return yield* reject("destination-busy");
});

/** Optional capture leaves upstream/single-user runtimes unchanged and fails closed for callbacks. */
export const makeSessionWebhookDispatchGuard = Effect.gen(function* () {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const integration = yield* Effect.serviceOption(ToolyardIntegration);

  return (
    command: OrchestrationV2ServerCommand,
    actorUserId: UserId | null,
    webhookId: string,
    projections: ProjectionStoreV2["Service"],
    events: EventSinkV2["Service"],
    projects: ProjectStoreV2["Service"],
  ) => {
    if (Option.isNone(sql) || Option.isNone(integration))
      return Effect.fail(
        new SessionWebhookError({ status: 503, detail: "webhook-runtime-unavailable" }),
      );
    return assertSessionWebhookDispatch(
      command,
      actorUserId,
      webhookId,
      projections,
      events,
      projects,
    ).pipe(
      Effect.provideService(SqlClient.SqlClient, sql.value),
      Effect.provideService(ToolyardIntegration, integration.value),
    );
  };
});
