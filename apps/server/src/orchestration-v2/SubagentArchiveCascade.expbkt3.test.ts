// T3-CUSTOM(expbkt3): provider-native subagents follow their parent into and out of the archive.
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2StoredEvent,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import * as SubagentArchiveCascade from "./SubagentArchiveCascade.expbkt3.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const layerTest = layerWithRegistry(
  { name: "SubagentArchiveCascade.expbkt3.test.ts" },
  Layer.mock(ProviderAdapterRegistryV2)({
    get: () => Effect.die("Provider execution is outside this test."),
    list: () => Effect.succeed([ProviderInstanceId.make("codex")]),
  }),
  { runEffectWorker: false, databaseLayer: SqlitePersistence.layerMemory },
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const projectId = ProjectId.make("project:subagent-archive-cascade");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const makeThread = (
  id: string,
  now: DateTime.Utc,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => {
  const threadId = ThreadId.make(id);
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: id,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
};

/** A child as each creator records it: a provider's native subagent, delegate_task, or a fork. */
const makeChild = (
  kind: "provider-subagent" | "delegated" | "fork",
  parentThreadId: ThreadId,
  id: string,
  now: DateTime.Utc,
  overrides: Partial<OrchestrationV2AppThread> = {},
) =>
  makeThread(id, now, {
    createdBy: kind === "fork" ? "user" : "agent",
    creationSource:
      kind === "provider-subagent" ? "provider" : kind === "delegated" ? "mcp" : "web",
    lineage: {
      parentThreadId,
      relationshipToParent: kind === "fork" ? "fork" : "subagent",
      rootThreadId: parentThreadId,
    },
    forkedFrom: kind === "fork" ? null : { type: "node", nodeId: NodeId.make(`node:${id}`) },
    ...overrides,
  });

const seed = (threads: ReadonlyArray<OrchestrationV2AppThread>) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSinkV2;
    yield* eventSink.write({
      events: threads.map((thread) => ({
        id: EventId.make(`event:${thread.id}:created`),
        type: "thread.created" as const,
        threadId: thread.id,
        occurredAt: thread.createdAt,
        payload: thread,
      })),
    });
  });

const seedRunningRun = (threadId: ThreadId, now: DateTime.Utc) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSinkV2;
    const runId = RunId.make(`run:${threadId}:1`);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`event:${runId}:created`),
          type: "run.created",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make(`message:${runId}`),
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
  });

/** The next stored event of this type on the thread, even one that lands before the read subscribes. */
const nextEvent = (threadId: ThreadId, eventType: "thread.archived" | "thread.unarchived") =>
  Effect.gen(function* () {
    const eventSink = yield* EventSinkV2;
    const afterSequence = yield* eventSink.latestSequence();
    return yield* eventSink
      .stream({ threadId, afterSequence, eventType })
      .pipe(Stream.runHead, Effect.forkChild);
  });

const commandIdOf = (stored: Option.Option<OrchestrationV2StoredEvent>) =>
  String(Option.getOrNull(Option.map(stored, (event) => event.commandId)));

const isArchived = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const shell = yield* orchestrator.getThreadShell(threadId);
    return shell !== null && shell.archivedAt !== null;
  });

