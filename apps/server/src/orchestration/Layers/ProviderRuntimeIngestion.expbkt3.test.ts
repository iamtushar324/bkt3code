// T3-CUSTOM(expbkt3): fork coverage for provider runtime ingestion.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";

const threadId = ThreadId.make("thread-1");
const createdAt = "2026-01-01T00:00:00.000Z";

const makeProviderService = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<{
    readonly events: ReadonlyArray<ProviderRuntimeEvent>;
    readonly enqueued: Deferred.Deferred<void>;
  }>();
  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    compactThread: () => unsupported(),
    interruptTurn: () => unsupported(),
    inspectSession: () => Effect.succeed(null),
    requestTurnInterrupt: () => unsupported(),
    terminateSession: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () =>
      Effect.succeed({
        sessionModelSwitch: "in-session",
        activeTurnInput: "steer",
        durableResume: "supported",
      }),
    assertConversationRollbackSupported: () => unsupported(),
    getInstanceInfo: (instanceId) => {
      const driverKind = ProviderDriverKind.make(String(instanceId));
      return Effect.succeed({
        instanceId,
        driverKind,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind,
          continuationKey: `${driverKind}:instance:${instanceId}`,
        },
      });
    },
    rollbackConversation: () => unsupported(),
    uploadFeedback: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(pubsub).pipe(
        Stream.flatMap(({ events, enqueued }) =>
          Stream.concat(
            Stream.fromIterable(events),
            Stream.fromEffect(Deferred.succeed(enqueued, undefined)).pipe(Stream.drain),
          ),
        ),
      );
    },
  };
  const emitAndWaitForEnqueue = Effect.fnUntraced(function* (
    events: ReadonlyArray<ProviderRuntimeEvent>,
  ) {
    const enqueued = yield* Deferred.make<void>();
    yield* PubSub.publish(pubsub, { events, enqueued });
    yield* Deferred.await(enqueued);
  });
  return { service, emitAndWaitForEnqueue };
});

const makeLayer = (providerService: ProviderServiceShape) => {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );
  return ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(
      OrchestrationProjectionSnapshotQueryLive.pipe(
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
      ),
    ),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
    Layer.provideMerge(ServerSettingsService.layerTest({})),
    Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  );
};

/** Runs `body` against a fresh in-memory engine with ingestion started and one seeded thread. */
const withHarness = <A, E>(
  body: (harness: {
    readonly stateChanged: (
      state: "running" | "ready" | "error",
      reason?: string,
    ) => ProviderRuntimeEvent;
    readonly emitAndDrain: (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void>;
    readonly sessionSetEvents: Effect.Effect<ReadonlyArray<OrchestrationEvent>>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const provider = yield* makeProviderService;
    const workspaceRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-dedupe-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(workspaceRoot, { recursive: true, force: true })),
    );
    NodeChildProcess.execFileSync("git", ["init", "--initial-branch=main"], {
      cwd: workspaceRoot,
      stdio: "ignore",
    });
    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const ingestion = yield* ProviderRuntimeIngestionService;
      yield* ingestion.start();
      const dispatch = (command: OrchestrationCommand) => engine.dispatch(command);
      yield* dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });
      yield* dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        sourceControlProfileId: null,
        createdAt,
      });
      yield* dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-seed"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      });

      let eventCounter = 0;
      return yield* body({
        stateChanged: (state, reason) =>
          ({
            type: "session.state.changed",
            eventId: EventId.make(`evt-state-${(eventCounter += 1)}`),
            provider: ProviderDriverKind.make("codex"),
            threadId,
            createdAt,
            payload: reason === undefined ? { state } : { state, reason },
          }) as ProviderRuntimeEvent,
        emitAndDrain: (events) =>
          provider.emitAndWaitForEnqueue(events).pipe(Effect.andThen(ingestion.drain)),
        sessionSetEvents: engine.readEvents(0).pipe(
          Stream.filter((event) => event.type === "thread.session-set"),
          Stream.runCollect,
          Effect.map((events) => Array.from(events)),
          Effect.orDie,
        ),
      });
    }).pipe(Effect.provide(makeLayer(provider.service)));
  });

const sessionOf = (event: OrchestrationEvent) =>
  event.type === "thread.session-set" ? event.payload.session : null;

it.live("persists one session-set for a burst of identical status pings", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const seeded = (yield* harness.sessionSetEvents).length;

      yield* harness.emitAndDrain(
        Array.from({ length: 10 }, () => harness.stateChanged("running")),
      );
      assert.strictEqual((yield* harness.sessionSetEvents).length, seeded + 1);

      // A real transition still lands, and so does the next change after it.
      yield* harness.emitAndDrain([harness.stateChanged("ready"), harness.stateChanged("ready")]);
      yield* harness.emitAndDrain([harness.stateChanged("running")]);
      const events = yield* harness.sessionSetEvents;
      assert.deepStrictEqual(
        events.slice(seeded).map((event) => sessionOf(event)?.status),
        ["running", "ready", "running"],
      );
    }),
  ),
);

it.live("keeps an error ping whose message changed", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const seeded = (yield* harness.sessionSetEvents).length;

      yield* harness.emitAndDrain([
        harness.stateChanged("error", "first failure"),
        harness.stateChanged("error", "first failure"),
        harness.stateChanged("error", "second failure"),
      ]);
      const events = yield* harness.sessionSetEvents;
      assert.deepStrictEqual(
        events.slice(seeded).map((event) => sessionOf(event)?.lastError),
        ["first failure", "second failure"],
      );
    }),
  ),
);
