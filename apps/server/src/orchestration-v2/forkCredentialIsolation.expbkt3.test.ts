// T3-CUSTOM(expbkt3): retained BK behavior at the native V2 boundary.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  SourceControlProfileId,
  ThreadId,
  UserId,
  type OrchestrationV2ProviderSession,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CommandPolicy from "./CommandPolicy.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderSwitchService from "./ProviderSwitchService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadForkService from "./ThreadForkService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const owner = UserId.make("user:credentials-owner");
const member = UserId.make("user:credentials-member");
const threadId = ThreadId.make("thread:credential-isolation");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const sessionId = ProviderSessionId.make("session:credential-isolation");
const providerThreadId = ProviderThreadId.make("provider-thread:credential-isolation");
const runId = RunId.make("run:credential-isolation");
const attemptId = RunAttemptId.make("attempt:credential-isolation");
const nodeId = NodeId.make("node:credential-isolation");
const turnId = ProviderTurnId.make("turn:credential-isolation");
const modelSelection = { instanceId, model: "gpt-5.4" };

it.effect(
  "queues cross-person steers and async answers while preserving the active credential actor",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      let credentialActorUserId = owner;
      const session: OrchestrationV2ProviderSession = {
        id: sessionId,
        driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/repo",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const runtime = (): ProviderAdapterV2SessionRuntime => ({
        credentialActorUserId,
        credentialSourceControlProfileId: null,
        instanceId,
        driver,
        providerSessionId: sessionId,
        providerSession: session,
        events: Stream.empty,
        ensureThread: () => Effect.die("unused"),
        resumeThread: () => Effect.die("unused"),
        startTurn: () => Effect.die("unused"),
        steerTurn: () => Effect.die("unused"),
        interruptTurn: () => Effect.die("unused"),
        respondToRuntimeRequest: () => Effect.die("unused"),
        readThreadSnapshot: () => Effect.die("unused"),
        rollbackThread: () => Effect.die("unused"),
        forkThread: () => Effect.die("unused"),
      });
      const database = SqlitePersistenceMemory;
      const stores = Layer.mergeAll(
        EventStore.layer,
        ProjectionStore.layer,
        ProjectStore.layer,
        CommandReceiptStore.layer,
        EffectOutbox.layer,
        TurnItemPositionStore.layer,
      ).pipe(Layer.provide(database));
      const sink = EventSink.layerFromStores.pipe(Layer.provide(Layer.merge(stores, database)));
      const registry = ProviderAdapterRegistry.layerFromAdapters([
        {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: () => Effect.die("the command must only persist an outbox effect"),
        },
      ]);
      const dependencies = Layer.mergeAll(
        stores,
        sink,
        IdAllocator.layer,
        registry,
        CommandPolicy.layer,
        RuntimePolicy.layer,
        ThreadForkService.layer,
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(ProviderSwitchService.ProviderSwitchServiceV2)({}),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: () => Effect.succeed(Option.some(runtime())),
        }),
        Layer.mock(CheckpointService.CheckpointServiceV2)({
          ensureScope: (scope) => Effect.succeed(scope),
          prepareRootRunScope: (input) =>
            Effect.succeed({
              id: CheckpointScopeId.make(`scope:${input.runId}`),
              threadId: input.threadId,
              runId: input.runId,
              nodeId: input.rootNodeId,
              parentScopeId: null,
              providerThreadId: input.providerThreadId,
              kind: "root_run",
              ordinalWithinParent: 1,
              advancesAppRunCount: true,
              cwd: input.cwd,
              createdAt: input.createdAt,
            }),
        }),
        NodeServices.layer,
      );
      const layer = Orchestrator.layer.pipe(Layer.provideMerge(dependencies));
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        yield* orchestrator.dispatch(
          {
            type: "thread.create",
            commandId: CommandId.make("create:credential-isolation"),
            threadId,
            projectId: ProjectId.make("project:credential-isolation"),
            title: "Credentials",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
            memberUserIds: [member],
          },
          { actorUserId: owner },
        );
        const thread = yield* projections.getThread(threadId);
        yield* projections.apply({
          id: EventId.make("active:credential-isolation"),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: { ...thread, activeProviderThreadId: providerThreadId },
        });
        yield* projections.apply({
          id: EventId.make("session:credential-isolation"),
          type: "provider-session.attached",
          threadId,
          occurredAt: now,
          payload: session,
        });
        yield* projections.apply({
          id: EventId.make("provider-thread:credential-isolation"),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: sessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* projections.apply({
          id: EventId.make("run:credential-isolation"),
          type: "run.created",
          threadId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make("message:credential-isolation"),
            rootNodeId: nodeId,
            activeAttemptId: attemptId,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* projections.apply({
          id: EventId.make("attempt:credential-isolation"),
          type: "run-attempt.created",
          threadId,
          occurredAt: now,
          payload: {
            id: attemptId,
            runId,
            attemptOrdinal: 1,
            rootNodeId: nodeId,
            providerInstanceId: instanceId,
            providerThreadId,
            providerTurnId: turnId,
            reason: "initial",
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        });
        yield* projections.apply({
          id: EventId.make("turn:credential-isolation"),
          type: "provider-turn.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: turnId,
            providerThreadId,
            nodeId,
            runAttemptId: attemptId,
            nativeTurnRef: null,
            ordinal: 1,
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        });
        yield* projections.apply({
          id: EventId.make("node:credential-isolation"),
          type: "node.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId,
            providerTurnId: turnId,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        });
        for (const intent of ["explicit", "auto"] as const) {
          const commandId = CommandId.make(`cross-person:${intent}`);
          const messageId = MessageId.make(`cross-person:${intent}`);
          const command = {
            type: "message.dispatch" as const,
            commandId,
            threadId,
            messageId,
            text: "Use my account",
            attachments: [],
            createdBy: "user" as const,
            creationSource: "web" as const,
            dispatchMode: { type: "steer_active" as const, targetRunId: runId },
            ...(intent === "auto" ? { deliveryIntent: "auto" as const } : {}),
          };
          const first = yield* orchestrator.dispatch(command, { actorUserId: member });
          assert.equal(
            (yield* orchestrator.dispatch(command, { actorUserId: member })).sequence,
            first.sequence,
          );
          const projection = yield* projections.getThreadProjection(threadId);
          const message = projection.messages.find((candidate) => candidate.id === messageId);
          assert.equal(message?.sentByUserId, member);
          assert.equal(
            projection.runs.find((candidate) => candidate.id === message?.runId)?.status,
            "queued",
          );
          assert.isFalse(
            (yield* outbox.listByCommandId(commandId)).some(
              (effect) => effect.request.type === "provider-turn.steer",
            ),
          );
          assert.equal(
            projection.runs.find((candidate) => candidate.id === runId)?.status,
            "running",
          );
        }
        yield* orchestrator.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("question:credential-isolation"),
          threadId,
          activity: {
            id: EventId.make("question:credential-isolation"),
            kind: "user-input.requested",
            tone: "approval",
            summary: "Choose",
            turnId: null,
            createdAt: DateTime.formatIso(now),
            payload: {
              requestId: "question:credential-isolation",
              responseMode: "message",
              questions: [
                {
                  id: "choice",
                  header: "Choice",
                  question: "Which account?",
                  options: [],
                  allowCustomAnswer: true,
                },
              ],
            },
          },
        });
        const answerId = CommandId.make("answer:credential-isolation");
        yield* orchestrator.dispatch(
          {
            type: "runtime-request.respond",
            commandId: answerId,
            threadId,
            requestId: RuntimeRequestId.make("question:credential-isolation"),
            answers: { choice: "Mine" },
          },
          { actorUserId: member },
        );
        assert.isFalse(
          (yield* outbox.listByCommandId(answerId)).some(
            (effect) => effect.request.type === "provider-turn.steer",
          ),
        );
        const answerProjection = yield* projections.getThreadProjection(threadId);
        const answer = answerProjection.messages.find(
          (message) => message.id === "async-answer:question:credential-isolation",
        );
        assert.equal(answer?.sentByUserId, member);
        assert.equal(
          answerProjection.runs.find((run) => run.id === answer?.runId)?.status,
          "queued",
        );
        credentialActorUserId = member;
        const sameActorCommand = CommandId.make("same-runtime-actor:credential-isolation");
        yield* orchestrator.dispatch(
          {
            type: "message.dispatch",
            commandId: sameActorCommand,
            threadId,
            messageId: MessageId.make("same-runtime-actor:credential-isolation"),
            text: "Keep this account",
            attachments: [],
            dispatchMode: { type: "steer_active", targetRunId: runId },
            createdBy: "user",
            creationSource: "web",
          },
          { actorUserId: member },
        );
        assert.isTrue(
          (yield* outbox.listByCommandId(sameActorCommand)).some(
            (effect) => effect.request.type === "provider-turn.steer",
          ),
        );
        assert.equal((yield* projections.getThread(threadId)).ownerUserId, owner);
        const changedProfileThread = yield* projections.getThread(threadId);
        yield* projections.apply({
          id: EventId.make("profile:credential-isolation"),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: {
            ...changedProfileThread,
            sourceControlProfileId: SourceControlProfileId.make("profile-member"),
          },
        });
        const changedProfileCommand = CommandId.make("changed-profile:credential-isolation");
        const changedProfileMessageId = MessageId.make("changed-profile:credential-isolation");
        yield* orchestrator.dispatch(
          {
            type: "message.dispatch",
            commandId: changedProfileCommand,
            threadId,
            messageId: changedProfileMessageId,
            text: "Use the selected Git profile",
            attachments: [],
            dispatchMode: { type: "steer_active", targetRunId: runId },
            createdBy: "user",
            creationSource: "web",
          },
          { actorUserId: member },
        );
        const changedProfileProjection = yield* projections.getThreadProjection(threadId);
        const changedProfileMessage = changedProfileProjection.messages.find(
          (message) => message.id === changedProfileMessageId,
        );
        assert.equal(
          changedProfileProjection.runs.find((run) => run.id === changedProfileMessage?.runId)
            ?.status,
          "queued",
        );
        assert.isFalse(
          (yield* outbox.listByCommandId(changedProfileCommand)).some(
            (effect) => effect.request.type === "provider-turn.steer",
          ),
        );
      }).pipe(Effect.provide(layer));
    }),
);
