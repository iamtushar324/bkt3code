/** T3-CUSTOM(expbkt3): durable, owner-bound session webhook lifecycle and receipts. */
import { CommandId, MessageId, ThreadId, UserId } from "@t3tools/contracts";
import {
  SessionWebhookError,
  SessionWebhookDeliveryHistory,
  type SessionWebhookView,
} from "@t3tools/contracts";
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
import { OrchestrationAccessControl } from "../orchestration-v2/Services/AccessControl.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
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
const decodeDeliveryHistory = Schema.decodeUnknownEffect(
  Schema.Array(SessionWebhookDeliveryHistory).check(Schema.isMaxLength(100)),
);
const historyText = (value: string) =>
  Array.from(value.slice(0, 500), (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  }).join("");

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
  const projections = yield* ProjectionStoreV2;
  const projects = yield* ProjectStoreV2;
  const orchestrator = yield* OrchestratorV2;
  const receipts = yield* CommandReceiptStoreV2;
  const integration = yield* ToolyardIntegration;
  const lifecycleLock = yield* Semaphore.make(1);
  const dispatchLock = yield* Semaphore.make(1);
  const pullLock = yield* Semaphore.make(1);
  let pullCursor: string | null = null;
  let retirementCursor: string | null = null;
  let queueCursor: QueueCursor | null = null;
  const requireOwner = Effect.fn("sessionWebhook.requireOwner")(function* (userId: UserId) {
    yield* integration
      .assertConnectionOwner(userId)
      .pipe(Effect.mapError(() => fail(403, "owner-disabled")));
  });
  const requireDestination = Effect.fn("sessionWebhook.requireDestination")(function* (
    userId: UserId,
    threadId: ThreadId,
  ) {
    yield* requireOwner(userId);
    const shell = yield* projections.getThreadShell(threadId);
    const localOwner = yield* integration.isLocalOwner(userId);
    const project = shell && localOwner ? yield* projects.get(shell.projectId) : Option.none();
    if (
      !shell ||
      (localOwner
        ? shell.ownerUserId != null || Option.isNone(project) || project.value.ownerUserId != null
        : !(yield* access.canAccessThread(userId, threadId)) ||
          !(yield* access.canAccessProject(userId, shell.projectId)))
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
  const rowFor = Effect.fn("sessionWebhook.row")(function* (
    userId: UserId,
    id: string,
    allowedThreadId?: ThreadId,
  ) {
    if (!isId(id)) return yield* fail(400, "invalid-webhook-id");
    yield* requireOwner(userId);
    const row =
      (yield* sql<WebhookRow>`SELECT * FROM session_webhooks WHERE id=${id} AND owner_user_id=${userId}`)[0];
    if (!row || (allowedThreadId !== undefined && row.thread_id !== allowedThreadId))
      return yield* fail(404, "webhook-not-found");
    return row;
  });
  const remoteHistory = Effect.fn("sessionWebhook.remoteHistory")(function* (row: WebhookRow) {
    return yield* Effect.gen(function* () {
      if (row.callback_ref === null) return { deliveryHistory: [], deliveryHistoryError: null };
      yield* requireOwner(UserId.make(row.owner_user_id));
      const binding = yield* integration.callbackBinding(UserId.make(row.owner_user_id));
      if (!binding || !binding.enabled || receiverTrustBinding(binding) !== row.trust_binding)
        return { deliveryHistory: [], deliveryHistoryError: "integration-disabled-or-replaced" };
      const inspection = yield* integration.inspectCallback(
        UserId.make(row.owner_user_id),
        row.callback_ref,
      );
      const current = yield* integration.callbackBinding(UserId.make(row.owner_user_id));
      if (!current || !current.enabled || receiverTrustBinding(current) !== row.trust_binding)
        return { deliveryHistory: [], deliveryHistoryError: "integration-disabled-or-replaced" };
      const deliveryHistory = yield* decodeDeliveryHistory(
        inspection.deliveries.map((delivery) => ({
          eventId: delivery.event_id,
          inboxId: delivery.inbox_id,
          status: delivery.status,
          attempts: delivery.attempts,
          terminalReason: delivery.terminal_reason ? historyText(delivery.terminal_reason) : null,
          history: delivery.history.map((attempt) => ({
            attempt: attempt.attempt,
            at: attempt.at,
            httpStatus: attempt.http_status ?? null,
            outcome: historyText(attempt.outcome),
          })),
        })),
      );
      return { deliveryHistory, deliveryHistoryError: null };
    }).pipe(
      Effect.timeout("2 seconds"),
      // An outage must not hide the durable T3 receipt and dispatch records.
      Effect.catch(() =>
        Effect.succeed({
          deliveryHistory: [],
          deliveryHistoryError: "delivery-history-unavailable",
        }),
      ),
    );
  });
  const localView = Effect.fn("sessionWebhook.localView")(function* (row: WebhookRow) {
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
      deliveryHistory: [],
      deliveryHistoryError: null,
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
  const view = Effect.fn("sessionWebhook.view")(function* (row: WebhookRow) {
    return { ...(yield* localView(row)), ...(yield* remoteHistory(row)) };
  });
  const inspect = Effect.fn("sessionWebhook.inspect")(function* (
    userId: UserId,
    id: string,
    allowedThreadId?: ThreadId,
  ) {
    return yield* view(yield* rowFor(userId, id, allowedThreadId));
  });
  const list = Effect.fn("sessionWebhook.list")(function* (userId: UserId) {
    yield* requireOwner(userId);
    const rows =
      yield* sql<WebhookRow>`SELECT * FROM session_webhooks WHERE owner_user_id=${userId} ORDER BY created_at DESC LIMIT 100`;
    const locals = yield* Effect.forEach(rows, localView, { concurrency: 1 });
    const result: SessionWebhookView[] = locals.map((local) => ({
      ...local,
      deliveryHistoryError: "delivery-history-unavailable",
    }));
    // One shared budget prevents a slow instance from multiplying latency by the number of receivers.
    yield* Effect.forEach(
      rows,
      (row, index) =>
        remoteHistory(row).pipe(
          Effect.tap((remote) =>
            Effect.sync(() => {
              result[index] = { ...locals[index]!, ...remote };
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    ).pipe(Effect.timeoutOption("2 seconds"));
    return result;
  });
  const create = Effect.fn("sessionWebhook.create")(function* (userId: UserId, threadId: ThreadId) {
    yield* requireDestination(userId, threadId);
    const binding = yield* integration.callbackBinding(userId);
    if (!binding || !binding.enabled) return yield* fail(409, "toolyard-integration-disabled");
    const existing =
      (yield* sql<WebhookRow>`SELECT * FROM session_webhooks WHERE owner_user_id=${userId} AND thread_id=${threadId} AND instance_id=${binding.instanceId} AND trust_binding=${receiverTrustBinding(binding)} AND status IN ('active','registering') ORDER BY created_at LIMIT 1`)[0];
    if (existing?.status === "active") return yield* localView(existing);
    const id = existing?.id ?? `swh_${NodeCrypto.randomBytes(16).toString("hex")}`;
    const secret = yield* secrets.getOrCreateRandom(keyName(id), 32);
    const time = now();
    if (!existing)
      yield* sql`INSERT INTO session_webhooks(id,owner_user_id,thread_id,instance_id,trust_binding,status,created_at,updated_at) VALUES(${id},${userId},${threadId},${binding.instanceId},${receiverTrustBinding(binding)},'registering',${time},${time})`;
    const registration = yield* integration.registerCallback(userId, {
      ...(binding.transport === "pull"
        ? { transport: "pull" as const, environment_id: binding.environmentId }
        : {
            destination: new URL(`/api/session-webhooks/${id}`, binding.callbackOrigin).toString(),
          }),
      secret: secretText(secret),
      client_receiver_id: id,
    });
    // Access and instance binding can change during the external registration call.
    yield* requireDestination(userId, threadId);
    const current = yield* integration.callbackBinding(userId);
    if (
      !current ||
      !current.enabled ||
      receiverTrustBinding(current) !== receiverTrustBinding(binding)
    )
      return yield* fail(409, "integration-changed");
    yield* sql`UPDATE session_webhooks SET callback_ref=${registration.callback_ref},receiver_revision=${registration.revision},status='active',updated_at=${now()} WHERE id=${id} AND status='registering'`;
    return yield* localView(yield* rowFor(userId, id));
  });
  const retireReplacedReceiver = Effect.fn("sessionWebhook.retireReplacedReceiver")(function* (
    row: WebhookRow,
  ) {
    const binding = yield* integration.callbackBinding(UserId.make(row.owner_user_id));
    if (binding && receiverTrustBinding(binding) === row.trust_binding) return;
    // A durable replacement can never reconcile an operation against the retired receiver.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const changed =
          yield* sql`UPDATE session_webhooks SET pending_action=NULL,next_sync_at=NULL,status=CASE WHEN status IN ('active','registering') THEN 'disabled' ELSE status END,terminal_reason='integration-disabled-or-replaced',updated_at=${now()} WHERE id=${row.id} AND revision=${row.revision} AND trust_binding=${row.trust_binding} RETURNING id`;
        if (changed.length !== 1) return;
        yield* sql`UPDATE session_webhook_events SET state='terminal',terminal_reason='integration-disabled-or-replaced',updated_at=${now()} WHERE webhook_id=${row.id} AND state IN ('queued','dispatching')`;
      }),
    );
  });
  const synchronizeReceiver = Effect.fn("sessionWebhook.syncReceiver")(function* (row: WebhookRow) {
    if (!row.pending_action || !row.callback_ref) return;
    const binding = yield* integration.callbackBinding(UserId.make(row.owner_user_id));
    if (!binding) return;
    if (receiverTrustBinding(binding) !== row.trust_binding)
      return yield* retireReplacedReceiver(row);
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
    allowedThreadId?: ThreadId,
  ) {
    const row = yield* rowFor(userId, id, allowedThreadId);
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
    yield* synchronizeReceiver(yield* rowFor(userId, id, allowedThreadId)).pipe(
      Effect.catch(() => Effect.void),
    );
    return yield* localView(yield* rowFor(userId, id, allowedThreadId));
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
    const binding = yield* integration.callbackBinding(UserId.make(row.owner_user_id));
    if (!binding || !binding.enabled || receiverTrustBinding(binding) !== row.trust_binding)
      return yield* fail(410, "integration-disabled-or-replaced");
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
        const currentBinding = yield* integration.callbackBinding(
          UserId.make(current.owner_user_id),
        );
        if (
          !currentBinding ||
          !currentBinding.enabled ||
          receiverTrustBinding(currentBinding) !== current.trust_binding
        )
          return yield* fail(410, "integration-disabled-or-replaced");
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
  const pull = Effect.fn("sessionWebhook.pull")(function* () {
    // A rotating bounded batch prevents a disconnected or busy destination from starving others.
    const after = (cursor: string | null) => sql<WebhookRow>`SELECT * FROM session_webhooks
      WHERE status='active' AND callback_ref IS NOT NULL
        AND (${cursor} IS NULL OR id>${cursor}) ORDER BY id LIMIT 10`;
    let rows = yield* after(pullCursor);
    if (rows.length === 0 && pullCursor !== null) rows = yield* after(null);
    for (const row of rows) {
      pullCursor = row.id;
      yield* Effect.gen(function* () {
        const owner = UserId.make(row.owner_user_id);
        yield* requireOwner(owner);
        const binding = yield* integration.callbackBinding(owner);
        if (
          !binding ||
          binding.transport !== "pull" ||
          receiverTrustBinding(binding) !== row.trust_binding
        )
          return;
        const result = yield* integration.pullCallback(owner, row.callback_ref!);
        for (const event of result.events.slice(0, 10)) {
          // The same admission transaction is used for push and pull. A lost acknowledgement
          // retrieves the original content again and reuses the persisted command ID.
          if (event.event_id !== event.headers["webhook-id"])
            return yield* fail(400, "invalid-callback-event-id");
          yield* receive(row.id, event.body, {
            id: event.headers["webhook-id"],
            timestamp: event.headers["webhook-timestamp"],
            signature: event.headers["webhook-signature"],
          });
          yield* integration.ackCallback(owner, row.callback_ref!, event.event_id);
        }
      }).pipe(
        Effect.timeoutOption("2 seconds"),
        // Outages, invalid signatures and conflicting content remain unacknowledged remotely.
        Effect.catch(() => Effect.void),
      );
    }
  });
  const drain = Effect.fn("sessionWebhook.drain")(function* () {
    const after = (cursor: string | null) => sql<WebhookRow>`SELECT * FROM session_webhooks
      WHERE status IN ('active','registering') AND (${cursor} IS NULL OR id>${cursor}) ORDER BY id LIMIT 20`;
    let active = yield* after(retirementCursor);
    if (active.length === 0 && retirementCursor !== null) active = yield* after(null);
    retirementCursor = active.at(-1)?.id ?? null;
    for (const row of active)
      yield* lifecycleLock
        .withPermits(1)(retireReplacedReceiver(row))
        .pipe(Effect.catch(() => Effect.void));
    const updates =
      yield* sql<WebhookRow>`SELECT * FROM session_webhooks WHERE pending_action IS NOT NULL AND sync_attempts<20 AND (next_sync_at IS NULL OR next_sync_at<=${now()}) LIMIT 20`;
    for (const row of updates)
      yield* lifecycleLock.withPermits(1)(
        synchronizeReceiver(row).pipe(
          Effect.catch(() =>
            sql`UPDATE session_webhooks SET sync_attempts=sync_attempts+1,next_sync_at=${row.sync_attempts + 1 >= 20 ? null : DateTime.formatIso(DateTime.makeUnsafe(millis() + Math.min(600_000, 2 ** Math.min(row.sync_attempts, 10) * 2_000)))},terminal_reason=${`${row.pending_action}-server-sync-${row.sync_attempts + 1 >= 20 ? "failed" : "pending"}`} WHERE id=${row.id} AND revision=${row.revision}`.pipe(
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
      const binding = yield* integration.callbackBinding(UserId.make(row.owner_user_id));
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
      lifecycleLock
        .withPermits(1)(create(userId, threadId))
        .pipe(Effect.flatMap((created) => inspect(userId, created.id))),
    inspect,
    list,
    update: (
      userId: UserId,
      id: string,
      action: "disable" | "rotate" | "remove",
      expectedRevision: number,
      allowedThreadId?: ThreadId,
    ) =>
      lifecycleLock
        .withPermits(1)(update(userId, id, action, expectedRevision, allowedThreadId))
        .pipe(Effect.flatMap((updated) => inspect(userId, updated.id, allowedThreadId))),
    receive,
    pull: () =>
      pullLock.withPermits(1)(pull()).pipe(Effect.timeoutOption("5 seconds"), Effect.asVoid),
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
    yield* service.pull().pipe(
      Effect.catch(() =>
        Effect.logWarning("Session webhook pull will retry after a connection error."),
      ),
      Effect.repeat(Schedule.spaced("5 seconds")),
      Effect.forkScoped,
    );
    yield* service.drain().pipe(
      Effect.catch(() =>
        Effect.logWarning("Session webhook dispatch will retry after a storage or runtime error."),
      ),
      Effect.repeat(Schedule.spaced("2 seconds")),
      Effect.forkScoped,
    );
  }),
);
