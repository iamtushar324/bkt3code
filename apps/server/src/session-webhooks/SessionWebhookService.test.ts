/** T3-CUSTOM(expbkt3): durable receiver, access boundaries and receipt recovery. */
import { NodeHttpServer } from "@effect/platform-node";
import { HttpRouter, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { it, assert } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  EnvironmentUserId,
  ProjectId,
  ThreadId,
  UserId,
  type OrchestrationV2ThreadShell,
  SessionWebhookError,
  PersonalMcpSettingsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { EnvironmentUserRepository } from "../persistence/EnvironmentUsers.ts";
import { OrchestrationAccessControl } from "../orchestration-v2/Services/AccessControl.ts";
import type { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { OrchestratorV2, OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import {
  CommandReceiptStoreV2,
  type CommandReceiptV2,
} from "../orchestration-v2/CommandReceiptStore.ts";
import { ToolyardIntegration } from "../toolyard/ToolyardIntegration.ts";
import migration from "../persistence/Migrations/1045_SessionWebhooks.ts";
import { make, SessionWebhookService } from "./SessionWebhookService.ts";
import { sessionWebhookRouteLayer } from "./http.ts";
import { assertSessionWebhookDispatch } from "./dispatchGuard.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isSessionWebhookError = Schema.is(SessionWebhookError);
const isPersistenceSqlError = Schema.is(PersistenceSqlError);
const errorDetail = (error: unknown) =>
  isSessionWebhookError(error) ? error.detail : "unexpected-error";
const owner = UserId.make("user_owner");
const stranger = UserId.make("user_other");
const threadId = ThreadId.make("thread-target");
function scenario<E>(
  test: (
    h: Effect.Success<ReturnType<typeof harness>>,
  ) => Effect.Effect<void, E, SqlClient.SqlClient>,
) {
  return Effect.gen(function* () {
    yield* migration;
    yield* test(yield* harness());
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));
}
const harness = () =>
  Effect.gen(function* () {
    const historyEntered = yield* Deferred.make<void>();
    const twoHistoriesEntered = yield* Deferred.make<void>();
    const fourHistoriesEntered = yield* Deferred.make<void>();
    const secrets = new Map<string, Uint8Array>();
    const receipts = new Map<string, CommandReceiptV2>();
    const state = {
      access: true,
      userEnabled: true,
      busy: false,
      busyThreadIds: [] as string[],
      humanGate: false,
      paused: false,
      archived: false,
      deleted: false,
      integrationEnabled: true,
      instanceId: "instance_1",
      trustGeneration: 0,
      lostReceipt: false,
      rotationOutage: false,
      historyOutage: false,
      historyBlocked: false,
      blockedHistoryReads: 0,
      activeHistoryReads: 0,
      peakHistoryReads: 0,
      historyReads: 0,
      remoteDeliveries: [] as Array<{
        event_id: string;
        inbox_id: string;
        status: "pending" | "delivering" | "delivered" | "failed";
        attempts: number;
        terminal_reason?: string;
        history: Array<{ attempt: number; at: number; http_status?: number; outcome: string }>;
      }>,
      rotationLostReply: false,
      receiverRevision: 1,
      remoteUpdates: 0,
      receiverAction: null as string | null,
      accessReadFailure: false,
      dispatches: 0,
      registrations: 0,
      notifications: [] as string[],
    };
    const shell = (id = threadId) =>
      ({
        id,
        projectId: ProjectId.make("project_1"),
        ownerUserId: owner,
        memberUserIds: [],
        archivedAt: state.archived ? DateTime.nowUnsafe() : null,
        deletedAt: state.deleted ? DateTime.nowUnsafe() : null,
        snoozedUntil: state.paused ? DateTime.nowUnsafe() : null,
        status: "completed",
        activeRunId: state.busy || state.busyThreadIds.includes(id) ? "run_busy" : null,
        pendingRuntimeRequest: state.humanGate ? { kind: "approval" } : null,
        hasPendingAsyncUserInput: false,
        hasActionableProposedPlan: false,
        pendingBackgroundTasks: [],
      }) as unknown as OrchestrationV2ThreadShell;
    const secretService = ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          secrets.set(name, value);
        }),
      create: (name, value) =>
        Effect.sync(() => {
          secrets.set(name, value);
        }),
      remove: (name) =>
        Effect.sync(() => {
          secrets.delete(name);
        }),
      getOrCreateRandom: (name, bytes) =>
        Effect.sync(() => {
          if (!secrets.has(name)) secrets.set(name, Buffer.alloc(bytes, 5));
          return secrets.get(name)!;
        }),
    });
    const userService = {
      get: () =>
        Effect.succeed(
          Option.some({
            userId: EnvironmentUserId.make(owner),
            status: state.userEnabled ? "active" : "blocked",
          }),
        ),
    } as unknown as EnvironmentUserRepository["Service"];
    const accessService = OrchestrationAccessControl.of({
      actorFor: () => Option.some(owner),
      canAccessThread: () =>
        state.accessReadFailure
          ? Effect.fail(
              new PersistenceSqlError({
                operation: "webhook-test-access",
                detail: "temporary read failure",
              }),
            )
          : Effect.succeed(state.access),
      canAccessProject: () => Effect.succeed(state.access),
      canTransferThreadOwnership: () => Effect.succeed(false),
      canTransferProjectOwnership: () => Effect.succeed(false),
    });
    const projections = {
      getThreadShell: (id: ThreadId) => Effect.succeed(state.deleted ? null : shell(id)),
      getThreadRecords: () => Effect.succeed({ runs: [] }),
    } as unknown as ProjectionStoreV2["Service"];
    const integration = ToolyardIntegration.of({
      instanceBinding: Effect.sync(() =>
        state.integrationEnabled
          ? {
              instanceId: state.instanceId,
              trustGeneration: state.trustGeneration,
              environmentId: "env_1",
              origin: "https://toolyard.example",
              callbackOrigin: "https://t3.example",
              enabled: true,
            }
          : null,
      ),
      registerCallback: () =>
        Effect.sync(() => {
          state.registrations++;
          return { callback_ref: `cb_${state.registrations}`, revision: 1 };
        }),
      inspectCallback: () =>
        Effect.gen(function* () {
          state.historyReads++;
          if (state.historyBlocked) {
            state.blockedHistoryReads++;
            state.activeHistoryReads++;
            state.peakHistoryReads = Math.max(state.peakHistoryReads, state.activeHistoryReads);
            yield* Deferred.succeed(historyEntered, undefined);
            if (state.blockedHistoryReads === 2)
              yield* Deferred.succeed(twoHistoriesEntered, undefined);
            if (state.blockedHistoryReads === 4)
              yield* Deferred.succeed(fourHistoriesEntered, undefined);
            return yield* Effect.never.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  state.activeHistoryReads--;
                }),
              ),
            );
          }
          if (state.historyOutage)
            return yield* new PersonalMcpSettingsError({ operation: "test", message: "outage" });
          return { deliveries: state.remoteDeliveries };
        }),
      updateCallback: (_userId, _ref, input) =>
        Effect.gen(function* () {
          state.remoteUpdates++;
          if (state.rotationOutage)
            return yield* new PersonalMcpSettingsError({ operation: "test", message: "outage" });
          if (input.expected_revision !== state.receiverRevision) {
            if (
              input.expected_revision === state.receiverRevision - 1 &&
              input.action === state.receiverAction
            )
              return { revision: state.receiverRevision };
            return yield* new PersonalMcpSettingsError({
              operation: "test",
              message: "revision conflict",
            });
          }
          state.receiverRevision++;
          state.receiverAction = input.action;
          if (state.rotationLostReply) {
            state.rotationLostReply = false;
            return yield* new PersonalMcpSettingsError({
              operation: "test",
              message: "reply lost after commit",
            });
          }
          return { revision: state.receiverRevision };
        }),
      status: () => Effect.die("unused"),
      configure: () => Effect.die("unused"),
      handoff: () => Effect.die("unused"),
    });
    const eventSink = {} as EventSinkV2["Service"];
    const dispatch = (
      command: Parameters<OrchestratorV2["Service"]["dispatch"]>[0],
      options?: Parameters<OrchestratorV2["Service"]["dispatch"]>[1],
    ) =>
      Effect.gen(function* () {
        yield* assertSessionWebhookDispatch(
          command,
          owner,
          options?.sessionWebhookId ?? "",
          projections,
          eventSink,
          {
            get: () => Effect.succeed(Option.some({ id: ProjectId.make("project_1") })),
          } as unknown as ProjectStoreV2["Service"],
        );
        if (command.type !== "message.dispatch") return yield* Effect.die("unexpected command");
        state.dispatches++;
        if ("text" in command) state.notifications.push(command.text);
        receipts.set(command.commandId, {
          commandId: command.commandId,
          threadId: command.threadId,
          commandType: "message.dispatch",
          status: "accepted",
          resultSequence: 7,
          error: null,
          acceptedAt: DateTime.nowUnsafe(),
        });
        if (state.lostReceipt)
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "response-lost",
          });
        return { sequence: 7, storedEvents: [] };
      }).pipe(
        Effect.provideService(ToolyardIntegration, integration),
        Effect.provideService(EnvironmentUserRepository, userService),
        Effect.provideService(OrchestrationAccessControl, accessService),
      );
    const dependencies = Layer.mergeAll(
      Layer.succeed(ServerSecretStore, secretService),
      Layer.succeed(EnvironmentUserRepository, userService),
      Layer.succeed(OrchestrationAccessControl, accessService),
      Layer.succeed(ProjectionStoreV2, projections),
      Layer.succeed(ToolyardIntegration, integration),
      Layer.succeed(CommandReceiptStoreV2, {
        getByCommandId: (id: typeof CommandId.Type) =>
          Effect.sync(() => Option.fromNullishOr(receipts.get(id))),
      } as unknown as CommandReceiptStoreV2["Service"]),
      Layer.succeed(OrchestratorV2, { dispatch } as unknown as OrchestratorV2["Service"]),
    );
    const service = yield* make.pipe(Effect.provide(dependencies));
    const webhook = yield* service.create(owner, threadId);
    const event = (id = "evt_1") => ({
      type: "inbox.decision",
      event_id: id,
      timestamp: DateTime.formatIso(DateTime.nowUnsafe()),
      data: {
        inbox_id: "in_1",
        decision_revision: 2,
        status: "decided",
        calls: [
          { call_id: "same_tool_1", verdict: "accepted", reason: "yes" },
          { call_id: "same_tool_2", verdict: "rejected", reason: "no" },
        ],
        status_ref: "in_1",
      },
    });
    const receive = (payload: ReturnType<typeof event>) => {
      const body = encodeJson(payload);
      const timestamp = String(Math.floor(DateTime.toEpochMillis(DateTime.nowUnsafe()) / 1000));
      const secret = secrets.get(`session-webhook-${webhook.id}`)!;
      return service.receive(webhook.id, body, {
        id: payload.event_id,
        timestamp,
        signature: `v1,${NodeCrypto.createHmac("sha256", secret).update(`${payload.event_id}.${timestamp}.${body}`).digest("base64")}`,
      });
    };
    return {
      service,
      state,
      webhook,
      event,
      receive,
      historyEntered,
      twoHistoriesEntered,
      fourHistoriesEntered,
      receipts,
      secrets,
      restart: () => make.pipe(Effect.provide(dependencies)),
    };
  });
