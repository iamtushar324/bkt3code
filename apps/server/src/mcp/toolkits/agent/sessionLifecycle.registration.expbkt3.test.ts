// T3-CUSTOM(expbkt3): TEC-1819 — t3_session_lifecycle through the production
// agent toolkit registration. The registration itself provides the command
// receipt store (from the receipt repository the server exposes), so a no-op
// archive retried with the same clientRequestId replays as a no-op even after
// the session was unarchived in between.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import { ClerkDirectory } from "../../../auth/ClerkDirectory.ts";
import { ServerConfig } from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { GitWorkflowService } from "../../../git/GitWorkflowService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { OrchestrationAccessControl } from "../../../orchestration-v2/Services/AccessControl.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import { TurnStartBootstrap } from "../../../orchestration-v2/turnStartBootstrap.expbkt3.ts";
import {
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceipt,
} from "../../../persistence/OrchestrationCommandReceipts.ts";
import { PlanReviewService } from "../../../planreview/PlanReviewService.ts";
import * as Project from "../../../project/ProjectService.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { layerAgentToolkitRegistration } from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

const sessionId = ThreadId.make("thread-agent-lifecycle-registration");
const ARCHIVED_AT = "2026-10-28T10:00:00.000Z";

const invocation: McpInvocationContext.McpInvocationScope = {
  principal: "external-user",
  actorUserId: null,
  environmentId: EnvironmentId.make("environment-agent-lifecycle-registration"),
  requestNamespace: "external-user:agent-lifecycle-registration",
  thread: undefined,
  client: {
    sessionId: "external-user:agent-lifecycle-registration",
    label: "OAuth client",
    access: "full-access",
  },
  capabilities: new Set(["orchestration", "t3.read", "t3.control"]),
  issuedAt: 1,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "agent-lifecycle-registration-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "agent-lifecycle-registration-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

let archivedAt: string | null = ARCHIVED_AT;
const dispatched: OrchestrationCommand[] = [];
// The persisted receipts, as the receipt repository stores them.
const stored = new Map<string, OrchestrationCommandReceipt>();

const dependencies = Layer.mergeAll(
  Layer.mock(OrchestrationCommandReceiptRepository)({
    insertIfAbsent: (receipt) =>
      Effect.sync(() => {
        if (stored.has(receipt.commandId)) return false;
        stored.set(receipt.commandId, receipt);
        return true;
      }),
    upsert: (receipt) =>
      Effect.sync(() => {
        stored.set(receipt.commandId, receipt);
      }),
    getByCommandId: ({ commandId }) =>
      Effect.sync(() => Option.fromNullishOr(stored.get(commandId))),
  }),
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) =>
      Effect.sync(() =>
        id === sessionId
          ? {
              ...liveThreadShell(id, { activeRunId: null }),
              ...(archivedAt === null ? {} : { archivedAt: DateTime.makeUnsafe(archivedAt) }),
            }
          : null,
      ),
  }),
  Layer.mock(ProjectionSnapshotQuery)({
    getThreadShellById: (id) =>
      Effect.sync(() =>
        id === sessionId
          ? Option.some({ id, archivedAt } as unknown as OrchestrationThreadShell)
          : Option.none(),
      ),
  }),
  Layer.mock(TurnStartBootstrap)({
    dispatch: (command) =>
      Effect.sync(() => {
        // A command id with a receipt replays instead of acting.
        const receipt = stored.get(command.commandId);
        if (receipt !== undefined) return { sequence: receipt.resultSequence };
        dispatched.push(command);
        if (command.type === "thread.archive") archivedAt = ARCHIVED_AT;
        if (command.type === "thread.unarchive") archivedAt = null;
        return { sequence: dispatched.length };
      }),
  }),
  Layer.mock(OrchestrationAccessControl)({ actorFor: () => Option.none() }),
  Layer.mock(ClerkDirectory)({ enabled: false, descriptor: null }),
  Layer.mock(ServerConfig)({}),
  Layer.mock(ServerEnvironment.ServerEnvironment)({}),
  Layer.mock(GitWorkflowService)({}),
  Layer.mock(PlanReviewService)({}),
  Layer.mock(Project.ProjectService)({}),
  Layer.mock(ProviderRegistry)({}),
  Layer.mock(ScheduledTaskService)({}),
  Layer.mock(ServerSettingsService)({}),
  NodeServices.layer,
);

const TestLayer = layerAgentToolkitRegistration.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(dependencies),
);

const withInvocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

const textOf = (result: { readonly content: ReadonlyArray<unknown> }) =>
  JSON.stringify(result.content);

it.effect("replays a no-op archive after an unarchive, through the production registration", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = withInvocation(
        server.callTool({
          name: "t3_session_lifecycle",
          arguments: { session: sessionId, action: "archive", clientRequestId: "archive-1" },
        }),
      );

      const first = yield* call;
      expect(first.isError).toBe(false);
      expect(textOf(first)).toContain("Nothing to do");
      // The no-op went into the receipt repository, not a test double of the store.
      expect([...stored.values()]).toMatchObject([
        { aggregateId: sessionId, status: "accepted", resultSequence: 0 },
      ]);

      // Someone unarchives the session; the same request is retried.
      archivedAt = null;
      const retry = yield* call;
      expect(retry.isError).toBe(false);
      expect(textOf(retry)).toContain("Nothing to do");
      expect(archivedAt).toBeNull();
      expect(dispatched).toHaveLength(0);
    }),
  ).pipe(Effect.provide(TestLayer)),
);
