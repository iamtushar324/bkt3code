// T3-CUSTOM(expbkt3): scheduled tasks store a BK sidebar custom group and apply it to the
// fresh thread each run launches (XFN-59).
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import {
  readScheduledTaskCustomGroup,
  saveScheduledTaskCustomGroupForMcp,
  writeScheduledTaskCustomGroup,
} from "./scheduledTaskCustomGroup.expbkt3.ts";

const projectId = ProjectId.make("project:scheduled-custom-group");

const supervisedClient: McpInvocationScope = {
  principal: "external-operator",
  actorUserId: null,
  environmentId: EnvironmentId.make("environment:scheduled-custom-group"),
  requestNamespace: "client:scheduled-custom-group",
  thread: undefined,
  client: { sessionId: "scheduled-custom-group", label: "Automation", access: "approval-required" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const countLabels = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly count: number;
  }>`SELECT COUNT(*) AS count FROM scheduled_task_custom_groups`.pipe(
    Effect.map((rows) => rows[0]?.count ?? 0),
  );

it.effect("stores a task's custom group, applies it to each fresh thread, and drops it", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunchService.ThreadLaunchInput> = [];
    const scheduledTasks = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          Scheduler.layer,
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (input) =>
              Effect.sync(() => {
                launched.push(input);
                return {} as ThreadLaunchService.ThreadLaunchResult;
              }),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
        ),
      ),
    );
    const project = {
      id: projectId,
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    } as unknown as Project;
    const services = OrchestratorMcpService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeed(Option.some(project)),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
        ),
      ),
      Layer.provideMerge(scheduledTasks),
    );

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const scheduled = yield* ScheduledTaskService.ScheduledTaskService;

      const created = yield* mcp.scheduleTask(supervisedClient, {
        projectId,
        prompt: "Check the nightly build.",
        schedule: { type: "interval", everyMs: 3_600_000 },
        bindToCurrentThread: false,
        customGroup: "Nightly checks",
      });
      const taskId = created.scheduledTaskId;
      expect(created.customGroup).toBe("Nightly checks");
      expect(created.boundThreadId).toBeNull();

      yield* scheduled.runNow({ id: taskId });
      expect(launched.map((input) => input.customGroup)).toEqual(["Nightly checks"]);

      // An edit that leaves customGroup out keeps it. This goes through the same
      // full-row upsert the web editor uses, which never touches the label.
      const renamed = yield* mcp.updateScheduledTask(supervisedClient, {
        scheduledTaskId: taskId,
        title: "Nightly build check",
      });
      expect(renamed.customGroup).toBe("Nightly checks");
      expect((yield* mcp.listScheduledTasks(supervisedClient, { projectId })).tasks).toEqual([
        expect.objectContaining({ scheduledTaskId: taskId, customGroup: "Nightly checks" }),
      ]);

      const cleared = yield* mcp.updateScheduledTask(supervisedClient, {
        scheduledTaskId: taskId,
        customGroup: null,
      });
      expect("customGroup" in cleared).toBe(false);
      yield* scheduled.runNow({ id: taskId });
      expect(launched).toHaveLength(2);
      expect("customGroup" in launched[1]!).toBe(false);

      const regrouped = yield* mcp.updateScheduledTask(supervisedClient, {
        scheduledTaskId: taskId,
        customGroup: "Release",
      });
      expect(regrouped.customGroup).toBe("Release");
      expect(yield* countLabels(sql)).toBe(1);

      // Deleting the task deletes its label, and a late write for it stores nothing.
      yield* scheduled.delete({ id: taskId });
      expect(yield* countLabels(sql)).toBe(0);
      yield* writeScheduledTaskCustomGroup(sql, taskId, "Orphan");
      expect(yield* readScheduledTaskCustomGroup(sql, taskId)).toBeNull();
      expect(yield* countLabels(sql)).toBe(0);
    }).pipe(Effect.provide(services));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("refuses a label when the server has no SQL store, and keeps an omitted one", () =>
  Effect.gen(function* () {
    const taskId = ScheduledTaskId.make("scheduled-task:no-store");
    const refused = yield* saveScheduledTaskCustomGroupForMcp(
      Option.none(),
      taskId,
      "Nightly checks",
    ).pipe(Effect.flip);
    expect(refused.code).toBe("orchestration_error");
    yield* saveScheduledTaskCustomGroupForMcp(Option.none(), taskId, undefined);
    yield* saveScheduledTaskCustomGroupForMcp(Option.none(), taskId, null);
  }),
);
