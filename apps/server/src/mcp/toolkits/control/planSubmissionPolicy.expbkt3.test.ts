import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { OrchestrationThread } from "@t3tools/contracts/orchestration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import { AgentUiService } from "../../../agentui/AgentUiService.ts";
import { ClerkDirectory } from "../../../auth/ClerkDirectory.ts";
import * as ServerConfig from "../../../config.ts";
import { GitWorkflowService } from "../../../git/GitWorkflowService.ts";
import { OrchestrationAccessControl } from "../../../orchestration-v2/Services/AccessControl.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import { TurnStartBootstrap } from "../../../orchestration-v2/turnStartBootstrap.expbkt3.ts";
import { UserPresenceService } from "../../../presence/UserPresenceService.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ThreadCommentsService } from "../../../threadcomments/ThreadCommentsService.ts";
import { WorkspacePaths } from "../../../workspace/WorkspacePaths.ts";
import { T3ControlToolkitRegistrationLive } from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import { T3ControlToolkitHandlersLive } from "./handlers.ts";
import { T3ControlToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread-plan-policy-test");
const plan = { format: "md" as const, content: "# Complete plan\n\nKeep the fork features." };
const disabledMessage = "Plan submission is disabled. Put the complete plan in the main chat.";
const thread = Schema.decodeSync(OrchestrationThread)({
  id: threadId,
  projectId: ProjectId.make("project-plan-policy-test"),
  title: "Plan policy test",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  ownerUserId: null,
  memberUserIds: [],
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
  deletedAt: null,
  messages: [],
  activities: [],
  checkpoints: [],
  proposedPlans: [],
  session: null,
});
const invocation: McpInvocationContext.McpInvocationScope = {
  principal: "provider-session",
  actorUserId: null,
  environmentId: EnvironmentId.make("environment-plan-policy-test"),
  requestNamespace: "provider-session-plan-policy-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-plan-policy-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["t3.read", "t3.control", "t3.plan"]),
  issuedAt: 1,
};

const makeFixture = Effect.gen(function* () {
  let current = DEFAULT_SERVER_SETTINGS;
  let subscriptions = 0;
  let reads = 0;
  const commands: Array<Parameters<TurnStartBootstrap["Service"]["dispatch"]>[0]> = [];
  const updates = yield* PubSub.unbounded<{
    readonly settings: ServerSettings;
    readonly handled: Deferred.Deferred<void>;
  }>();
  const settingsLayer = Layer.mock(ServerSettingsService)({
    getSettings: Effect.sync(() => current),
    subscribeChanges: Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(updates);
      subscriptions++;
      return Stream.fromSubscription(subscription).pipe(
        Stream.flatMap((update) =>
          Stream.concat(
            Stream.succeed(update.settings),
            // Acknowledge only after the downstream listener processes the change.
            Stream.fromEffectDrain(Deferred.succeed(update.handled, undefined)),
          ),
        ),
      );
    }),
    withSettingsSnapshot: (use) => Effect.suspend(() => use(current)),
  });
  const dependencies = Layer.mergeAll(
    settingsLayer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadDetailById: () =>
        Effect.sync(() => {
          reads++;
          return Option.some(thread);
        }),
      getThreadDetailSnapshot: () =>
        Effect.succeed(
          Option.some({
            thread,
            snapshotSequence: 42,
          }),
        ),
    }),
    Layer.mock(TurnStartBootstrap)({
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: 42 };
        }),
    }),
    Layer.mock(OrchestrationAccessControl)({ actorFor: () => Option.none() }),
    Layer.mock(AgentUiService)({}),
    Layer.mock(ThreadCommentsService)({}),
    Layer.mock(UserPresenceService)({}),
    Layer.mock(ProviderRegistry)({}),
    Layer.mock(ClerkDirectory)({ enabled: false, descriptor: null }),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-plan-policy-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    Layer.mock(WorkspacePaths)({}),
    Layer.mock(GitWorkflowService)({}),
    // McpToolAccess reads the calling thread before a write.
    liveThreadsLayer,
    NodeServices.layer,
  );
  const setCurrent = (enabled: boolean) =>
    Effect.sync(() => {
      current = {
        ...current,
        experimental: { ...current.experimental, agentPlanSubmissionEnabled: enabled },
      };
    });
  const publishCurrent = Effect.gen(function* () {
    const handled = yield* Deferred.make<void>();
    yield* PubSub.publish(updates, { settings: current, handled });
    yield* Deferred.await(handled);
  });
  return {
    dependencies,
    commands,
    setCurrent,
    publishCurrent,
    get reads() {
      return reads;
    },
    get subscriptions() {
      return subscriptions;
    },
  };
});

const RpcResponse = Schema.Struct({
  id: Schema.Number,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
const ToolList = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) });
const ToolResult = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  structuredContent: Schema.optionalKey(Schema.Unknown),
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRpcResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(RpcResponse));
const decodeToolList = Schema.decodeUnknownEffect(ToolList);
const decodeToolResult = Schema.decodeUnknownEffect(ToolResult);
const decodeServerSettings = Schema.decodeSync(ServerSettings);
const encodeSavedSettings = Schema.encodeSync(Schema.fromJsonString(ServerSettings));
const decodeSavedSettings = Schema.decodeSync(Schema.fromJsonString(ServerSettings));
const responseJson = (body: string) =>
  body.startsWith("event:") || body.startsWith("data:")
    ? (body
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim() ?? "")
    : body;

