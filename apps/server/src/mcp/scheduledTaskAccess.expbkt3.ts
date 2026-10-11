// T3-CUSTOM(expbkt3): which scheduled tasks an MCP caller may see and change.
//
// Upstream lists every task to every caller. In team mode that showed one
// person's prompts and webhook URLs to everyone, so a caller acting for a user
// sees the tasks that user owns (the fork options record an owner), the tasks
// that send into a session the user can see, and ownerless tasks (made in the
// app or before owners were recorded) that start sessions in a project the
// user can use. An operator, or a client acting for no user, sees all of them.
import type { ScheduledTask } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { OrchestrationAccessControl } from "../orchestration-v2/Services/AccessControl.ts";
import {
  scheduledTaskForkOptionsForRun,
  type ScheduledTaskForkOptions,
} from "../scheduledTasks/scheduledTaskForkOptions.expbkt3.ts";
import { ownsForkThread, requireForkProjectAccess } from "./forkAccess.expbkt3.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export const seesEveryScheduledTask = (scope: McpInvocationScope) =>
  scope.actorUserId === null || scope.principal === "external-operator";

/** The rule, given what it reads. */
export const mayManageScheduledTask = (input: {
  readonly scope: McpInvocationScope;
  readonly task: Pick<ScheduledTask, "threadId">;
  readonly options: ScheduledTaskForkOptions;
  /** The session the task sends into, when it has one and it still exists. */
  readonly boundThread: Parameters<typeof ownsForkThread>[0] | null;
  /** Whether the caller may use the task's project. */
  readonly projectAccessible: boolean;
}): boolean =>
  seesEveryScheduledTask(input.scope) ||
  (input.options.ownerUserId !== undefined &&
    input.options.ownerUserId === input.scope.actorUserId) ||
  (input.task.threadId !== null &&
    input.boundThread !== null &&
    ownsForkThread(input.boundThread, input.scope)) ||
  (input.options.ownerUserId === undefined &&
    input.task.threadId === null &&
    input.projectAccessible);

/** Reads what the rule needs for one task and applies it. Never fails: unreadable means hidden. */
export const callerMayManageScheduledTask = (input: {
  readonly scope: McpInvocationScope;
  readonly task: ScheduledTask;
  readonly sql: Option.Option<SqlClient.SqlClient>;
  readonly threads: Pick<ThreadManagementService.ThreadManagementServiceShape, "getThreadShell">;
  readonly access: Option.Option<OrchestrationAccessControl["Service"]>;
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const { scope, task } = input;
    if (seesEveryScheduledTask(scope)) return true;
    const options = Option.isNone(input.sql)
      ? {}
      : yield* scheduledTaskForkOptionsForRun(input.sql.value, task.id);
    const boundThread =
      task.threadId === null
        ? null
        : yield* input.threads.getThreadShell(task.threadId).pipe(
            Effect.map((shell) => (shell === null || shell.deletedAt !== null ? null : shell)),
            Effect.orElseSucceed(() => null),
          );
    const projectAccessible =
      task.threadId === null && options.ownerUserId === undefined
        ? yield* requireForkProjectAccess(input.access, scope, task.projectId).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
        : false;
    return mayManageScheduledTask({ scope, task, options, boundThread, projectAccessible });
  });