it.effect(
  "archiving a parent archives its provider subagents, not its delegated tasks, forks or other threads",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const now = yield* DateTime.now;
        const parent = makeThread("thread:parent", now);
        const other = makeThread("thread:other", now);
        const subagent = makeChild("provider-subagent", parent.id, "thread:parent:subagent", now);
        const delegated = makeChild("delegated", parent.id, "thread:parent:delegated", now);
        const fork = makeChild("fork", parent.id, "thread:parent:fork", now);
        const otherSubagent = makeChild(
          "provider-subagent",
          other.id,
          "thread:other:subagent",
          now,
        );
        yield* seed([parent, other, subagent, delegated, fork, otherSubagent]);

        const cascade = yield* SubagentArchiveCascade.make;
        yield* cascade.start();
        // Every parent is active, so the startup pass archives nothing.
        yield* cascade.drain;
        assert.isFalse(yield* isArchived(subagent.id));

        const subagentArchived = yield* nextEvent(subagent.id, "thread.archived");
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("command:archive-parent"),
          threadId: parent.id,
        });
        const stored = yield* Fiber.join(subagentArchived);
        yield* cascade.drain;

        assert.isTrue(commandIdOf(stored).startsWith("server:subagent-archive-cascade:"));
        assert.isTrue(yield* isArchived(parent.id));
        assert.isTrue(yield* isArchived(subagent.id));
        assert.isFalse(yield* isArchived(delegated.id));
        assert.isFalse(yield* isArchived(fork.id));
        assert.isFalse(yield* isArchived(other.id));
        assert.isFalse(yield* isArchived(otherSubagent.id));
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect("deleting a parent archives its provider subagents", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const parent = makeThread("thread:deleted-parent", now);
      const subagent = makeChild(
        "provider-subagent",
        parent.id,
        "thread:deleted-parent:subagent",
        now,
      );
      yield* seed([parent, subagent]);

      const cascade = yield* SubagentArchiveCascade.make;
      yield* cascade.start();
      yield* cascade.drain;

      const subagentArchived = yield* nextEvent(subagent.id, "thread.archived");
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("command:delete-parent"),
        threadId: parent.id,
      });
      const stored = yield* Fiber.join(subagentArchived);
      yield* cascade.drain;

      assert.isTrue(commandIdOf(stored).startsWith("server:subagent-archive-cascade:"));
      assert.isNull(yield* orchestrator.getThreadShell(parent.id));
      assert.isTrue(yield* isArchived(subagent.id));
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("unarchiving the parent unarchives its provider subagents and nothing else", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const parent = makeThread("thread:round-trip", now);
      const subagent = makeChild("provider-subagent", parent.id, "thread:round-trip:subagent", now);
      // Archived by the user before the parent was, so the parent's unarchive must not restore it.
      const delegated = makeChild("delegated", parent.id, "thread:round-trip:delegated", now, {
        archivedAt: now,
      });
      yield* seed([parent, subagent, delegated]);

      const cascade = yield* SubagentArchiveCascade.make;
      yield* cascade.start();
      yield* cascade.drain;

      const subagentArchived = yield* nextEvent(subagent.id, "thread.archived");
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("command:archive-round-trip"),
        threadId: parent.id,
      });
      yield* Fiber.join(subagentArchived);
      yield* cascade.drain;
      assert.isTrue(yield* isArchived(subagent.id));

      const subagentUnarchived = yield* nextEvent(subagent.id, "thread.unarchived");
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("command:unarchive-round-trip"),
        threadId: parent.id,
      });
      const stored = yield* Fiber.join(subagentUnarchived);
      yield* cascade.drain;

      assert.isTrue(commandIdOf(stored).startsWith("server:subagent-unarchive-cascade:"));
      assert.isFalse(yield* isArchived(parent.id));
      assert.isFalse(yield* isArchived(subagent.id));
      assert.isTrue(yield* isArchived(delegated.id));
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect(
  "the startup pass archives subagents whose parent is archived, deleted or gone, and only those",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const archivedParent = makeThread("thread:archived-parent", now, { archivedAt: now });
        const deletedParent = makeThread("thread:gone-parent", now, { deletedAt: now });
        const activeParent = makeThread("thread:active-parent", now);
        const ofArchived = makeChild(
          "provider-subagent",
          archivedParent.id,
          "thread:archived-parent:subagent",
          now,
        );
        const ofDeleted = makeChild(
          "provider-subagent",
          deletedParent.id,
          "thread:gone-parent:subagent",
          now,
        );
        const ofMissing = makeChild(
          "provider-subagent",
          ThreadId.make("thread:never-recorded"),
          "thread:never-recorded:subagent",
          now,
        );
        const stillRunning = makeChild(
          "provider-subagent",
          archivedParent.id,
          "thread:archived-parent:running-subagent",
          now,
        );
        const delegated = makeChild(
          "delegated",
          archivedParent.id,
          "thread:archived-parent:delegated",
          now,
        );
        const ofActive = makeChild(
          "provider-subagent",
          activeParent.id,
          "thread:active-parent:subagent",
          now,
        );
        yield* seed([
          archivedParent,
          deletedParent,
          activeParent,
          ofArchived,
          ofDeleted,
          ofMissing,
          stillRunning,
          delegated,
          ofActive,
        ]);
        yield* seedRunningRun(stillRunning.id, now);

        const cascade = yield* SubagentArchiveCascade.make;
        yield* cascade.start();
        yield* cascade.drain;

        assert.isTrue(yield* isArchived(ofArchived.id));
        assert.isTrue(yield* isArchived(ofDeleted.id));
        assert.isTrue(yield* isArchived(ofMissing.id));
        assert.isFalse(yield* isArchived(stillRunning.id));
        assert.isFalse(yield* isArchived(delegated.id));
        assert.isFalse(yield* isArchived(ofActive.id));
        assert.isFalse(yield* isArchived(activeParent.id));
      }),
    ).pipe(Effect.provide(layerTest)),
);
