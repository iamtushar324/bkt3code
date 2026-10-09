// T3-CUSTOM(expbkt3): XFN-59 — the shell counts running provider-native subagents for the sidebar.
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  activeSubagentCountShellField,
  countActiveProviderNativeSubagents,
} from "./activeSubagentCount.expbkt3.ts";

const now = DateTime.makeUnsafe("2026-10-09T00:00:00.000Z");
const threadId = ThreadId.make("thread:xfn59");
const runId = RunId.make("run:xfn59");
const rolledBackRunId = RunId.make("run:xfn59:rolled-back");
const driver = ProviderDriverKind.make("claudeAgent");
const providerInstanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "claude-opus",
} satisfies ModelSelection;

type RunRow = Pick<OrchestrationV2Run, "id" | "ordinal" | "status">;
const runningRun: RunRow = { id: runId, ordinal: 1, status: "running" };

function subagentItem(input: {
  readonly id: string;
  readonly subagentId?: string;
  readonly status?: OrchestrationV2TurnItem["status"];
  readonly origin?: "provider_native" | "app_owned";
  readonly runId?: RunId | null;
}): OrchestrationV2TurnItem {
  const subagentId = NodeId.make(input.subagentId ?? `node:${input.id}`);
  return {
    id: TurnItemId.make(input.id),
    threadId,
    runId: input.runId === undefined ? runId : input.runId,
    nodeId: subagentId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: input.status ?? "running",
    title: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "subagent",
    subagentId,
    origin: input.origin ?? "provider_native",
    driver,
    providerInstanceId,
    childThreadId: null,
    prompt: "Explore the repository",
    result: null,
  };
}

describe("countActiveProviderNativeSubagents", () => {
  it("counts a running provider-native subagent during a running turn", () => {
    assert.equal(
      countActiveProviderNativeSubagents({
        turnItems: [subagentItem({ id: "item:a" })],
        runs: [runningRun],
      }),
      1,
    );
  });

  it("counts pending and waiting subagents as active", () => {
    assert.equal(
      countActiveProviderNativeSubagents({
        turnItems: [
          subagentItem({ id: "item:pending", status: "pending" }),
          subagentItem({ id: "item:waiting", status: "waiting" }),
        ],
        runs: [runningRun],
      }),
      2,
    );
  });

  it("does not count finished subagents", () => {
    const finished = (["completed", "failed", "interrupted", "cancelled", "idle"] as const).map(
      (status) => subagentItem({ id: `item:${status}`, status }),
    );
    assert.equal(
      countActiveProviderNativeSubagents({ turnItems: finished, runs: [runningRun] }),
      0,
    );
  });

  it("does not count subagents of a rolled-back run", () => {
    assert.equal(
      countActiveProviderNativeSubagents({
        turnItems: [
          subagentItem({ id: "item:abandoned", runId: rolledBackRunId }),
          subagentItem({ id: "item:live" }),
        ],
        runs: [runningRun, { id: rolledBackRunId, ordinal: 2, status: "rolled_back" }],
      }),
      1,
    );
  });

  it("counts a subagent once when several items carry its id", () => {
    assert.equal(
      countActiveProviderNativeSubagents({
        turnItems: [
          subagentItem({ id: "item:first", subagentId: "node:same" }),
          subagentItem({ id: "item:second", subagentId: "node:same" }),
          subagentItem({ id: "item:other", subagentId: "node:other" }),
        ],
        runs: [runningRun],
      }),
      2,
    );
  });

  it("leaves out delegate_task children and other background work", () => {
    const command: OrchestrationV2TurnItem = {
      id: TurnItemId.make("item:command"),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: "long command",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution",
      input: "sleep 100",
    };
    assert.equal(
      countActiveProviderNativeSubagents({
        turnItems: [subagentItem({ id: "item:delegated", origin: "app_owned" }), command],
        runs: [runningRun],
      }),
      0,
    );
  });

  it("keeps counting after the run settles while the subagent still runs", () => {
    assert.equal(
      countActiveProviderNativeSubagents({
        turnItems: [subagentItem({ id: "item:background" })],
        runs: [{ id: runId, ordinal: 1, status: "completed" }],
      }),
      1,
    );
  });
});

describe("activeSubagentCountShellField", () => {
  it("omits the field when nothing runs, so existing shells keep their shape", () => {
    assert.deepEqual(activeSubagentCountShellField(0), {});
    assert.deepEqual(activeSubagentCountShellField(undefined), {});
  });

  it("sets the field when subagents run", () => {
    assert.deepEqual(activeSubagentCountShellField(3), { activeSubagentCount: 3 });
  });
});

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);

it.layer(layerTest)("ProjectionStoreV2 active subagent count", (it) => {
  it.effect("reports the same count on the memory and SQL shell paths", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const rootNodeId = NodeId.make("node:xfn59:root");
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:xfn59"),
        rootNodeId,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:xfn59:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:xfn59"),
          title: "Subagent counter",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:xfn59:run"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: run,
      });
      const items = [
        subagentItem({ id: "item:xfn59:native-a" }),
        subagentItem({ id: "item:xfn59:native-b", status: "waiting" }),
        subagentItem({ id: "item:xfn59:native-done", status: "completed" }),
        subagentItem({ id: "item:xfn59:delegated", origin: "app_owned" }),
      ];
      for (const item of items) {
        yield* projectionStore.apply({
          id: EventId.make(`event:xfn59:${item.id}`),
          type: "turn-item.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          driver,
          occurredAt: now,
          payload: item,
        });
      }

      // Memory projection, SQL snapshot and SQL single-thread read.
      const readShells = Effect.gen(function* () {
        const projection = yield* projectionStore.getThreadProjection(threadId);
        const snapshotShell = (yield* projectionStore.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        );
        const singleShell = yield* projectionStore.getThreadShell(threadId);
        return [ProjectionStore.threadShellFromProjection(projection), snapshotShell, singleShell];
      });

      for (const shell of yield* readShells) {
        assert.equal(shell?.activeSubagentCount, 2);
      }

      yield* projectionStore.apply({
        id: EventId.make("event:xfn59:rolled-back"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: { ...run, status: "rolled_back", completedAt: now },
      });

      for (const shell of yield* readShells) {
        assert.isOk(shell);
        assert.isUndefined(shell?.activeSubagentCount);
      }
    }),
  );
});
