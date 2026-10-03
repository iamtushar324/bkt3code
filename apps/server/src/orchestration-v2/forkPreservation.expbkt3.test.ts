// T3-CUSTOM(expbkt3): retained BK behavior at the native V2 boundary.
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { CurrentOrchestrationActorUserId } from "./forkActor.expbkt3.ts";
import { makeLayer } from "./ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { legacyActivities } from "./legacyProjection.expbkt3.ts";
import { legacyActivityItem } from "./ForkLegacyHistory.expbkt3.ts";
import { forkHasPendingAsyncUserInput } from "./forkAsyncInput.expbkt3.ts";

const actor = UserId.make("user:owner");
const member = UserId.make("user:member");
const providerInstanceId = ProviderInstanceId.make("codex");
const registry = makeLayer([
  {
    instanceId: providerInstanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Provider execution is outside this test."),
  },
]);
const TestLayer = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "fork-preservation" },
  registry,
  { runEffectWorker: false },
);

it.layer(TestLayer)("fork native dispatch", (it) => {
  it.effect(
    "retains authenticated owners, child members, metadata and rejected owner removals",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const parentId = ThreadId.make("fork:parent");
        const childId = ThreadId.make("fork:child");
        const create = (threadId: ThreadId) => ({
          type: "thread.create" as const,
          commandId: CommandId.make(`create:${threadId}`),
          createdBy: "user" as const,
          creationSource: "web" as const,
          threadId,
          projectId: ProjectId.make("project:fork"),
          title: "Fork session",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: null,
          worktreePath: null,
        });
        yield* orchestrator
          .dispatch({
            ...create(parentId),
            ownerUserId: UserId.make("untrusted:hint"),
            memberUserIds: [member],
            priority: 1,
            customGroup: "custom",
          })
          .pipe(Effect.provideService(CurrentOrchestrationActorUserId, actor));
        yield* orchestrator.dispatch({
          ...create(childId),
          parentThreadId: parentId,
          createdBy: "agent",
          creationSource: "mcp",
        });
        const parent = yield* orchestrator.getThreadShell(parentId);
        const child = yield* orchestrator.getThreadShell(childId);
        assert.equal(parent?.ownerUserId, actor);
        assert.equal(child?.ownerUserId, actor);
        assert.include(child?.memberUserIds ?? [], member);
        assert.equal(parent?.priority, 1);
        assert.equal(parent?.customGroup, "custom");
        const ownershipCommand = {
          type: "thread.owner.transfer" as const,
          commandId: CommandId.make("transfer:fork"),
          threadId: parentId,
          userId: member,
        };
        const first = yield* orchestrator.dispatch(ownershipCommand, { actorUserId: actor });
        const second = yield* orchestrator.dispatch(ownershipCommand, { actorUserId: actor });
        assert.equal(first.sequence, second.sequence);
        const transferred = yield* orchestrator.getThreadShell(parentId);
        assert.equal(transferred?.ownerUserId, member);
        const rejected = yield* orchestrator
          .dispatch({
            type: "thread.member.remove",
            commandId: CommandId.make("remove:owner"),
            threadId: parentId,
            userId: member,
          })
          .pipe(Effect.result);
        assert.equal(rejected._tag, "Failure");
      }),
  );
  it.effect(
    "commits async activities through native receipts and retains exact agent UI handles",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const threadId = ThreadId.make("fork:activity");
        yield* orchestrator.dispatch(
          {
            type: "thread.create",
            commandId: CommandId.make("create:activity"),
            createdBy: "user",
            creationSource: "web",
            threadId,
            projectId: ProjectId.make("project:fork"),
            title: "Activity",
            modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
          { actorUserId: actor },
        );
        const activity = {
          id: EventId.make("activity:question"),
          kind: "user-input.requested",
          tone: "info" as const,
          summary: "Choose a path",
          payload: { requestId: "question:1", responseMode: "message", t3Ui: { id: "ui:1" } },
          turnId: null,
          createdAt: "2026-10-03T10:00:00Z",
        };
        const command = {
          type: "thread.activity.append" as const,
          commandId: CommandId.make("append:activity"),
          threadId,
          activity,
        };
        const first = yield* orchestrator.dispatch(command, { actorUserId: actor });
        const second = yield* orchestrator.dispatch(command, { actorUserId: actor });
        assert.equal(first.sequence, second.sequence);
        const shell = yield* orchestrator.getThreadShell(threadId);
        assert.equal(shell?.hasPendingAsyncUserInput, true);
        assert.equal(shell?.pendingRuntimeRequest, null);
        const item = legacyActivityItem(threadId, activity, 1);
        assert.deepStrictEqual(
          legacyActivities({ turnItems: [item] })[0]?.payload,
          activity.payload,
        );
        assert.equal(forkHasPendingAsyncUserInput([item]), true);
        const resolved = legacyActivityItem(
          threadId,
          {
            ...activity,
            id: EventId.make("activity:answer"),
            kind: "user-input.resolved",
            payload: { requestId: "question:1" },
          },
          2,
        );
        assert.equal(forkHasPendingAsyncUserInput([item, resolved]), false);
      }),
  );
  it.effect(
    "answers and dismisses fork questions through native commands with one durable receipt",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const threadId = ThreadId.make("fork:answer");
        yield* orchestrator.dispatch(
          {
            type: "thread.create",
            commandId: CommandId.make("create:answer"),
            createdBy: "user",
            creationSource: "web",
            threadId,
            projectId: ProjectId.make("project:fork"),
            title: "Answer",
            modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
          { actorUserId: actor },
        );
        const appendQuestion = (id: string) =>
          orchestrator.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`append:${id}`),
            threadId,
            activity: {
              id: EventId.make(`activity:${id}`),
              kind: "user-input.requested",
              tone: "approval",
              summary: "Select the path",
              turnId: null,
              createdAt: "2026-10-03T10:00:00Z",
              payload: {
                requestId: id,
                responseMode: "message",
                questions: [
                  {
                    id: "path",
                    header: "Path",
                    question: "Which path?",
                    options: [],
                    allowCustomAnswer: true,
                  },
                ],
              },
            },
          });
        yield* appendQuestion("question:answer");
        const invalid = yield* orchestrator
          .dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make("invalid:answer"),
            threadId,
            requestId: RuntimeRequestId.make("question:answer"),
            answers: { path: "" },
          })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure");
        assert.equal(
          (yield* orchestrator.getThreadShell(threadId))?.hasPendingAsyncUserInput,
          true,
        );
        const command = {
          type: "runtime-request.respond" as const,
          commandId: CommandId.make("respond:answer"),
          threadId,
          requestId: RuntimeRequestId.make("question:answer"),
          answers: { path: " Keep the fork " },
        };
        const first = yield* orchestrator.dispatch(command, { actorUserId: actor });
        const replay = yield* orchestrator.dispatch(command, { actorUserId: actor });
        assert.equal(first.sequence, replay.sequence);
        const answered = yield* orchestrator.getThreadRecords(threadId, ["messages", "turnItems"]);
        assert.equal(answered.messages.length, 1);
        assert.equal(answered.messages[0]?.text, "Which path?\nKeep the fork");
        assert.equal(answered.messages[0]?.sentByUserId, actor);
        assert.equal(
          (yield* orchestrator.getThreadShell(threadId))?.hasPendingAsyncUserInput,
          false,
        );
        assert.equal(
          legacyActivities(answered).find(
            (activity) => activity.id === "async-answer:question:answer",
          )?.kind,
          "user-input.resolved",
        );
        yield* appendQuestion("question:dismiss");
        yield* orchestrator.dispatch({
          type: "thread.user-input.dismiss",
          commandId: CommandId.make("dismiss:answer"),
          threadId,
          requestId: RuntimeRequestId.make("question:dismiss"),
        });
        assert.equal(
          (yield* orchestrator.getThreadShell(threadId))?.hasPendingAsyncUserInput,
          false,
        );
        assert.equal(
          (yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages.length,
          1,
        );
      }),
  );
});
