// T3-CUSTOM(expbkt3): a scheduled task's BK options (migration 1052): who a run
// acts for, the tags of the session it starts, quiet, run-once, and pausing
// when its session is gone.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { CurrentOrchestrationActorUserId } from "../orchestration-v2/forkActor.expbkt3.ts";
import type { OrchestratorV2DispatchResult } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import {
  readScheduledTaskForkOptions,
  writeScheduledTaskForkOptions,
} from "./scheduledTaskForkOptions.expbkt3.ts";

const projectId = ProjectId.make("project:scheduled-fork-options");
const owner = UserId.make("user:owner");
const teammate = UserId.make("user:teammate");
const launchedThreadId = ThreadId.make("thread:launched");
const boundThreadId = ThreadId.make("thread:bound");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

const baseTask = {
  title: "Check the build",
  prompt: "Check the nightly build.",
  enabled: true,
  schedule: { type: "interval" as const, everyMs: 3_600_000 },
  projectId,
  workspaceStrategy: { type: "root" as const },
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
};

it.effect("runs as the owner, tags new sessions, snoozes quiet ones and pauses after one run", () =>
  Effect.gen(function* () {
    const launches: Array<{
      readonly input: ThreadLaunchService.ThreadLaunchInput;
      readonly actor: UserId | null;
    }> = [];
    const sends: Array<{
      readonly input: ThreadManagementService.ThreadManagementSendInput;
      readonly actor: UserId | null;
    }> = [];
    const commands: Array<OrchestrationV2ServerCommand> = [];
    let boundArchived = false;
    const services = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          Scheduler.layer,
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (input) =>
              Effect.gen(function* () {
                launches.push({ input, actor: yield* CurrentOrchestrationActorUserId });
                return {
                  threadId: launchedThreadId,
                  resumed: false,
                } as unknown as ThreadLaunchService.ThreadLaunchResult;
              }),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: (input) =>
              Effect.gen(function* () {
                sends.push({ input, actor: yield* CurrentOrchestrationActorUserId });
                if (boundArchived) {
                  return yield* new ThreadManagementService.ThreadManagementThreadArchivedError({
                    threadId: input.threadId,
                  });
                }
                return {} as ThreadManagementService.ThreadManagementSendResult;
              }),
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: commands.length } as unknown as OrchestratorV2DispatchResult;
              }),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const scheduled = yield* ScheduledTaskService.ScheduledTaskService;

      // A task that starts a new session on each run.
      const { task: fresh } = yield* scheduled.upsert({ ...baseTask, threadId: null });
      yield* writeScheduledTaskForkOptions(sql, fresh.id, {
        ownerUserId: owner,
        memberUserIds: [teammate],
        priority: 2,
        quiet: true,
        runOnce: true,
      });
      const { task: afterRun } = yield* scheduled.runNow({ id: fresh.id });
      expect(launches).toHaveLength(1);
      expect(launches[0]?.actor).toBe(owner);
      expect(launches[0]?.input).toMatchObject({
        ownerUserId: owner,
        memberUserIds: [teammate],
        priority: 2,
      });
      // The message says a schedule sent it, though it carries the owner's name.
      expect(launches[0]?.input.initialMessage?.text).toMatch(
        /^\[Scheduled prompt "Check the build" .*not typed by a person.*\]\n\nCheck the nightly build\.$/s,
      );
      // Quiet: the new session is snoozed; run-once: the task pauses.
      expect(commands).toEqual([
        expect.objectContaining({ type: "thread.snooze", threadId: launchedThreadId }),
      ]);
      expect(afterRun).toMatchObject({
        enabled: false,
        nextRunAt: null,
        lastRunStatus: "succeeded",
      });

      // A task that sends into a session keeps that session's model.
      const { task: bound } = yield* scheduled.upsert({ ...baseTask, threadId: boundThreadId });
      yield* writeScheduledTaskForkOptions(sql, bound.id, {
        ownerUserId: owner,
        keepThreadModel: true,
      });
      yield* scheduled.runNow({ id: bound.id });
      expect(sends).toHaveLength(1);
      expect(sends[0]?.actor).toBe(owner);
      expect(sends[0]?.input.mode).toBe("queue");
      expect("modelSelection" in (sends[0]?.input ?? {})).toBe(false);
      const { tasks: stillRunning } = yield* scheduled.list();
      expect(stillRunning.find((task) => task.id === bound.id)?.enabled).toBe(true);

      // Its session is archived: the run fails and the task pauses itself.
      boundArchived = true;
      const { task: paused } = yield* scheduled.runNow({ id: bound.id });
      expect(paused).toMatchObject({ enabled: false, nextRunAt: null, lastRunStatus: "failed" });
      expect(paused.lastRunError).toContain("archived");

      // Deleting a task deletes its options.
      yield* scheduled.delete({ id: bound.id });
      expect(yield* readScheduledTaskForkOptions(sql, bound.id)).toEqual({});
      yield* writeScheduledTaskForkOptions(sql, bound.id, { ownerUserId: owner });
      expect(yield* readScheduledTaskForkOptions(sql, bound.id)).toEqual({});
    }).pipe(Effect.provide(services));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a task without options runs as nobody, as upstream's do", () =>
  Effect.gen(function* () {
    const actors: Array<UserId | null> = [];
    const services = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          Scheduler.layer,
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (input) =>
              Effect.gen(function* () {
                actors.push(yield* CurrentOrchestrationActorUserId);
                expect("ownerUserId" in input).toBe(false);
                expect(input.initialMessage?.text).toBe("Check the nightly build.");
                return {
                  threadId: launchedThreadId,
                  resumed: false,
                } as unknown as ThreadLaunchService.ThreadLaunchResult;
              }),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* scheduled.upsert({ ...baseTask, threadId: null });
      const { task: afterRun } = yield* scheduled.runNow({ id: task.id });
      expect(actors).toEqual([null]);
      expect(afterRun.enabled).toBe(true);
      expect(afterRun.nextRunAt).not.toBeNull();
    }).pipe(Effect.provide(services));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