describe("durable session webhooks", () => {
  it.effect(
    "retires obsolete active and registering receivers without events or lifecycle actions",
    () =>
      scenario((h) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const registeringId = "swh_22222222222222222222222222222222";
          yield* sql`INSERT INTO session_webhooks(id,owner_user_id,thread_id,instance_id,trust_binding,status,revision,created_at,updated_at) SELECT ${registeringId},owner_user_id,thread_id,instance_id,trust_binding,'registering',revision,created_at,updated_at FROM session_webhooks WHERE id=${h.webhook.id}`;
          h.state.integrationEnabled = false;
          yield* h.service.drain();
          assert.strictEqual((yield* h.service.inspect(owner, h.webhook.id)).status, "active");
          h.state.integrationEnabled = true;
          h.state.trustGeneration = 1;
          yield* h.service.drain();
          for (const id of [h.webhook.id, registeringId]) {
            const retired = yield* h.service.inspect(owner, id);
            assert.strictEqual(retired.status, "disabled");
            assert.strictEqual(retired.terminalReason, "integration-disabled-or-replaced");
            assert.strictEqual(retired.deliveries.length, 0);
          }
        }),
      ),
  );
  it.effect("retires stale lifecycle operations so they cannot starve a new generation", () =>
    scenario((h) =>
      Effect.gen(function* () {
        yield* h.receive(h.event());
        h.state.rotationOutage = true;
        yield* h.service.update(owner, h.webhook.id, "rotate", h.webhook.revision);
        const sql = yield* SqlClient.SqlClient;
        for (let i = 2; i <= 20; i++) {
          const id = `swh_${i.toString(16).padStart(32, "0")}`;
          yield* sql`INSERT INTO session_webhooks(id,owner_user_id,thread_id,instance_id,trust_binding,callback_ref,receiver_revision,status,revision,created_at,updated_at,pending_action,sync_attempts) SELECT ${id},owner_user_id,thread_id,instance_id,trust_binding,callback_ref,receiver_revision,${i === 2 ? "removed" : i === 3 ? "disabled" : "active"},revision,created_at,updated_at,pending_action,7 FROM session_webhooks WHERE id=${h.webhook.id}`;
        }
        h.state.trustGeneration = 1;
        const replacement = yield* h.service.create(owner, threadId);
        yield* h.service.update(owner, replacement.id, "rotate", replacement.revision);
        h.state.rotationOutage = false;
        yield* h.service.drain();
        yield* h.service.drain();
        const current = yield* h.service.inspect(owner, replacement.id);
        assert.strictEqual(current.status, "active");
        assert.strictEqual(current.terminalReason, null);
        assert.strictEqual(h.state.receiverRevision, 2);
        const retired = yield* h.service.inspect(owner, h.webhook.id);
        assert.strictEqual(retired.status, "disabled");
        assert.strictEqual(retired.deliveries[0]?.state, "terminal");
        const old = yield* sql<{
          status: string;
          pending_action: string | null;
          next_sync_at: string | null;
          sync_attempts: number;
        }>`SELECT status,pending_action,next_sync_at,sync_attempts FROM session_webhooks WHERE id=${`swh_${(2).toString(16).padStart(32, "0")}`}`;
        assert.strictEqual(old[0]?.status, "removed");
        assert.strictEqual(old[0]?.pending_action, null);
        assert.strictEqual(old[0]?.next_sync_at, null);
        assert.strictEqual(old[0]?.sync_attempts, 7);
        assert.strictEqual(
          (yield* sql<{
            status: string;
          }>`SELECT status FROM session_webhooks WHERE id=${`swh_${(3).toString(16).padStart(32, "0")}`}`)[0]
            ?.status,
          "disabled",
        );
        assert.strictEqual(h.state.dispatches, 0);
      }),
    ),
  );
  it.effect(
    "recreates callbacks after same-instance trust replacement and never revives the old queue",
    () =>
      scenario((h) =>
        Effect.gen(function* () {
          yield* h.receive(h.event());
          // A remove/re-add or rapid disable/enable has the same URLs but a new durable generation.
          h.state.trustGeneration = 2;
          const replacement = yield* h.service.create(owner, threadId);
          assert.notStrictEqual(replacement.id, h.webhook.id);
          assert.notStrictEqual(replacement.callbackRef, h.webhook.callbackRef);
          assert.strictEqual(h.state.registrations, 2);
          const stale = yield* h.receive(h.event("evt_stale")).pipe(Effect.flip);
          assert.strictEqual(errorDetail(stale), "integration-disabled-or-replaced");
          yield* h.service.drain();
          const retired = (yield* h.service.inspect(owner, h.webhook.id)).deliveries[0];
          assert.strictEqual(retired?.state, "terminal");
          assert.strictEqual(retired?.terminalReason, "integration-disabled-or-replaced");
          assert.strictEqual(h.state.dispatches, 0);
          h.state.trustGeneration = 4;
          yield* h.service.drain();
          assert.strictEqual(
            (yield* h.service.inspect(owner, h.webhook.id)).deliveries[0]?.state,
            "terminal",
          );
          assert.strictEqual(h.state.dispatches, 0);
        }),
      ),
  );
  it.effect("bounds a hanging history inspection and preserves its local receipt", () =>
    scenario((h) =>
      Effect.gen(function* () {
        yield* h.receive(h.event());
        h.state.historyBlocked = true;
        const inspection = yield* Effect.forkChild(h.service.inspect(owner, h.webhook.id));
        yield* Deferred.await(h.historyEntered);
        yield* TestClock.adjust("2 seconds");
        const result = yield* Fiber.join(inspection);
        assert.strictEqual(result.deliveries.length, 1);
        assert.strictEqual(result.deliveryHistoryError, "delivery-history-unavailable");
        assert.strictEqual(h.state.activeHistoryReads, 0);
      }),
    ),
  );
  it.effect(
    "uses one list history budget with bounded concurrency and preserves every local row",
    () =>
      scenario((h) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (let i = 2; i <= 7; i++) {
            const id = `swh_${i.toString(16).padStart(32, "0")}`;
            yield* sql`INSERT INTO session_webhooks(id,owner_user_id,thread_id,instance_id,trust_binding,callback_ref,receiver_revision,status,revision,created_at,updated_at) SELECT ${id},owner_user_id,thread_id,instance_id,trust_binding,callback_ref,receiver_revision,status,revision,created_at,updated_at FROM session_webhooks WHERE id=${h.webhook.id}`;
          }
          yield* h.receive(h.event());
          h.state.historyBlocked = true;
          const listing = yield* Effect.forkChild(h.service.list(owner));
          yield* Deferred.await(h.fourHistoriesEntered);
          assert.strictEqual(h.state.peakHistoryReads, 4);
          yield* TestClock.adjust("2 seconds");
          const result = yield* Fiber.join(listing);
          assert.strictEqual(result.length, 7);
          assert.strictEqual(
            result.reduce((count, row) => count + row.deliveries.length, 0),
            1,
          );
          assert.strictEqual(
            result.every((row) => row.deliveryHistoryError === "delivery-history-unavailable"),
            true,
          );
          assert.strictEqual(h.state.activeHistoryReads, 0);
          assert.strictEqual(h.state.peakHistoryReads, 4);
        }),
      ),
  );
  it.effect("releases the lifecycle lock before history retrieval", () =>
    scenario((h) =>
      Effect.gen(function* () {
        h.state.historyBlocked = true;
        const creating = yield* Effect.forkChild(h.service.create(owner, threadId));
        yield* Deferred.await(h.historyEntered);
        const disabling = yield* Effect.forkChild(
          h.service.update(owner, h.webhook.id, "disable", h.webhook.revision),
        );
        yield* Deferred.await(h.twoHistoriesEntered);
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual(
          (yield* sql<{
            status: string;
          }>`SELECT status FROM session_webhooks WHERE id=${h.webhook.id}`)[0]?.status,
          "disabled",
        );
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(creating);
        assert.strictEqual((yield* Fiber.join(disabling)).status, "disabled");
        assert.strictEqual(h.state.activeHistoryReads, 0);
      }),
    ),
  );
  it.effect(
    "shows failed Toolyard deliveries that never reached T3 and their physical attempts",
    () =>
      scenario((h) =>
        Effect.gen(function* () {
          h.state.remoteDeliveries = [
            {
              event_id: "evt_never_received",
              inbox_id: "in_failed",
              status: "failed",
              attempts: 2,
              terminal_reason: "retry_limit",
              history: [
                { attempt: 1, at: 1_000, http_status: 503, outcome: "receiver unavailable" },
                { attempt: 2, at: 2_000, outcome: "timeout\nwithout response" },
              ],
            },
          ];
          const view = yield* h.service.inspect(owner, h.webhook.id);
          assert.strictEqual(view.deliveries.length, 0);
          assert.strictEqual(view.deliveryHistory?.[0]?.eventId, "evt_never_received");
          assert.strictEqual(view.deliveryHistory?.[0]?.history[0]?.httpStatus, 503);
          assert.strictEqual(
            view.deliveryHistory?.[0]?.history[1]?.outcome,
            "timeout without response",
          );
          assert.strictEqual(view.deliveryHistoryError, null);
        }),
      ),
  );
  it.effect("preserves local history on an outage and refuses old instance credentials", () =>
    scenario((h) =>
      Effect.gen(function* () {
        yield* h.receive(h.event());
        h.state.historyOutage = true;
        const unavailable = yield* h.service.inspect(owner, h.webhook.id);
        assert.strictEqual(unavailable.deliveries.length, 1);
        assert.strictEqual(unavailable.deliveryHistoryError, "delivery-history-unavailable");
        const reads = h.state.historyReads;
        h.state.instanceId = "replaced_instance";
        const replaced = yield* h.service.inspect(owner, h.webhook.id);
        assert.strictEqual(replaced.deliveries.length, 1);
        assert.strictEqual(replaced.deliveryHistoryError, "integration-disabled-or-replaced");
        h.state.integrationEnabled = false;
        yield* h.service.list(owner);
        assert.strictEqual(h.state.historyReads, reads);
      }),
    ),
  );
  it.effect("rejects unbounded delivery history without hiding local records", () =>
    scenario((h) =>
      Effect.gen(function* () {
        h.state.remoteDeliveries = Array.from({ length: 101 }, () => ({
          event_id: "evt",
          inbox_id: "in",
          status: "failed" as const,
          attempts: 0,
          history: [],
        }));
        const view = yield* h.service.inspect(owner, h.webhook.id);
        assert.strictEqual(view.deliveryHistoryError, "delivery-history-unavailable");
        assert.deepStrictEqual(view.deliveryHistory, []);
      }),
    ),
  );
  it.effect("exposes final lifecycle sync failure and stops automatic retries", () =>
    scenario((h) =>
      Effect.gen(function* () {
        h.state.rotationOutage = true;
        yield* h.service.update(owner, h.webhook.id, "rotate", h.webhook.revision);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE session_webhooks SET sync_attempts=19,next_sync_at=NULL WHERE id=${h.webhook.id}`;
        yield* h.service.drain();
        assert.strictEqual(
          (yield* h.service.inspect(owner, h.webhook.id)).terminalReason,
          "rotate-server-sync-failed",
        );
        h.state.rotationOutage = false;
        yield* h.service.drain();
        assert.strictEqual(h.state.receiverRevision, 1);
      }),
    ),
  );
  it.effect("persists complete outcomes before ack and deduplicates matching deliveries", () =>
    scenario((h) =>
      Effect.gen(function* () {
        const event = h.event();
        assert.strictEqual((yield* h.receive(event)).duplicate, false);
        assert.strictEqual((yield* h.receive(event)).duplicate, true);
        assert.strictEqual(h.state.dispatches, 0);
        yield* h.service.drain();
        yield* h.service.drain();
        assert.strictEqual(h.state.dispatches, 1);
        const current = yield* h.service.inspect(owner, h.webhook.id);
        assert.strictEqual(current.deliveries.length, 1);
        assert.strictEqual(current.deliveries[0]?.state, "delivered");
      }),
    ),
  );
  it.effect.each([
    {
      text: "Keep this exact text.\nSecond line.",
      submitted_at: 1_791_115_200_000,
      user_id: "user_owner",
    },
    {
      selected_option_ids: ["desktop", "mobile"],
      selected_labels: ["Desktop", "Mobile"],
      text: "Also support tablets.",
      submitted_at: 1_791_115_200_000,
      user_id: "user_owner",
    },
  ])("persists and dispatches a signed Toolyard question answer: %j", (response) =>
    scenario((h) =>
      Effect.gen(function* () {
        const event = h.event();
        const payload = { ...event, data: { ...event.data, calls: [], response } };
        assert.strictEqual((yield* h.receive(payload)).duplicate, false);
        assert.strictEqual((yield* h.receive(payload)).duplicate, true);
        yield* h.service.drain();
        assert.strictEqual(h.state.dispatches, 1);
        assert.strictEqual(h.state.notifications[0]?.includes(encodeJson(response)), true);
        assert.strictEqual(
          h.state.notifications[0]?.includes("Read the authoritative Inbox status"),
          true,
        );
        assert.strictEqual(
          (yield* h.service.inspect(owner, h.webhook.id)).deliveries[0]?.state,
          "delivered",
        );
      }),
    ),
  );
  it.effect("rejects changed content for reused event IDs", () =>
    scenario((h) =>
      Effect.gen(function* () {
        const event = h.event();
        yield* h.receive(event);
        const error = yield* h
          .receive({ ...event, data: { ...event.data, status_ref: "in_2" } })
          .pipe(Effect.flip);
        assert.strictEqual(
          isSessionWebhookError(error) ? error.detail : "unexpected",
          "event-content-conflict",
        );
      }),
    ),
  );
  it.effect("queues behind a busy agent and reconciles a lost dispatch reply", () =>
    scenario((h) =>
      Effect.gen(function* () {
        h.state.busy = true;
        yield* h.receive(h.event());
        yield* h.service.drain();
        assert.strictEqual(h.state.dispatches, 0);
        h.state.busy = false;
        h.state.lostReceipt = true;
        yield* h.service.drain();
        assert.strictEqual(h.state.dispatches, 1);
        yield* h.service.drain();
        assert.strictEqual(h.state.dispatches, 1);
        assert.strictEqual(
          (yield* h.service.inspect(owner, h.webhook.id)).deliveries[0]?.state,
          "delivered",
        );
      }),
    ),
  );
  it.effect.each(["paused", "archived", "deleted"] as const)(
    "stops %s destinations without resuming",
    (flag) =>
      scenario((h) =>
        Effect.gen(function* () {
          yield* h.receive(h.event());
          h.state[flag] = true;
          yield* h.service.drain();
          assert.strictEqual(h.state.dispatches, 0);
          assert.strictEqual(
            (yield* h.service.inspect(owner, h.webhook.id)).deliveries[0]?.state,
            "terminal",
          );
          h.state[flag] = false;
          yield* h.service.drain();
          assert.strictEqual(h.state.dispatches, 0);
        }),
      ),
  );
  it.effect("stops revoked access and instance changes", () =>
    scenario((h) =>
      Effect.gen(function* () {
        yield* h.receive(h.event());
        h.state.access = false;
        yield* h.service.drain();
        assert.strictEqual(h.state.dispatches, 0);
        assert.strictEqual(
          (yield* h.service.inspect(owner, h.webhook.id)).deliveries[0]?.state,
          "terminal",
        );
        h.state.access = true;
        yield* h.receive(h.event("evt_2"));
        h.state.instanceId = "instance_2";
        yield* h.service.drain();
        assert.strictEqual(h.state.dispatches, 0);
      }),
    ),
  );
  it.effect("retries a transient destination storage failure without discarding the event", () =>
    scenario((h) =>
      Effect.gen(function* () {
        yield* h.receive(h.event());
        h.state.accessReadFailure = true;
        const error = yield* h.service.drain().pipe(Effect.flip);
        assert.strictEqual(isPersistenceSqlError(error), true);
        const pending = (yield* h.service.inspect(owner, h.webhook.id)).deliveries[0];
        assert.strictEqual(pending?.state, "queued");
        assert.strictEqual(pending?.terminalReason, null);
        assert.strictEqual(h.state.dispatches, 0);
        h.state.accessReadFailure = false;
        yield* h.service.drain();
        assert.strictEqual(h.state.dispatches, 1);
        assert.strictEqual(
          (yield* h.service.inspect(owner, h.webhook.id)).deliveries[0]?.state,
          "delivered",
        );
      }),
    ),
  );
  it.effect(
    "rejects a thread-bound caller before history, secret, remote or database changes",
    () =>
      scenario((h) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const otherThread = ThreadId.make("thread-narrow-caller");
          yield* h.receive(h.event());
          const before = yield* sql`SELECT * FROM session_webhooks WHERE id=${h.webhook.id}`;
          const beforeEvents =
            yield* sql`SELECT * FROM session_webhook_events WHERE webhook_id=${h.webhook.id}`;
          const beforeSecrets = Array.from(h.secrets, ([key, value]) => [key, Buffer.from(value)]);
          const historyReads = h.state.historyReads;
          assert.strictEqual(
            errorDetail(
              yield* h.service.inspect(owner, h.webhook.id, otherThread).pipe(Effect.flip),
            ),
            "webhook-not-found",
          );
          for (const action of ["disable", "rotate", "remove"] as const) {
            assert.strictEqual(
              errorDetail(
                yield* h.service
                  .update(owner, h.webhook.id, action, 1, otherThread)
                  .pipe(Effect.flip),
              ),
              "webhook-not-found",
            );
          }
          assert.strictEqual(h.state.historyReads, historyReads);
          assert.strictEqual(h.state.remoteUpdates, 0);
          assert.deepStrictEqual(
            Array.from(h.secrets, ([key, value]) => [key, Buffer.from(value)]),
            beforeSecrets,
          );
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM session_webhooks WHERE id=${h.webhook.id}`,
            before,
          );
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM session_webhook_events WHERE webhook_id=${h.webhook.id}`,
            beforeEvents,
          );
          assert.strictEqual(
            (yield* h.service.inspect(owner, h.webhook.id, threadId)).id,
            h.webhook.id,
          );
          assert.strictEqual(
            (yield* h.service.update(owner, h.webhook.id, "disable", 1, threadId)).status,
            "disabled",
          );
        }),
      ),
  );
  it.effect("enforces owner and revision on lifecycle actions", () =>
    scenario((h) =>
      Effect.gen(function* () {
        assert.strictEqual(
          errorDetail(yield* h.service.inspect(stranger, h.webhook.id).pipe(Effect.flip)),
          "webhook-not-found",
        );
        assert.strictEqual(
          errorDetail(yield* h.service.update(owner, h.webhook.id, "disable", 2).pipe(Effect.flip)),
          "webhook-revision-conflict",
        );
        yield* h.receive(h.event());
        yield* h.service.update(owner, h.webhook.id, "disable", 1);
        yield* h.service.drain();
        assert.strictEqual(h.state.dispatches, 0);
        assert.strictEqual(
          errorDetail(yield* h.receive(h.event("evt_2")).pipe(Effect.flip)),
          "webhook-disabled-or-removed",
        );
      }),
    ),
  );
  it.effect("recovers queued events after service restart", () =>
    scenario((h) =>
      Effect.gen(function* () {
        yield* h.receive(h.event());
        const restarted = yield* h.restart();
        yield* restarted.drain();
        assert.strictEqual(h.state.dispatches, 1);
        yield* h.service.drain();
        assert.strictEqual(h.state.dispatches, 1);
      }),
    ),
  );
  it.effect("never answers a pending human gate", () =>
    scenario((h) =>
      Effect.gen(function* () {
        h.state.humanGate = true;
        yield* h.receive(h.event());
        yield* h.service.drain();
        assert.strictEqual(h.state.dispatches, 0);
        h.state.humanGate = false;
        yield* h.service.drain();
        assert.strictEqual(h.state.dispatches, 1);
      }),
    ),
  );
  it.effect("delivers an idle destination behind twenty callbacks for a busy thread", () =>
    scenario((h) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        h.state.busyThreadIds.push(threadId);
        for (let index = 0; index < 20; index++) yield* h.receive(h.event(`evt_busy_${index}`));
        const idle = yield* h.service.create(owner, ThreadId.make("thread-idle"));
        yield* sql`INSERT INTO session_webhook_events(webhook_id,event_id,fingerprint,payload,command_id,state,received_at,updated_at)
          SELECT ${idle.id},'evt_idle',fingerprint,REPLACE(payload,'evt_busy_0','evt_idle'),'idle-command','queued','9999-01-01','9999-01-01'
          FROM session_webhook_events WHERE webhook_id=${h.webhook.id} AND event_id='evt_busy_0'`;
        yield* h.service.drain();
        assert.strictEqual(h.state.dispatches, 1);
        assert.strictEqual(
          (yield* h.service.inspect(owner, idle.id)).deliveries[0]?.state,
          "delivered",
        );
        assert.strictEqual(
          (yield* h.service.inspect(owner, h.webhook.id)).deliveries.every(
            (event) => event.state === "queued",
          ),
          true,
        );
      }),
    ),
  );
  it.effect("preserves destination order when its first callback has future backoff", () =>
    scenario((h) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* h.receive(h.event("evt_first"));
        yield* h.receive(h.event("evt_second"));
        yield* sql`UPDATE session_webhook_events SET received_at='2026-01-01',next_attempt_at='9999-01-01' WHERE webhook_id=${h.webhook.id} AND event_id='evt_first'`;
        yield* h.service.drain();
        yield* h.service.drain();
        assert.strictEqual(h.state.dispatches, 0);
        yield* sql`UPDATE session_webhook_events SET next_attempt_at=NULL WHERE webhook_id=${h.webhook.id} AND event_id='evt_first'`;
        yield* h.service.drain();
        assert.strictEqual(h.state.dispatches, 1);
        assert.strictEqual(h.state.notifications[0]?.includes('"event_id":"evt_first"'), true);
        yield* h.service.drain();
        assert.strictEqual(h.state.dispatches, 2);
        assert.strictEqual(h.state.notifications[1]?.includes('"event_id":"evt_second"'), true);
      }),
    ),
  );
  it.effect.each(["busy", "backoff"] as const)(
    "advances past twenty %s destinations without starvation",
    (blocked) =>
      scenario((h) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* h.receive(h.event());
          yield* sql`UPDATE session_webhook_events SET next_attempt_at='9999-01-01' WHERE webhook_id=${h.webhook.id}`;
          for (let index = 0; index < 20; index++) {
            const id = ThreadId.make(`thread-busy-${index}`);
            if (blocked === "busy") h.state.busyThreadIds.push(id);
            const webhook = yield* h.service.create(owner, id);
            yield* sql`INSERT INTO session_webhook_events(webhook_id,event_id,fingerprint,payload,command_id,state,received_at,updated_at)
            SELECT ${webhook.id},event_id,fingerprint,payload,${`busy-command-${index}`},'queued','2026-01-01','2026-01-01'
            FROM session_webhook_events WHERE webhook_id=${h.webhook.id}`;
            if (blocked === "backoff")
              yield* sql`UPDATE session_webhook_events SET next_attempt_at='9999-01-01' WHERE webhook_id=${webhook.id}`;
          }
          const idle = yield* h.service.create(owner, ThreadId.make("thread-idle"));
          yield* sql`INSERT INTO session_webhook_events(webhook_id,event_id,fingerprint,payload,command_id,state,received_at,updated_at)
          SELECT ${idle.id},event_id,fingerprint,payload,'idle-command','queued','9998-01-01','9998-01-01'
          FROM session_webhook_events WHERE webhook_id=${h.webhook.id}`;
          yield* h.service.drain();
          assert.strictEqual(h.state.dispatches, 0);
          yield* h.service.drain();
          assert.strictEqual(h.state.dispatches, 1);
          assert.strictEqual(
            (yield* h.service.inspect(owner, idle.id)).deliveries[0]?.state,
            "delivered",
          );
          assert.strictEqual(
            (yield* h.service.inspect(owner, h.webhook.id)).deliveries[0]?.attempts,
            0,
          );
        }),
      ),
  );
  it.effect("deduplicates concurrent deliveries and drains", () =>
    scenario((h) =>
      Effect.gen(function* () {
        const event = h.event();
        yield* Effect.all([h.receive(event), h.receive(event)], { concurrency: 2 });
        yield* Effect.all([h.service.drain(), h.service.drain()], { concurrency: 2 });
        assert.strictEqual(h.state.dispatches, 1);
      }),
    ),
  );
  it.effect("rotates the server-only key and bounds revision changes", () =>
    scenario((h) =>
      Effect.gen(function* () {
        const before = h.secrets.get(`session-webhook-${h.webhook.id}`);
        const rotated = yield* h.service.update(owner, h.webhook.id, "rotate", 1);
        assert.strictEqual(rotated.revision, 2);
        assert.notDeepEqual(h.secrets.get(`session-webhook-${h.webhook.id}`), before);
        yield* h.receive(h.event());
        yield* h.service.drain();
        assert.strictEqual(h.state.dispatches, 1);
        assert.strictEqual(
          errorDetail(yield* h.service.update(owner, h.webhook.id, "rotate", 1).pipe(Effect.flip)),
          "webhook-revision-conflict",
        );
      }),
    ),
  );
  it.effect("recovers a pending key exchange after restart without a new key", () =>
    scenario((h) =>
      Effect.gen(function* () {
        h.state.rotationOutage = true;
        const pending = yield* h.service.update(owner, h.webhook.id, "rotate", 1);
        assert.strictEqual(pending.revision, 2);
        assert.strictEqual(pending.terminalReason, "secret-rotation-pending");
        const next = h.secrets.get(`session-webhook-${h.webhook.id}-next`)!;
        h.state.rotationOutage = false;
        const restarted = yield* h.restart();
        yield* restarted.drain();
        assert.deepStrictEqual(h.secrets.get(`session-webhook-${h.webhook.id}`), next);
        assert.strictEqual((yield* restarted.inspect(owner, h.webhook.id)).terminalReason, null);
      }),
    ),
  );
  it.effect("reconciles a committed rotation before a dependent disable or remove", () =>
    scenario((h) =>
      Effect.gen(function* () {
        h.state.rotationLostReply = true;
        const pending = yield* h.service.update(owner, h.webhook.id, "rotate", 1);
        const next = h.secrets.get(`session-webhook-${h.webhook.id}-next`);
        assert.strictEqual(pending.terminalReason, "secret-rotation-pending");
        assert.strictEqual(h.state.receiverRevision, 2);
        for (const action of ["disable", "remove"] as const)
          assert.strictEqual(
            errorDetail(yield* h.service.update(owner, h.webhook.id, action, 2).pipe(Effect.flip)),
            "webhook-server-sync-pending",
          );
        assert.deepStrictEqual(h.secrets.get(`session-webhook-${h.webhook.id}-next`), next);
        yield* h.service.drain();
        assert.strictEqual((yield* h.service.inspect(owner, h.webhook.id)).terminalReason, null);
        assert.deepStrictEqual(h.secrets.get(`session-webhook-${h.webhook.id}`), next);
        const disabled = yield* h.service.update(owner, h.webhook.id, "disable", 2);
        assert.strictEqual(disabled.status, "disabled");
        assert.strictEqual(h.state.receiverAction, "disable");
        assert.strictEqual(h.state.receiverRevision, 3);
        const removed = yield* h.service.update(owner, h.webhook.id, "remove", 3);
        assert.strictEqual(removed.status, "removed");
        assert.strictEqual(h.state.receiverAction, "remove");
        assert.strictEqual(h.state.receiverRevision, 4);
      }),
    ),
  );
  it.effect("authenticates HTTP callbacks before durable acknowledgement", () =>
    scenario((h) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* HttpRouter.serve(
            sessionWebhookRouteLayer.pipe(
              Layer.provide(Layer.succeed(SessionWebhookService, h.service)),
            ),
            { disableListenLog: true, disableLogger: true },
          ).pipe(Layer.build);
          const client = yield* HttpClient.HttpClient;
          const send = (payload: unknown, signatureValid = true) =>
            Effect.gen(function* () {
              const body = encodeJson(payload);
              const timestamp = String(
                Math.floor(DateTime.toEpochMillis(DateTime.nowUnsafe()) / 1000),
              );
              const secret = h.secrets.get(`session-webhook-${h.webhook.id}`)!;
              const request = HttpClientRequest.post(`/api/session-webhooks/${h.webhook.id}`).pipe(
                HttpClientRequest.bodyText(body, "application/json"),
                HttpClientRequest.setHeaders({
                  "webhook-id": "evt_1",
                  "webhook-timestamp": timestamp,
                  "webhook-signature": signatureValid
                    ? `v1,${NodeCrypto.createHmac("sha256", secret).update(`evt_1.${timestamp}.${body}`).digest("base64")}`
                    : "v1,bad",
                }),
              );
              return (yield* client.execute(request)).status;
            });
          assert.strictEqual(yield* send(h.event(), false), 401);
          const event = h.event();
          assert.strictEqual(yield* send(event), 202);
          assert.strictEqual(yield* send(event), 202);
          assert.strictEqual(h.state.dispatches, 0);
          assert.strictEqual((yield* h.service.inspect(owner, h.webhook.id)).deliveries.length, 1);
          assert.strictEqual(
            yield* send({
              ...event,
              data: { ...event.data, model: "unsafe", sessionId: "other", accessMode: "auto" },
            }),
            400,
          );
          assert.strictEqual(
            yield* send({ ...event, data: { ...event.data, status_ref: "changed" } }),
            409,
          );
          assert.strictEqual(
            yield* send({ ...event, data: { ...event.data, overall_note: "x".repeat(70_000) } }),
            413,
          );
        }),
      ).pipe(Effect.provide(NodeHttpServer.layerTest)),
    ),
  );
  it.effect("returns an existing destination without revealing secrets", () =>
    scenario((h) =>
      Effect.gen(function* () {
        const reused = yield* h.service.create(owner, threadId);
        assert.strictEqual(reused.id, h.webhook.id);
        assert.strictEqual(h.state.registrations, 1);
        assert.strictEqual(encodeJson(reused).includes("whsec_"), false);
      }),
    ),
  );
});
