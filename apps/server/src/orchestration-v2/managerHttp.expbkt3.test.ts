/** T3-CUSTOM(expbkt3): manager routes use native V2 persistence and run receipts. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Manager from "./ManagerService.expbkt3.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import * as Registry from "../mcp/McpSessionRegistry.ts";
import * as Profiles from "../mcp/UserMcpProfileStore.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { planProjectCommand } from "./ProjectCommands.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as Recovery from "./ProviderRuntimeRecoveryService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { managerRouteLayer } from "./managerHttp.expbkt3.ts";
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const owner = UserId.make("owner");
const other = UserId.make("other");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };

const secretStore = ServerSecretStore.ServerSecretStore.of({
  get: () => Effect.succeed(Option.none()),
  set: () => Effect.void,
  remove: () => Effect.void,
  create: () => Effect.die("unused"),
  getOrCreateRandom: () => Effect.die("unused"),
});
const registryLayer = Layer.effect(
  Registry.McpSessionRegistry,
  Effect.gen(function* () {
    const profiles = yield* Profiles.UserMcpProfileStore;
    return Registry.McpSessionRegistry.of({
      resolve: (token) =>
        profiles.resolveExternalToken(token).pipe(
          Effect.orDie,
          Effect.map((actor) =>
            actor
              ? {
                  principal: "external-user" as const,
                  actorUserId: actor.userId,
                  environmentId: EnvironmentId.make("test"),
                  threadId: ThreadId.make("external"),
                  providerSessionId: "external",
                  providerInstanceId: ProviderInstanceId.make("external"),
                  issuedAt: 0,
                  capabilities: new Set(["t3.read", "t3.control"] as const),
                }
              : undefined,
          ),
        ),
      issue: () => Effect.die("unused"),
      touch: () => Effect.void,
      revokeProviderSession: () => Effect.void,
      revokeThread: () => Effect.void,
      revokeLogin: () => Effect.void,
      revokeAll: Effect.void,
    });
  }),
);

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("HTTP contract tests must not start provider processes"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const native = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "manager-http" },
  ProviderAdapterRegistry.makeLayer([adapter]),
  { databaseLayer: database, runEffectWorker: false },
);
const stores = Layer.mergeAll(
  ProjectionStore.layer,
  ProjectStore.layer,
  OrchestrationCommandReceiptRepositoryLive,
  EffectOutbox.layer,
  OrchestrationEventStoreLive,
).pipe(Layer.provide(database));
const services = Layer.mergeAll(native, stores, registryLayer).pipe(
  Layer.provideMerge(stores),
  Layer.provideMerge(Profiles.layer),
  Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore)),
  Layer.provideMerge(
    ServerSettings.layerTest({ experimental: { externalMcp: { enabled: true } } }),
  ),
  Layer.provideMerge(database),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-manager-v2-" })),
  Layer.provideMerge(NodeServices.layer),
);
const setup = Effect.gen(function* () {
  yield* HttpRouter.serve(managerRouteLayer, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.build,
  );
  const profiles = yield* Profiles.UserMcpProfileStore;
  for (const user of [owner, other]) {
    const profile = yield* profiles.get(user);
    yield* profiles.update(user, {
      externalAccessEnabled: true,
      integrations: profile.integrations,
    });
  }
  const token = (yield* profiles.rotateExternalToken(owner)).token;
  const client = yield* HttpClient.HttpClient;
  const request = (path: string, body?: unknown, status = 200, bearer = token) =>
    Effect.gen(function* () {
      const req =
        body === undefined
          ? HttpClientRequest.get(path)
          : HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJsonUnsafe(body));
      const response = yield* client.execute(req.pipe(HttpClientRequest.bearerToken(bearer)));
      const json = (yield* response.json) as Record<string, unknown>;
      expect({ status: response.status, ...(response.status === status ? {} : { json }) }).toEqual({
        status,
      });
      return json;
    });
  const orchestrator = yield* OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* EventSinkV2;
  const projectId = ProjectId.make("manager-project");
  const now = yield* DateTime.now;
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
  const createThread = (id: string, user = owner) =>
    orchestrator.dispatch(
      {
        type: "thread.create",
        commandId: CommandId.make(`create:${id}`),
        threadId: ThreadId.make(id),
        projectId,
        title: id,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      },
      { actorUserId: user },
    );
  return { request, orchestrator, projections, events, profiles, token, projectId, createThread };
});

it.effect(
  "keeps direct visibility, atomic idle guards, stable prompt IDs and native run receipts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { request, orchestrator, projections, events, profiles, projectId, createThread } =
          yield* setup;
        yield* createThread("owned");
        yield* createThread("shared", other);
        yield* createThread("project-only", other);
        yield* orchestrator.dispatch({
          type: "thread.member.add",
          commandId: CommandId.make("share"),
          threadId: ThreadId.make("shared"),
          userId: owner,
        });
        const inventory = yield* request("/api/manager/sessions");
        expect((inventory.threads as { id: string }[]).map((t) => t.id).sort()).toEqual([
          "owned",
          "shared",
        ]);
        const boot = yield* request("/api/manager/bootstrap", { projectId, modelSelection });
        expect(boot).toEqual(
          yield* request("/api/manager/bootstrap", { projectId, modelSelection }),
        );
        const manager = yield* projections.getThreadShell(ThreadId.make(String(boot.sessionId)));
        expect(manager?.runtimeMode).toBe("approval-required");
        expect(manager?.pinnedAt).not.toBeNull();
        expect(manager?.autoSettleDisabledAt).not.toBeNull();
        // Project commits also advance the revision, even when the actor cannot see them.
        const projectNow = yield* DateTime.now;
        const hiddenProjectCommand = {
          type: "project.create" as const,
          commandId: CommandId.make("hidden-project-create"),
          projectId: ProjectId.make("hidden-project"),
          title: "Hidden",
          workspaceRoot: "/tmp/hidden-manager-test",
          actorUserId: other,
        };
        yield* events.commitProjectCommand({
          commandId: hiddenProjectCommand.commandId,
          projectId: hiddenProjectCommand.projectId,
          commandType: hiddenProjectCommand.type,
          acceptedAt: projectNow,
          event: Result.getOrThrow(
            planProjectCommand({
              command: hiddenProjectCommand,
              state: { project: undefined, workspaceOwner: undefined },
              eventId: EventId.make("hidden-project-created"),
              now: projectNow,
            }),
          ),
        });
        const snapshot = yield* request("/api/manager/sessions");
        yield* request("/api/manager/prompt", {
          sessionId: "shared",
          commandId: "member-prompt",
          messageId: "member-message",
          prompt: "Review this directly shared thread",
          expectedRevision: snapshot.snapshotSequence,
        });
        const input = {
          sessionId: "owned",
          commandId: "manager-command",
          messageId: "manager-message",
          prompt: "Review the activity",
          expectedRevision: snapshot.snapshotSequence,
        };
        const accepted = yield* request("/api/manager/prompt", input);
        expect(yield* request("/api/manager/prompt", input)).toEqual(accepted);
        yield* request("/api/manager/prompt", { ...input, prompt: "A changed command" }, 409);
        yield* request(
          "/api/manager/prompt",
          { ...input, commandId: "overlap", messageId: "overlap" },
          409,
        );
        expect(
          (yield* request("/api/manager/receipt?sessionId=owned&commandId=overlap")).status,
        ).toBe("rejected");
        yield* request(
          "/api/manager/prompt",
          { ...input, commandId: "private", messageId: "private", sessionId: "project-only" },
          403,
        );
        expect(
          (yield* request("/api/manager/receipt?sessionId=owned&commandId=manager-command"))
            .execution,
        ).toEqual({ state: "queued" });
        const state = yield* projections.getThreadRecords(ThreadId.make("owned"), [
          "messages",
          "runs",
        ]);
        expect(state.messages[0]?.sentByUserId).toBe(owner);
        expect(state.messages[0]?.backgroundGrantHash).toMatch(/^[a-f0-9]{64}$/);
        expect(state.runs).toHaveLength(1);
        expect((yield* request("/api/manager/sessions")).threads).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: "owned", idle: false })]),
        );
        const run = state.runs[0]!;
        const now = yield* DateTime.now;
        yield* events.write({
          events: [
            {
              id: EventId.make("failed-run"),
              type: "run.updated",
              threadId: run.threadId,
              occurredAt: now,
              payload: { ...run, status: "failed", completedAt: now },
            },
          ],
        });
        expect(
          (yield* request("/api/manager/receipt?sessionId=owned&commandId=manager-command"))
            .execution,
        ).toEqual({ state: "error" });
        // Any completed turn invalidates the snapshot captured before it.
        yield* request(
          "/api/manager/prompt",
          { ...input, commandId: "stale", messageId: "stale" },
          409,
        );
        const fresh = yield* request("/api/manager/sessions");
        yield* request(
          "/api/manager/prompt",
          { ...input, commandId: "duplicate-message", expectedRevision: fresh.snapshotSequence },
          409,
        );
        yield* request(
          "/api/manager/prompt",
          {
            ...input,
            commandId: "native-command",
            messageId: "native-command",
            prompt: "/compact",
            expectedRevision: fresh.snapshotSequence,
          },
          409,
        );
        // A human turn accepted after the snapshot wins the same serialization boundary.
        yield* orchestrator.dispatch(
          {
            type: "message.dispatch",
            commandId: CommandId.make("human-prompt"),
            threadId: ThreadId.make("owned"),
            messageId: MessageId.make("human-message"),
            text: "Human work",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          },
          { actorUserId: owner },
        );
        yield* request(
          "/api/manager/prompt",
          {
            ...input,
            commandId: "human-overlap",
            messageId: "human-overlap",
            expectedRevision: fresh.snapshotSequence,
          },
          409,
        );
        const human = yield* projections.getThreadRecords(ThreadId.make("owned"), [
          "runs",
          "messages",
        ]);
        const humanRun = human.runs.find(
          (candidate) => candidate.userMessageId === "human-message",
        )!;
        expect(
          human.messages.find((message) => message.id === "human-message")?.backgroundGrantHash,
        ).toBeUndefined();
        yield* events.write({
          events: [
            {
              id: EventId.make("human-complete"),
              type: "run.updated",
              threadId: humanRun.threadId,
              occurredAt: now,
              payload: { ...humanRun, status: "completed", completedAt: now },
            },
          ],
        });
        const afterHuman = yield* request("/api/manager/sessions");
        yield* request("/api/manager/prompt", {
          ...input,
          commandId: "later",
          messageId: "later",
          expectedRevision: afterHuman.snapshotSequence,
        });
        expect(
          (yield* request("/api/manager/receipt?sessionId=owned&commandId=later")).execution,
        ).toEqual({ state: "queued" });
        expect(
          (yield* request("/api/manager/receipt?sessionId=owned&commandId=manager-command"))
            .execution,
        ).toEqual({ state: "error" });
        const page = yield* request("/api/manager/events?after=0&limit=1000");
        expect(
          (page.events as { aggregateId: string }[]).every((e) => e.aggregateId !== "project-only"),
        ).toBe(true);
        expect(yield* encodeJson(page)).not.toContain("backgroundGrantHash");
        expect(page.nextAfter).toBe(page.headSequence);
        // Revoking membership removes historical events, not just future activity.
        yield* orchestrator.dispatch({
          type: "thread.member.remove",
          commandId: CommandId.make("unshare"),
          threadId: ThreadId.make("shared"),
          userId: owner,
        });
        const unshared = yield* request("/api/manager/events?after=0&limit=1000");
        expect(
          (unshared.events as { aggregateId: string }[]).every((e) => e.aggregateId !== "shared"),
        ).toBe(true);
        yield* request("/api/manager/events?after=999999999", undefined, 410);
        const profile = yield* profiles.get(owner);
        yield* profiles.update(owner, {
          externalAccessEnabled: false,
          integrations: profile.integrations,
        });
        yield* request("/api/manager/sessions", undefined, 401);
        yield* request("/api/manager/prompt", input, 401);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, services))),
);

it.effect(
  "recovers accepted starts as terminal errors and distinguishes recovery from human stop",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { request, orchestrator, projections, projectId } = yield* setup;
        const boot = yield* request("/api/manager/bootstrap", { projectId, modelSelection });
        const snapshot = yield* request("/api/manager/sessions");
        const input = {
          sessionId: boot.sessionId,
          commandId: "restart-start",
          messageId: "restart-message",
          prompt: "Review once",
          expectedRevision: snapshot.snapshotSequence,
        };
        yield* request("/api/manager/prompt", input);
        const recover = yield* Recovery.ProviderRuntimeRecoveryService;
        const summary = yield* recover.recover;
        expect(summary.terminalizedRuns).toBe(1);
        const receipt = yield* request(
          `/api/manager/receipt?sessionId=${boot.sessionId}&commandId=restart-start`,
        );
        expect(receipt.execution).toEqual({ state: "error" });
        expect(yield* request("/api/manager/bootstrap", { projectId, modelSelection })).toEqual(
          boot,
        );
        const recovered = yield* request("/api/manager/sessions");
        expect(recovered.threads).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: boot.sessionId, idle: true })]),
        );
        yield* request("/api/manager/prompt", {
          ...input,
          commandId: "after-recovery",
          messageId: "after-recovery",
          expectedRevision: recovered.snapshotSequence,
        });
        const runs = (yield* projections.getThreadRecords(ThreadId.make(String(boot.sessionId)), [
          "runs",
        ])).runs;
        const current = runs.find((run) => run.userMessageId === "after-recovery")!;
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("human-stop"),
          threadId: ThreadId.make(String(boot.sessionId)),
          runId: current.id,
        });
        yield* request("/api/manager/bootstrap", { projectId, modelSelection }, 409);
        const stopped = yield* request("/api/manager/sessions");
        expect(stopped.threads).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: boot.sessionId, idle: false })]),
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeHttpServer.layerTest,
          Recovery.layer.pipe(Layer.provideMerge(services), Layer.provide(IdAllocator.layer)),
        ),
      ),
    ),
);

it.effect("does not recreate an archived or deleted manager", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { request, orchestrator, projectId } = yield* setup;
      const boot = yield* request("/api/manager/bootstrap", { projectId, modelSelection });
      const threadId = ThreadId.make(String(boot.sessionId));
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-manager"),
        threadId,
      });
      yield* request("/api/manager/bootstrap", { projectId, modelSelection }, 409);
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-manager"),
        threadId,
      });
      yield* request("/api/manager/bootstrap", { projectId, modelSelection }, 409);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, services))),
);

it.effect(
  "rejects a bootstrap grant revoked after authentication and does not poison permanent IDs",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { profiles, token, projectId, projections, createThread } = yield* setup;
        const registry = yield* Registry.McpSessionRegistry;
        const principal = yield* registry.resolve(token);
        expect(principal?.actorUserId).toBe(owner);
        const actor = {
          userId: owner,
          grantHash: NodeCrypto.createHash("sha256").update(token).digest("hex"),
        };
        const service = yield* Manager.ManagerService;
        const profile = yield* profiles.get(owner);
        yield* profiles.update(owner, {
          externalAccessEnabled: false,
          integrations: profile.integrations,
        });
        const rejected = yield* Effect.result(
          service.bootstrap(actor, { projectId, modelSelection }),
        );
        expect(Result.isFailure(rejected)).toBe(true);
        if (Result.isFailure(rejected))
          expect(rejected.failure).toMatchObject({ status: 401, detail: "grant-revoked" });
        expect(yield* projections.getThreadShell(ThreadId.make(`manager:${owner}`))).toBeNull();
        // Existing unpinned managers also cannot be mutated with a revoked grant.
        yield* createThread(`manager:${owner}`);
        const pinRejected = yield* Effect.result(
          service.bootstrap(actor, { projectId, modelSelection }),
        );
        expect(Result.isFailure(pinRejected)).toBe(true);
        const unpinned = yield* projections.getThreadShell(ThreadId.make(`manager:${owner}`));
        expect(unpinned?.pinnedAt).toBeNull();
        expect(unpinned?.autoSettleDisabledAt).toBeNull();
        yield* profiles.update(owner, {
          externalAccessEnabled: true,
          integrations: profile.integrations,
        });
        yield* service.bootstrap(actor, { projectId, modelSelection });
        const active = yield* projections.getThreadShell(ThreadId.make(`manager:${owner}`));
        expect(active?.pinnedAt).not.toBeNull();
        expect(active?.autoSettleDisabledAt).not.toBeNull();
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(NodeHttpServer.layerTest, Manager.layer.pipe(Layer.provideMerge(services))),
      ),
    ),
);

it.effect("binds concurrent first bootstraps to exactly one authorized project", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { token, projectId, events, projections } = yield* setup;
      const actor = {
        userId: owner,
        grantHash: NodeCrypto.createHash("sha256").update(token).digest("hex"),
      };
      const secondProject = ProjectId.make("second-bootstrap-project");
      const now = yield* DateTime.now;
      const command = {
        type: "project.create" as const,
        commandId: CommandId.make("second-project-create"),
        projectId: secondProject,
        title: "Second",
        workspaceRoot: "/tmp/second-bootstrap-project",
        actorUserId: owner,
      };
      yield* events.commitProjectCommand({
        commandId: command.commandId,
        projectId: secondProject,
        commandType: command.type,
        acceptedAt: now,
        event: Result.getOrThrow(
          planProjectCommand({
            command,
            state: { project: undefined, workspaceOwner: undefined },
            eventId: EventId.make("second-project-created"),
            now,
          }),
        ),
      });
      const service = yield* Manager.ManagerService;
      const results = yield* Effect.all(
        [projectId, secondProject].map((projectId) =>
          service.bootstrap(actor, { projectId, modelSelection }).pipe(
            Effect.result,
            Effect.map((result) => ({ projectId, result })),
          ),
        ),
        { concurrency: 2 },
      );
      expect(results.filter(({ result }) => Result.isSuccess(result))).toHaveLength(1);
      expect(results.filter(({ result }) => Result.isFailure(result))).toHaveLength(1);
      const winner = results.find(({ result }) => Result.isSuccess(result))!;
      expect(
        (yield* projections.getThreadShell(ThreadId.make(`manager:${owner}`)))?.projectId,
      ).toBe(winner.projectId);
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(NodeHttpServer.layerTest, Manager.layer.pipe(Layer.provideMerge(services))),
    ),
  ),
);
