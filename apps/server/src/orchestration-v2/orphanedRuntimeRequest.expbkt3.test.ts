import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { isOrphanedRuntimeRequest, messageAnswerText } from "./orphanedRuntimeRequest.expbkt3.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for orphaned requests"),
} as ProviderAdapterV2Shape;
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "orphaned-requests" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const liveRequest = (status: OrchestrationV2RuntimeRequest["status"] = "pending") =>
  ({
    id: RuntimeRequestId.make("request"),
    nodeId: NodeId.make("node"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input",
    status,
    responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session") },
    createdAt: DateTime.makeUnsafe(0),
    resolvedAt: null,
  }) satisfies OrchestrationV2RuntimeRequest;

describe("isOrphanedRuntimeRequest", () => {
  it("is orphaned once its session is detached or its run has ended", () => {
    const request = liveRequest();
    assert.isTrue(isOrphanedRuntimeRequest({ request, sessionBound: false, runStatus: "running" }));
    assert.isTrue(isOrphanedRuntimeRequest({ request, sessionBound: true, runStatus: "failed" }));
    assert.isFalse(isOrphanedRuntimeRequest({ request, sessionBound: true, runStatus: "running" }));
    assert.isFalse(isOrphanedRuntimeRequest({ request, sessionBound: true, runStatus: undefined }));
  });

  it("leaves answered and message-mode requests alone", () => {
    assert.isFalse(
      isOrphanedRuntimeRequest({
        request: liveRequest("resolved"),
        sessionBound: false,
        runStatus: "failed",
      }),
    );
    assert.isFalse(
      isOrphanedRuntimeRequest({
        request: { ...liveRequest(), responseCapability: { type: "message" } },
        sessionBound: false,
        runStatus: "failed",
      }),
    );
  });
});

describe("messageAnswerText", () => {
  it("lists a multi-select answer's choices and keeps a text answer", () => {
    assert.equal(messageAnswerText([" Later ", "", "Now"]), "Later, Now");
    assert.isUndefined(messageAnswerText([]));
    assert.equal(messageAnswerText("Later"), "Later");
  });
});

it.effect("answers, dismisses and closes requests whose provider session is gone", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:orphaned-requests");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-orphaned"),
      threadId,
      projectId: ProjectId.make("project:orphaned-requests"),
      title: "Orphaned",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    // The session the requests name was never bound to the thread, as after a
    // failed run detaches it.
    const goneSession = ProviderSessionId.make("session:gone");
    let ordinal = 0;
    const seed = (name: string, kind: OrchestrationV2RuntimeRequest["kind"]) =>
      Effect.gen(function* () {
        const requestId = RuntimeRequestId.make(`request:${name}`);
        const nodeId = NodeId.make(`node:${name}`);
        yield* projections.apply({
          id: EventId.make(`request:${name}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind,
            status: "pending",
            responseCapability: { type: "live", providerSessionId: goneSession },
            createdAt: now,
            resolvedAt: null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`node:${name}`),
          type: "node.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: kind === "user_input" ? "user_input_request" : "approval_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        });
        if (kind === "user_input") {
          yield* projections.apply({
            id: EventId.make(`item:${name}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`item:${name}`),
              threadId,
              runId: null,
              nodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: ++ordinal,
              status: "waiting",
              title: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              type: "user_input_request",
              requestId,
              questions: [
                {
                  id: "next",
                  header: "TEC-1657",
                  question: "What should happen next?",
                  options: [
                    { label: "Later", description: "Change nothing now." },
                    { label: "Now", description: "Start now." },
                  ],
                },
              ],
            },
          });
        }
        return { requestId, nodeId };
      });

    // An answer is recorded and reaches the agent as the next message.
    const answered = yield* seed("answered", "user_input");
    yield* orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("respond-orphaned"),
      threadId,
      requestId: answered.requestId,
      answers: { next: "Later" },
    });
    const answeredRequest = yield* projections.getRuntimeRequest(threadId, answered.requestId);
    assert.equal(answeredRequest?.status, "resolved");
    assert.equal(answeredRequest?.responseCapability.type, "message");
    const { messages } = yield* projections.getThreadRecords(threadId, ["messages"]);
    assert.isTrue(
      messages.some(
        (message) => message.role === "user" && message.text === "What should happen next?\nLater",
      ),
    );

    // A dismissal closes the question without a reply.
    const dismissed = yield* seed("dismissed", "user_input");
    yield* orchestrator.dispatch({
      type: "thread.user-input.dismiss",
      commandId: CommandId.make("dismiss-orphaned"),
      threadId,
      requestId: dismissed.requestId,
    });
    const dismissedContext = yield* projections.getRuntimeResponseContext(
      threadId,
      dismissed.requestId,
    );
    assert.equal(dismissedContext.request?.status, "resolved");
    assert.equal(dismissedContext.node?.status, "cancelled");

    // An approval closes; no provider can act on its decision.
    const approval = yield* seed("approval", "command");
    yield* orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("approve-orphaned"),
      threadId,
      requestId: approval.requestId,
      decision: "accept",
    });
    assert.equal(
      (yield* projections.getRuntimeRequest(threadId, approval.requestId))?.status,
      "resolved",
    );
  }).pipe(Effect.provide(layerTest)),
);
