import type {
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ThreadId,
  // T3-CUSTOM(expbkt3): team mode — actor/owner/member ids for invariants below.
  UserId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireActiveProjectWorkspaceRootAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceRoot: string;
  readonly exceptProjectId?: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const normalizedWorkspaceRoot = normalizeProjectPathForComparison(input.workspaceRoot);
  const existingProject = input.readModel.projects.find(
    (project) =>
      project.deletedAt === null &&
      normalizeProjectPathForComparison(project.workspaceRoot) === normalizedWorkspaceRoot &&
      project.id !== input.exceptProjectId,
  );
  if (existingProject === undefined) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Active project '${existingProject.id}' already exists for workspace root '${normalizedWorkspaceRoot}'.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

// T3-CUSTOM(expbkt3): team mode — ownership-transfer invariant.
export function requireOwnershipTransferable(input: {
  readonly commandType: string;
  readonly entityLabel: string;
  readonly ownerUserId: UserId | null;
  readonly userId: UserId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  return input.ownerUserId === input.userId
    ? Effect.fail(
        invariantError(
          input.commandType,
          `${input.entityLabel} is already owned by user '${input.userId}'.`,
        ),
      )
    : Effect.void;
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.filterOrFail(
      (thread) => thread.archivedAt !== null,
      () =>
        invariantError(
          input.command.type,
          `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
        ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.filterOrFail(
      (thread) => thread.archivedAt === null,
      () =>
        invariantError(
          input.command.type,
          `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
        ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  // Thread deletion is a soft delete and a draft keeps its client-minted id
  // across retries, so only a live row blocks creation. Projectors reset the
  // thread's rows when the id is created again.
  const existing = findThreadById(input.readModel, input.threadId);
  if (existing === undefined || existing.deletedAt !== null) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

// T3-CUSTOM(expbkt3): BEGIN — team mode add/remove membership invariants.
/**
 * Membership invariants — the creator (owner) is a permanent member: they are
 * implicitly present and can never be added or removed. Adds are rejected for
 * the owner or an existing member (idempotency is a client concern); removes are
 * rejected for the owner (creator permanence) or a non-member.
 */
export function requireMemberAddable(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly entityLabel: string;
  readonly ownerUserId: UserId | null;
  readonly memberUserIds: ReadonlyArray<UserId>;
  readonly userId: UserId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.ownerUserId === input.userId) {
    return Effect.fail(
      invariantError(
        input.commandType,
        `User '${input.userId}' owns ${input.entityLabel} and is already a permanent member.`,
      ),
    );
  }
  if (input.memberUserIds.includes(input.userId)) {
    return Effect.fail(
      invariantError(
        input.commandType,
        `User '${input.userId}' is already a member of ${input.entityLabel}.`,
      ),
    );
  }
  return Effect.void;
}

export function requireMemberRemovable(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly entityLabel: string;
  readonly ownerUserId: UserId | null;
  readonly memberUserIds: ReadonlyArray<UserId>;
  readonly userId: UserId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.ownerUserId === input.userId) {
    return Effect.fail(
      invariantError(
        input.commandType,
        `User '${input.userId}' owns ${input.entityLabel} and cannot be removed.`,
      ),
    );
  }
  if (!input.memberUserIds.includes(input.userId)) {
    return Effect.fail(
      invariantError(
        input.commandType,
        `User '${input.userId}' is not a member of ${input.entityLabel}.`,
      ),
    );
  }
  return Effect.void;
}

// T3-CUSTOM(expbkt3): END
// T3-CUSTOM(expbkt3): generic non-negative-integer guard for fork command validation.
export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
