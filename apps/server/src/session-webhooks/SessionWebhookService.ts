/** T3-CUSTOM(expbkt3): durable, owner-bound session webhook lifecycle and receipts. */
import { CommandId, EnvironmentUserId, MessageId, ThreadId, UserId } from "@t3tools/contracts";
import { SessionWebhookError, type SessionWebhookView } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { EnvironmentUserRepository } from "../persistence/EnvironmentUsers.ts";
import { OrchestrationAccessControl } from "../orchestration-v2/Services/AccessControl.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import {
  CommandReceiptStoreV2,
  layerFromApplicationReceipts,
} from "../orchestration-v2/CommandReceiptStore.ts";
import { ToolyardIntegration } from "../toolyard/ToolyardIntegration.ts";
import {
  callbackCommandId,
  callbackFingerprint,
  decisionNotification,
  parseDecisionCallback,
  verifyStandardWebhook,
  receiverTrustBinding,
} from "./protocol.ts";

const isSessionWebhookError = Schema.is(SessionWebhookError);

interface WebhookRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly thread_id: string;
  readonly instance_id: string;
  readonly trust_binding: string;
  readonly callback_ref: string | null;
  readonly receiver_revision: number;
  readonly status: SessionWebhookView["status"];
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly terminal_reason: string | null;
  readonly pending_action: "rotate" | "disable" | "remove" | null;
  readonly sync_attempts: number;
  readonly next_sync_at: string | null;
}
interface EventRow {
  readonly webhook_id: string;
  readonly event_id: string;
  readonly fingerprint: string;
  readonly payload: string;
  readonly command_id: string;
  readonly state: "queued" | "dispatching" | "delivered" | "terminal";
  readonly received_at: string;
  readonly updated_at: string;
  readonly attempts: number;
  readonly terminal_reason: string | null;
}
interface QueueCursor {
  readonly receivedAt: string;
  readonly webhookId: string;
  readonly eventId: string;
}
const fail = (status: number, detail: string) => new SessionWebhookError({ status, detail });
const now = () => DateTime.formatIso(DateTime.nowUnsafe());
const millis = () => DateTime.toEpochMillis(DateTime.nowUnsafe());
const RotationKey = Schema.fromJsonString(
  Schema.Struct({ expiresAt: Schema.Number, key: Schema.String }),
);
const encodeRotationKey = Schema.encodeSync(RotationKey);
const decodeRotationKey = Schema.decodeUnknownSync(RotationKey);
const keyName = (id: string) => `session-webhook-${id}`;
const secretText = (secret: Uint8Array) => `whsec_${Buffer.from(secret).toString("base64")}`;
const isId = (id: string) => /^swh_[a-f0-9]{32}$/.test(id);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore;
  const access = yield* OrchestrationAccessControl;
  const users = yield* EnvironmentUserRepository;
  const projections = yield* ProjectionStoreV2;
  const orchestrator = yield* OrchestratorV2;
  const receipts = yield* CommandReceiptStoreV2;
  const integration = yield* ToolyardIntegration;
  const lifecycleLock = yield* Semaphore.make(1);
  const dispatchLock = yield* Semaphore.make(1);
  let queueCursor: QueueCursor | null = null;
  const requireOwner = Effect.fn("sessionWebhook.requireOwner")(function* (userId: UserId) {
    const user = yield* users.get(EnvironmentUserId.make(userId));
    if (Option.isNone(user) || user.value.status !== "active")
      return yield* fail(403, "owner-disabled");
  });
  const requireDestination = Effect.fn("sessionWebhook.requireDestination")(function* (
    userId: UserId,
    threadId: ThreadId,
  ) {
    yield* requireOwner(userId);
    const shell = yield* projections.getThreadShell(threadId);
    if (
      !shell ||
      !(yield* access.canAccessThread(userId, threadId)) ||
      !(yield* access.canAccessProject(userId, shell.projectId))
    )
      return yield* fail(403, "destination-unauthorized-or-deleted");
    if (
      shell.deletedAt !== null ||
      shell.archivedAt !== null ||
      shell.snoozedUntil != null ||
      shell.status === "interrupted" ||
      shell.status === "cancelled"
    )
      return yield* fail(409, "destination-paused-or-archived");
    return shell;
  });
  const rowFor = Effect.fn("sessionWebhook.row")(function* (userId: UserId, id: string) {
    if (!isId(id)) return yield* fail(400, "invalid-webhook-id");
    yield* requireOwner(userId);
    const row =
      (yield* sql<WebhookRow>`SELECT * FROM session_webhooks WHERE id=${id} AND owner_user_id=${userId}`)[0];
    if (!row) return yield* fail(404, "webhook-not-found");
    return row;
  });
  const view = Effect.fn("sessionWebhook.view")(function* (row: WebhookRow) {
    const deliveries =
      yield* sql<EventRow>`SELECT * FROM session_webhook_events WHERE webhook_id=${row.id} ORDER BY received_at DESC LIMIT 50`;
    return {
      id: row.id,
      threadId: ThreadId.make(row.thread_id),
      instanceId: row.instance_id,
      callbackRef: row.callback_ref,
      status: row.status,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      terminalReason: row.terminal_reason,
      deliveries: deliveries.map((event) => ({
        eventId: event.event_id,
        state: event.state,
        attempts: event.attempts,
        receivedAt: event.received_at,
        updatedAt: event.updated_at,
        terminalReason: event.terminal_reason,
      })),
    } satisfies SessionWebhookView;
  });
  const inspect = Effect.fn("sessionWebhook.inspect")(function* (userId: UserId, id: string) {
    return yield* view(yield* rowFor(userId, id));
  });
  const list = Effect.fn("sessionWebhook.list")(function* (userId: UserId) {
    yield* requireOwner(userId);
    return yield* Effect.forEach(
      yield* sql<WebhookRow>`SELECT * FROM session_webhooks WHERE owner_user_id=${userId} ORDER BY created_at DESC LIMIT 100`,
      view,
      { concurrency: 1 },
    );
  });
  const create = Effect.fn("sessionWebhook.create")(function* (userId: UserId, threadId: ThreadId) {
    yield* requireDestination(userId, threadId);
    const binding = yield* integration.instanceBinding;
    if (!binding || !binding.enabled) return yield* fail(409, "toolyard-integration-disabled");
    const existing =
      (yield* sql<WebhookRow>`SELECT * FROM session_webhooks WHERE owner_user_id=${userId} AND thread_id=${threadId} AND instance_id=${binding.instanceId} AND trust_binding=${receiverTrustBinding(binding)} AND status IN ('active','registering') ORDER BY created_at LIMIT 1`)[0];
    if (existing?.status === "active") return yield* view(existing);
    const id = existing?.id ?? `swh_${NodeCrypto.randomBytes(16).toString("hex")}`;
    const secret = yield* secrets.getOrCreateRandom(keyName(id), 32);
    const time = now();
    if (!existing)
      yield* sql`INSERT INTO session_webhooks(id,owner_user_id,thread_id,instance_id,trust_binding,status,created_at,updated_at) VALUES(${id},${userId},${threadId},${binding.instanceId},${receiverTrustBinding(binding)},'registering',${time},${time})`;
    const registration = yield* integration.registerCallback(userId, {
      destination: new URL(`/api/session-webhooks/${id}`, binding.callbackOrigin).toString(),
      secret: secretText(secret),
      client_receiver_id: id,
    });
    // Access and instance binding can change during the external registration call.
    yield* requireDestination(userId, threadId);
    const current = yield* integration.instanceBinding;
    if (
      !current ||
      !current.enabled ||
      receiverTrustBinding(current) !== receiverTrustBinding(binding)
    )
      return yield* fail(409, "integration-changed");
    yield* sql`UPDATE session_webhooks SET callback_ref=${registration.callback_ref},receiver_revision=${registration.revision},status='active',updated_at=${now()} WHERE id=${id} AND status='registering'`;
    return yield* inspect(userId, id);
  });
  const synchronizeReceiver = Effect.fn("sessionWebhook.syncReceiver")(function* (row: WebhookRow) {
    if (!row.pending_action || !row.callback_ref) return;
    const binding = yield* integration.instanceBinding;
    if (!binding || receiverTrustBinding(binding) !== row.trust_binding) return;
    const next =
      row.pending_action === "rotate"
        ? yield* secrets.get(`${keyName(row.id)}-next`)
        : Option.none<Uint8Array>();
    if (row.pending_action === "rotate" && Option.isNone(next))
      return yield* fail(503, "rotation-key-unavailable");
    const result = yield* integration.updateCallback(
      UserId.make(row.owner_user_id),
      row.callback_ref,
      {
        action: row.pending_action,
        expected_revision: row.receiver_revision,
        ...(Option.isSome(next) ? { secret: secretText(next.value) } : {}),
      },
    );
    if (Option.isSome(next)) {
      const previous = yield* secrets.get(keyName(row.id));
      if (Option.isSome(previous))
        yield* secrets.set(
          `${keyName(row.id)}-previous`,
          Buffer.from(
            encodeRotationKey({ expiresAt: millis() + 300_000, key: secretText(previous.value) }),
          ),
        );
      yield* secrets.set(keyName(row.id), next.value);
    }
    yield* sql`UPDATE session_webhooks SET receiver_revision=${result.revision},pending_action=NULL,sync_attempts=0,next_sync_at=NULL,terminal_reason=${row.pending_action === "rotate" ? null : row.pending_action},updated_at=${now()} WHERE id=${row.id} AND revision=${row.revision}`;
    if (Option.isSome(next)) yield* secrets.remove(`${keyName(row.id)}-next`).pipe(Effect.ignore);
  });
  const update = Effect.fn("sessionWebhook.update")(function* (
    userId: UserId,
    id: string,
    action: "disable" | "rotate" | "remove",
    expectedRevision: number,
  ) {
    const row = yield* rowFor(userId, id);
    if (row.revision !== expectedRevision) return yield* fail(409, "webhook-revision-conflict");
    // Reconcile the exact remote operation before its successor changes the expected revision.
    if (row.pending_action !== null) return yield* fail(409, "webhook-server-sync-pending");
    if (row.status === "removed" || (action === "rotate" && row.status !== "active"))
      return yield* fail(409, "webhook-disabled-or-update-pending");
    if (action === "rotate") yield* secrets.set(`${keyName(id)}-next`, NodeCrypto.randomBytes(32));
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const changed =
          yield* sql`UPDATE session_webhooks SET status=${action === "rotate" ? "active" : action === "remove" ? "removed" : "disabled"},revision=revision+1,pending_action=${action},sync_attempts=0,next_sync_at=NULL,updated_at=${now()},terminal_reason=${action === "rotate" ? "secret-rotation-pending" : action} WHERE id=${id} AND revision=${expectedRevision} RETURNING id`;
        if (changed.length !== 1) return yield* fail(409, "webhook-revision-conflict");
        if (action !== "rotate")
          yield* sql`UPDATE session_webhook_events SET state='terminal',terminal_reason=${action},updated_at=${now()} WHERE webhook_id=${id} AND state IN ('queued','dispatching')`;
      }),
    );
    if (action === "remove") {
      yield* secrets.remove(keyName(id));
      yield* secrets.remove(`${keyName(id)}-previous`).pipe(Effect.ignore);
      yield* secrets.remove(`${keyName(id)}-next`).pipe(Effect.ignore);
    }
    // Persist the operation before server exchange; a lost response reuses the exact pending key/revision.
    yield* synchronizeReceiver(yield* rowFor(userId, id)).pipe(Effect.catch(() => Effect.void));
    return yield* inspect(userId, id);
  });
  const receive = Effect.fn("sessionWebhook.receive")(function* (
    id: string,
    body: string,
    headers: {
      id?: string | undefined;
      timestamp?: string | undefined;
      signature?: string | undefined;
    },
  ) {
    if (!isId(id)) return yield* fail(404, "webhook-not-found");
    const row = (yield* sql<WebhookRow>`SELECT * FROM session_webhooks WHERE id=${id}`)[0];
    if (!row || row.status !== "active") return yield* fail(410, "webhook-disabled-or-removed");
    const secret = yield* secrets.get(keyName(id));
    if (Option.isNone(secret)) return yield* fail(410, "webhook-secret-unavailable");
    const validSecrets: Uint8Array[] = [secret.value];
    if (row.pending_action === "rotate") {
      const next = yield* secrets.get(`${keyName(id)}-next`);
      if (Option.isSome(next)) validSecrets.push(next.value);
    }
    const previous = yield* secrets.get(`${keyName(id)}-previous`);
    if (Option.isSome(previous)) {
      const stored = yield* Effect.try({
        try: () => decodeRotationKey(Buffer.from(previous.value).toString()),
        catch: () => fail(503, "rotation-key-invalid"),
      });
      if (
        typeof stored === "object" &&
        stored !== null &&
        "expiresAt" in stored &&
        typeof stored.expiresAt === "number" &&
        stored.expiresAt > millis() &&
        "key" in stored &&
        typeof stored.key === "string"
      )
        validSecrets.push(Buffer.from(stored.key.replace(/^whsec_/, ""), "base64"));
    }
    if (
      !verifyStandardWebhook({
        body,
        ...headers,
        secrets: validSecrets,
        nowSeconds: Math.floor(millis() / 1000),
      })
    )
      return yield* fail(401, "invalid-webhook-signature");
    const event = yield* Effect.try({
      try: () => parseDecisionCallback(body, headers.id ?? ""),
      catch: () => fail(400, "invalid-callback-payload"),
    });
    const fingerprint = callbackFingerprint(body);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing =
          (yield* sql<EventRow>`SELECT * FROM session_webhook_events WHERE webhook_id=${id} AND event_id=${event.event_id}`)[0];
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            return yield* fail(409, "event-content-conflict");
          return { accepted: true, duplicate: true, state: existing.state };
        }
        const current = (yield* sql<WebhookRow>`SELECT * FROM session_webhooks WHERE id=${id}`)[0];
        if (current?.status !== "active") return yield* fail(410, "webhook-disabled-or-removed");
        const cutoff = DateTime.formatIso(DateTime.makeUnsafe(millis() - 60_000));
        const count =
          (yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM session_webhook_events WHERE webhook_id=${id} AND received_at>${cutoff}`)[0]
            ?.count ?? 0;
        if (count >= 120) return yield* fail(429, "webhook-rate-limit");
        const time = now();
        yield* sql`INSERT INTO session_webhook_events(webhook_id,event_id,fingerprint,payload,command_id,state,received_at,updated_at) VALUES(${id},${event.event_id},${fingerprint},${body},${callbackCommandId(id, event.event_id)},'queued',${time},${time})`;
        return { accepted: true, duplicate: false, state: "queued" };
      }),
    );
  });
  const drain = Effect.fn("sessionWebhook.drain")(function* () {
    const updates =
      yield* sql<WebhookRow>`SELECT * FROM session_webhooks WHERE pending_action IS NOT NULL AND sync_attempts<20 AND (next_sync_at IS NULL OR next_sync_at<=${now()}) LIMIT 20`;
    for (const row of updates)
      yield* lifecycleLock.withPermits(1)(
        synchronizeReceiver(row).pipe(
          Effect.catch(() =>
            sql`UPDATE session_webhooks SET sync_attempts=sync_attempts+1,next_sync_at=${DateTime.formatIso(DateTime.makeUnsafe(millis() + Math.min(600_000, 2 ** Math.min(row.sync_attempts, 10) * 2_000)))},terminal_reason=${`${row.pending_action}-server-sync-pending`} WHERE id=${row.id} AND revision=${row.revision}`.pipe(
              Effect.asVoid,
            ),
          ),
        ),
      );
    // Keep one head per destination so a busy thread cannot monopolize a batch.
    // Advance across batches because several busy destinations can fill a batch too.
    const pendingAfter = (cursor: QueueCursor | null) => sql<EventRow>`
      WITH heads AS (
        SELECT e.*, ROW_NUMBER() OVER (
          PARTITION BY w.thread_id ORDER BY e.received_at,e.webhook_id,e.event_id
        ) AS position
        FROM session_webhook_events e JOIN session_webhooks w ON w.id=e.webhook_id
        WHERE e.state IN ('queued','dispatching')
      )
      SELECT * FROM heads WHERE position=1
        AND (${cursor?.receivedAt ?? null} IS NULL OR
          (received_at,webhook_id,event_id)>(${cursor?.receivedAt ?? null},${cursor?.webhookId ?? null},${cursor?.eventId ?? null}))
      ORDER BY received_at,webhook_id,event_id LIMIT 20`;
    let pending = yield* pendingAfter(queueCursor);
    if (pending.length === 0 && queueCursor !== null) pending = yield* pendingAfter(null);
    const last = pending.at(-1);
    queueCursor = last
      ? { receivedAt: last.received_at, webhookId: last.webhook_id, eventId: last.event_id }
      : null;
    for (const event of pending) {
      const row =
        (yield* sql<WebhookRow>`SELECT * FROM session_webhooks WHERE id=${event.webhook_id}`)[0];
      const terminal = (reason: string) =>
        sql`UPDATE session_webhook_events SET state='terminal',terminal_reason=${reason},updated_at=${now()} WHERE webhook_id=${event.webhook_id} AND event_id=${event.event_id}`;
      if (!row || row.status !== "active") {
        yield* terminal("webhook-disabled-or-removed");
        continue;
      }
      const commandId = CommandId.make(event.command_id);
      const receipt = yield* receipts.getByCommandId(commandId);
      if (Option.isSome(receipt)) {
        if (receipt.value.status === "accepted" && receipt.value.threadId === row.thread_id)
          yield* sql`UPDATE session_webhook_events SET state='delivered',result_sequence=${receipt.value.resultSequence},updated_at=${now()} WHERE webhook_id=${event.webhook_id} AND event_id=${event.event_id}`;
        else yield* terminal("dispatch-rejected");
        continue;
      }
      if (event.attempts >= 20) {
        yield* terminal("dispatch-retry-limit");
        continue;
      }
      const owner = UserId.make(row.owner_user_id);
      const destination = yield* requireDestination(owner, ThreadId.make(row.thread_id)).pipe(
        Effect.map(Option.some),
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (!isSessionWebhookError(error)) return yield* Effect.fail(error);
            yield* terminal(error.detail);
            return Option.none();
          }),
        ),
      );
      if (Option.isNone(destination)) continue;
      const binding = yield* integration.instanceBinding;
      if (!binding || !binding.enabled || receiverTrustBinding(binding) !== row.trust_binding) {
        yield* terminal("integration-disabled-or-replaced");
        continue;
      }
      const shell = destination.value;
      // Queue behind an active turn or human gate, without sending input into either.
      if (
        shell.activeRunId !== null ||
        shell.pendingRuntimeRequest !== null ||
        shell.hasPendingAsyncUserInput ||
        shell.hasActionableProposedPlan ||
        (shell.pendingBackgroundTasks?.length ?? 0) > 0
      )
        continue;
      const retry = (yield* sql<{
        next_attempt_at: string | null;
      }>`SELECT next_attempt_at FROM session_webhook_events WHERE webhook_id=${event.webhook_id} AND event_id=${event.event_id}`)[0]
        ?.next_attempt_at;
      if (retry && DateTime.toEpochMillis(DateTime.makeUnsafe(retry)) > millis()) continue;
      yield* sql`UPDATE session_webhook_events SET state='dispatching',attempts=attempts+1,updated_at=${now()} WHERE webhook_id=${event.webhook_id} AND event_id=${event.event_id}`;
      const parsed = parseDecisionCallback(event.payload, event.event_id);
      const result = yield* orchestrator
        .dispatch(
          {
            type: "message.dispatch",
            commandId,
            threadId: ThreadId.make(row.thread_id),
            messageId: MessageId.make(`${event.command_id}:message`),
            createdBy: "agent",
            creationSource: "mcp",
            text: decisionNotification(parsed),
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          },
          { actorUserId: owner, sessionWebhookId: row.id },
        )
        .pipe(
          Effect.map(Option.some),
          Effect.catch((error) => {
            const detail =
              "cause" in error && isSessionWebhookError(error.cause) ? error.cause.detail : null;
            if (detail && detail !== "destination-busy")
              return terminal(detail).pipe(Effect.as(Option.none()));
            return sql`UPDATE session_webhook_events SET state='queued',next_attempt_at=${DateTime.formatIso(DateTime.makeUnsafe(millis() + Math.min(600_000, 2 ** Math.min(event.attempts, 10) * 2_000)))},updated_at=${now()} WHERE webhook_id=${event.webhook_id} AND event_id=${event.event_id}`.pipe(
              Effect.as(Option.none()),
            );
          }),
        );
      if (Option.isSome(result))
        yield* sql`UPDATE session_webhook_events SET state='delivered',result_sequence=${result.value.sequence},updated_at=${now()} WHERE webhook_id=${event.webhook_id} AND event_id=${event.event_id}`;
    }
  });
  return {
    create: (userId: UserId, threadId: ThreadId) =>
      lifecycleLock.withPermits(1)(create(userId, threadId)),
    inspect,
    list,
    update: (
      userId: UserId,
      id: string,
      action: "disable" | "rotate" | "remove",
      expectedRevision: number,
    ) => lifecycleLock.withPermits(1)(update(userId, id, action, expectedRevision)),
    receive,
    drain: () => dispatchLock.withPermits(1)(drain()),
  };
});
export class SessionWebhookService extends Context.Service<
  SessionWebhookService,
  Effect.Success<typeof make>
>()("t3/session-webhooks/SessionWebhookService") {}
export const layer = Layer.effect(SessionWebhookService, make).pipe(
  Layer.provide(layerFromApplicationReceipts),
);
export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* SessionWebhookService;
    yield* service.drain().pipe(
      Effect.catch(() =>
        Effect.logWarning("Session webhook dispatch will retry after a storage or runtime error."),
      ),
      Effect.repeat(Schedule.spaced("2 seconds")),
      Effect.forkScoped,
    );
  }),
);