it.effect("changes plan tool visibility for existing HTTP sessions without a restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const serverLayer = Layer.mergeAll(
        McpServer.layerHttp({
          name: "Plan policy test",
          version: "1.0.0",
          path: "/mcp",
          protocols: [McpProtocol.v2025_06_18],
        }),
        T3ControlToolkitRegistrationLive,
      ).pipe(Layer.provide(fixture.dependencies));
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      expect(fixture.subscriptions).toBe(1);
      const http = yield* HttpClient.HttpClient;
      let requestId = 0;
      const rpc = Effect.fnUntraced(function* (
        method: string,
        params: unknown,
        sessionId?: string,
      ) {
        const response = yield* http.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            ...(sessionId
              ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" }
              : {}),
          },
          body: HttpBody.text(
            encodeJson({ jsonrpc: "2.0", id: ++requestId, method, params }),
            "application/json",
          ),
        });
        expect(response.status).toBe(200);
        return {
          sessionId: response.headers["mcp-session-id"],
          message: yield* decodeRpcResponse(responseJson(yield* response.text)),
        };
      });
      const connect = Effect.gen(function* () {
        const initialized = yield* rpc("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "plan-policy-client", version: "1.0.0" },
        });
        const sessionId = initialized.sessionId;
        expect(sessionId).toBeDefined();
        if (!sessionId) return yield* Effect.die("MCP did not create a session");
        const response = yield* http.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            "mcp-session-id": sessionId,
            "mcp-protocol-version": "2025-06-18",
          },
          body: HttpBody.text(
            encodeJson({ jsonrpc: "2.0", method: "notifications/initialized" }),
            "application/json",
          ),
        });
        expect(response.status).toBe(202);
        return sessionId;
      });
      const sessions = [yield* connect, yield* connect];
      const listTools = Effect.fnUntraced(function* (sessionId: string) {
        const response = yield* rpc("tools/list", {}, sessionId);
        return (yield* decodeToolList(response.message.result)).tools.map((tool) => tool.name);
      });
      const firstSession = sessions[0]!;
      const defaultTools = yield* listTools(firstSession);
      expect(defaultTools).not.toContain("t3_submit_plan");
      const defaultRefused = yield* rpc(
        "tools/call",
        { name: "t3_submit_plan", arguments: plan },
        firstSession,
      );
      expect(defaultRefused.message.error).toBeDefined();
      expect(fixture.commands).toHaveLength(0);
      expect(fixture.reads).toBe(0);

      yield* fixture.setCurrent(true);
      yield* fixture.publishCurrent;
      const originalTools = yield* listTools(firstSession);
      expect(originalTools).toContain("t3_submit_plan");
      expect(originalTools).toContain("t3_get_session");
      expect(originalTools).toContain("t3_show_ui");
      const accepted = yield* rpc(
        "tools/call",
        { name: "t3_submit_plan", arguments: plan },
        firstSession,
      );
      expect((yield* decodeToolResult(accepted.message.result)).structuredContent).toMatchObject({
        accepted: true,
      });
      expect(fixture.commands).toHaveLength(1);
      expect(fixture.commands[0]).toMatchObject({
        type: "thread.proposed-plan.upsert",
        threadId,
        proposedPlan: { planMarkdown: plan.content },
      });

      yield* fixture.setCurrent(false);
      yield* fixture.publishCurrent;
      for (const sessionId of sessions) {
        expect(yield* listTools(sessionId)).toEqual(
          originalTools.filter((name) => name !== "t3_submit_plan"),
        );
        const refused = yield* rpc(
          "tools/call",
          { name: "t3_submit_plan", arguments: plan },
          sessionId,
        );
        expect(refused.message.error).toBeDefined();
      }
      expect(fixture.commands).toHaveLength(1);
      const unrelated = yield* rpc(
        "tools/call",
        { name: "t3_get_session", arguments: {} },
        firstSession,
      );
      expect((yield* decodeToolResult(unrelated.message.result)).structuredContent).toMatchObject({
        thread: { id: threadId },
      });

      yield* fixture.setCurrent(true);
      yield* fixture.publishCurrent;
      for (const sessionId of sessions) expect(yield* listTools(sessionId)).toEqual(originalTools);
      const restored = yield* rpc(
        "tools/call",
        { name: "t3_submit_plan", arguments: plan },
        firstSession,
      );
      expect((yield* decodeToolResult(restored.message.result)).structuredContent).toMatchObject({
        accepted: true,
      });
      expect(fixture.commands).toHaveLength(2);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("rejects a cached direct handler before any plan read or mutation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* Effect.gen(function* () {
        const cachedToolkit = yield* T3ControlToolkit.pipe(
          Effect.provide(T3ControlToolkitHandlersLive),
        );
        yield* fixture.setCurrent(false);
        // No change publication: the guard must read the setting at invocation time.
        const refused = yield* cachedToolkit
          .handle("t3_submit_plan", plan)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.flip);
        expect(refused).toMatchObject({ _tag: "T3ControlToolError", message: disabledMessage });
        expect(fixture.reads).toBe(0);
        expect(fixture.commands).toHaveLength(0);
        yield* fixture.setCurrent(true);
        const restored = yield* cachedToolkit
          .handle("t3_submit_plan", plan)
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(restored[0]).toMatchObject({ isFailure: false, result: { accepted: true } });
        expect(fixture.commands).toHaveLength(1);
      }).pipe(Effect.provide(fixture.dependencies));
    }),
  ),
);

it("defaults older saved settings to disabled and retains an explicit saved enable", () => {
  const oldSettings = decodeServerSettings({ experimental: {} });
  expect(oldSettings.experimental.agentPlanSubmissionEnabled).toBe(false);
  const enabled = {
    ...oldSettings,
    experimental: { ...oldSettings.experimental, agentPlanSubmissionEnabled: true },
  };
  const saved = encodeSavedSettings(enabled);
  const reopened = decodeSavedSettings(saved);
  expect(reopened.experimental.agentPlanSubmissionEnabled).toBe(true);
});
