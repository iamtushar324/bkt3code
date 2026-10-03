// T3-CUSTOM(expbkt3): native MCP tools preserve the authenticated team boundary.
import {
  OrchestratorMcpFailure,
  type ThreadId,
  type ProjectId,
  type UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { OrchestrationAccessControl } from "../orchestration-v2/Services/AccessControl.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
export const ownsForkThread = (
  thread: { readonly ownerUserId?: UserId | null; readonly memberUserIds?: ReadonlyArray<UserId> },
  scope: McpInvocationScope,
) =>
  scope.actorUserId === null ||
  scope.principal === "external-operator" ||
  thread.ownerUserId === scope.actorUserId ||
  (thread.memberUserIds ?? []).includes(scope.actorUserId);
export const requireForkThreadAccess = (
  access: Option.Option<OrchestrationAccessControl["Service"]>,
  scope: McpInvocationScope,
  threadId: ThreadId,
) =>
  scope.actorUserId === null || scope.principal === "external-operator"
    ? Effect.void
    : (Option.isSome(access)
        ? access.value
            .canAccessThread(scope.actorUserId, threadId)
            .pipe(Effect.orElseSucceed(() => false))
        : Effect.succeed(false)
      ).pipe(
        Effect.flatMap((allowed) =>
          allowed
            ? Effect.void
            : Effect.fail(
                new OrchestratorMcpFailure({
                  code: "thread_not_found",
                  message: "Thread not found.",
                }),
              ),
        ),
      );
export const requireForkProjectAccess = (
  access: Option.Option<OrchestrationAccessControl["Service"]>,
  scope: McpInvocationScope,
  projectId: ProjectId,
) =>
  scope.actorUserId === null || scope.principal === "external-operator"
    ? Effect.void
    : (Option.isSome(access)
        ? access.value
            .canAccessProject(scope.actorUserId, projectId)
            .pipe(Effect.orElseSucceed(() => false))
        : Effect.succeed(false)
      ).pipe(
        Effect.flatMap((allowed) =>
          allowed
            ? Effect.void
            : Effect.fail(
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: "Project not found.",
                }),
              ),
        ),
      );
