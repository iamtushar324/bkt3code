/** T3-CUSTOM(expbkt3): webhook admission shares the native thread lock and command receipt transaction. */
import { it, assert } from "@effect/vitest";
import {
  CommandId,
  EnvironmentUserId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  UserId,
  SessionWebhookError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { EnvironmentUserRepository } from "../persistence/EnvironmentUsers.ts";
import { OrchestrationAccessControl } from "../orchestration-v2/Services/AccessControl.ts";
import { ToolyardIntegration } from "../toolyard/ToolyardIntegration.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { planProjectCommand } from "../orchestration-v2/ProjectCommands.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  callbackCommandId,
  callbackFingerprint,
  decisionNotification,
  parseDecisionCallback,
  receiverTrustBinding,
} from "./protocol.ts";
const owner = UserId.make("user_owner");
const threadId = ThreadId.make("webhook-native");
const webhookId = "swh_11111111111111111111111111111111";
const binding = {
  instanceId: "instance_1",
  environmentId: "env_1",
  origin: "https://toolyard.example",
  callbackOrigin: "https://t3.example",
  enabled: true as const,
  trustGeneration: 0,
};
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };
const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("test must not start provider"),
} as ProviderAdapterV2Shape;
const access = Layer.mock(OrchestrationAccessControl)({
  actorFor: () => Option.some(owner),
  canAccessThread: () => Effect.succeed(true),
  canAccessProject: () => Effect.succeed(true),
});
const integration = Layer.mock(ToolyardIntegration)({
  instanceBinding: Effect.succeed(binding),
  callbackBinding: () => Effect.succeed(binding),
  assertConnectionOwner: () => Effect.void,
  isLocalOwner: () => Effect.succeed(false),
});
const users = Layer.mock(EnvironmentUserRepository)({
  get: () =>
    Effect.succeed(
      Option.some({
        userId: EnvironmentUserId.make(owner),
        status: "active",
        role: "member",
        displayName: "Owner",
        primaryEmail: null,
        avatarUrl: null,
        firstSeenAt: DateTime.nowUnsafe(),
        lastSeenAt: DateTime.nowUnsafe(),
      }),
    ),
});
const native = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "session-webhook-native" },
  ProviderAdapterRegistry.makeLayer([adapter]),
  { databaseLayer: SqlitePersistenceMemory, runEffectWorker: false },
).pipe(Layer.provide(Layer.mergeAll(access, integration, users)));
const services = Layer.mergeAll(native, ProjectionStore.layer, CommandReceiptStore.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isSessionWebhookError = Schema.is(SessionWebhookError);

it.effect("uses one native receipt and preserves retries after busy admission", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const orchestrator = yield* OrchestratorV2;
    const events = yield* EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const now = yield* DateTime.now;
    const projectId = ProjectId.make("webhook-project");
    const projectCommand = {
      type: "project.create" as const,
      commandId: CommandId.make("project-create"),
      projectId,
      title: "Project",
      workspaceRoot: process.cwd(),
      actorUserId: owner,
    };
    yield* events.commitProjectCommand({
      commandId: projectCommand.commandId,
      projectId,
      commandType: projectCommand.type,
      acceptedAt: now,
      event: Result.getOrThrow(
        planProjectCommand({
          command: projectCommand,
          state: { project: undefined, workspaceOwner: undefined },
          eventId: EventId.make("project-created"),
          now,
        }),
      ),
    });
    yield* orchestrator.dispatch(
      {
        type: "thread.create",
        commandId: CommandId.make("create-thread"),
        threadId,
        projectId,
        title: "Webhook",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      },
      { actorUserId: owner },
    );
    yield* sql`INSERT INTO session_webhooks(id,owner_user_id,thread_id,instance_id,trust_binding,status,created_at,updated_at) VALUES(${webhookId},${owner},${threadId},${binding.instanceId},${receiverTrustBinding(binding)},'active','2026-10-04','2026-10-04')`;
    const command = (eventId: string) =>
      Effect.gen(function* () {
        const payload = encodeJson({
          type: "inbox.decision",
          event_id: eventId,
          timestamp: "2026-10-04T12:00:00Z",
          data: {
            inbox_id: "in_1",
            decision_revision: 2,
            status: "decided",
            calls: [],
            status_ref: "in_1",
          },
        });
        const commandId = CommandId.make(callbackCommandId(webhookId, eventId));
        yield* sql`INSERT INTO session_webhook_events(webhook_id,event_id,fingerprint,payload,command_id,state,received_at,updated_at) VALUES(${webhookId},${eventId},${callbackFingerprint(payload)},${payload},${commandId},'queued','2026-10-04','2026-10-04')`;
        return {
          type: "message.dispatch" as const,
          commandId,
          threadId,
          messageId: MessageId.make(`${commandId}:message`),
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
          text: decisionNotification(parseDecisionCallback(payload, eventId)),
          attachments: [],
          dispatchMode: { type: "start_immediately" as const },
        };
      });
    const first = yield* command("evt_first");
    const results = yield* Effect.all(
      [
        orchestrator.dispatch(first, { actorUserId: owner, sessionWebhookId: webhookId }),
        orchestrator.dispatch(first, { actorUserId: owner, sessionWebhookId: webhookId }),
      ],
      { concurrency: 2 },
    );
    assert.strictEqual(results[0]?.sequence, results[1]?.sequence);
    const records = yield* projections.getThreadRecords(threadId, ["runs", "messages"]);
    assert.strictEqual(records.runs.length, 1);
    assert.strictEqual(records.messages.filter((message) => message.role === "user").length, 1);
    const second = yield* command("evt_second");
    yield* orchestrator
      .dispatch({ ...second, modelSelection }, { actorUserId: owner, sessionWebhookId: webhookId })
      .pipe(Effect.flip);
    assert.strictEqual(Option.isNone(yield* receipts.getByCommandId(second.commandId)), true);
    yield* orchestrator
      .dispatch(second, { actorUserId: owner, sessionWebhookId: webhookId })
      .pipe(Effect.flip);
    assert.strictEqual(Option.isNone(yield* receipts.getByCommandId(second.commandId)), true);
    const run = records.runs[0]!;
    yield* events.write({
      events: [
        {
          id: EventId.make("run-completed"),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        },
      ],
    });
    yield* orchestrator.dispatch(second, { actorUserId: owner, sessionWebhookId: webhookId });
    assert.strictEqual(Option.isSome(yield* receipts.getByCommandId(second.commandId)), true);
    assert.strictEqual((yield* projections.getThreadRecords(threadId, ["runs"])).runs.length, 2);
    const stale = yield* command("evt_stale_generation");
    binding.trustGeneration = 1;
    const rejected = yield* orchestrator
      .dispatch(stale, { actorUserId: owner, sessionWebhookId: webhookId })
      .pipe(Effect.flip);
    assert.strictEqual(isSessionWebhookError(rejected.cause), true);
    assert.strictEqual(
      isSessionWebhookError(rejected.cause) ? rejected.cause.detail : null,
      "integration-disabled-or-replaced",
    );
    assert.strictEqual(Option.isNone(yield* receipts.getByCommandId(stale.commandId)), true);
    assert.strictEqual((yield* projections.getThreadRecords(threadId, ["runs"])).runs.length, 2);
  }).pipe(Effect.provide(services)),
);
