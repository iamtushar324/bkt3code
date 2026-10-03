import {
  type CommandId,
  type EventId,
  MAX_SCRIPT_ID_LENGTH,
  type ModelSelection,
  type ProjectIconOverride,
  ProjectId,
  type ProjectScript,
  SCRIPT_RUN_COMMAND_PATTERN,
  type ThreadEnvMode,
  // T3-CUSTOM(expbkt3): project owners and members.
  type UserId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { UnsequencedProjectEvent } from "../persistence/Services/OrchestrationEventStore.ts";
import type { ProjectRow } from "./ProjectStore.ts";

export interface ProjectCreateCommand {
  // T3-CUSTOM(expbkt3): transport supplies the authenticated creator.
  readonly actorUserId?: UserId | null | undefined;
  readonly type: "project.create";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly scripts?: ReadonlyArray<ProjectScript> | undefined;
}

export interface ProjectMetaUpdateCommand {
  readonly type: "project.meta.update";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  // T3-CUSTOM(expbkt3): compatibility commands may contain explicit undefined option fields.
  readonly title?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly defaultModelSelection?: ModelSelection | null | undefined;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null | undefined;
  readonly autoPull?: boolean | undefined;
  readonly faviconPath?: string | null | undefined;
  readonly projectIcon?: ProjectIconOverride | null | undefined;
  readonly scripts?: ReadonlyArray<ProjectScript> | undefined;
}

export interface ProjectDeleteCommand {
  readonly type: "project.delete";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

// T3-CUSTOM(expbkt3): project access changes use the native project receipt/lock path.
export interface ProjectAccessCommand {
  readonly type: "project.member.add" | "project.member.remove" | "project.owner.transfer";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly userId: UserId;
  readonly actorUserId?: UserId | null | undefined;
}
export type ProjectCommand =
  | ProjectCreateCommand
  | ProjectMetaUpdateCommand
  | ProjectDeleteCommand
  | ProjectAccessCommand;

export class ProjectCommandInvariantError extends Schema.TaggedError<ProjectCommandInvariantError>()(
  "ProjectCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Project command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

/** The command targets a project that does not exist or was deleted. */
export class ProjectCommandMissingProjectError extends Schema.TaggedError<ProjectCommandMissingProjectError>()(
  "ProjectCommandMissingProjectError",
  {
    commandType: Schema.String,
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist for command '${this.commandType}'.`;
  }
}

export class ProjectWorkspaceConflictError extends Schema.TaggedError<ProjectWorkspaceConflictError>()(
  "ProjectWorkspaceConflictError",
  {
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Active project '${this.conflictingProjectId}' already exists for workspace root '${this.workspaceRoot}'.`;
  }
}

export const ProjectCommandRejection = Schema.Union([
  ProjectCommandInvariantError,
  ProjectCommandMissingProjectError,
  ProjectWorkspaceConflictError,
]);
export type ProjectCommandRejection = typeof ProjectCommandRejection.Type;

const ProjectCommandRejectionJson = Schema.fromJsonString(ProjectCommandRejection);
/**
 * A rejected receipt stores its rejection as JSON, so a retried command id
 * replays the same typed error even when a fresh plan would now succeed.
 */
export const encodeProjectCommandRejection = Schema.encodeSync(ProjectCommandRejectionJson);
/** None for receipts that predate structured rejections. */
export const decodeProjectCommandRejection = Schema.decodeUnknownOption(
  ProjectCommandRejectionJson,
);

export interface ProjectCommandState {
  /** The target project's row, including a soft-deleted one; only create sees deleted rows as taken. */
  readonly project: ProjectRow | undefined;
  /** The active project that holds the command's requested workspace root, if any. */
  readonly workspaceOwner: ProjectRow | undefined;
}

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

/**
 * Decide one project command against the rows it touches. The caller reads
 * `state` under the project's lock and commits the planned event.
 */
export function planProjectCommand(input: {
  readonly command: ProjectCommand;
  readonly state: ProjectCommandState;
  readonly eventId: EventId;
  readonly now: DateTime.Utc;
}): Result.Result<UnsequencedProjectEvent, ProjectCommandRejection> {
  const { command, state } = input;
  const invariant = (detail: string) =>
    Result.fail(new ProjectCommandInvariantError({ commandType: command.type, detail }));
  const missingProject = () =>
    Result.fail(
      new ProjectCommandMissingProjectError({
        commandType: command.type,
        projectId: command.projectId,
      }),
    );
  const activeProject = state.project?.deletedAt === null ? state.project : undefined;
  const requireWorkspaceAvailable = (workspaceRoot: string) =>
    state.workspaceOwner === undefined || state.workspaceOwner.projectId === command.projectId
      ? undefined
      : new ProjectWorkspaceConflictError({
          workspaceRoot,
          conflictingProjectId: state.workspaceOwner.projectId,
        });
  const occurredAt = DateTime.formatIso(input.now);
  const base = {
    eventId: input.eventId,
    aggregateKind: "project" as const,
    aggregateId: command.projectId,
    occurredAt,
    commandId: command.commandId,
    causationEventId: null,
    correlationId: command.commandId,
    // T3-CUSTOM(expbkt3): access audit retains the acting user.
    metadata: {
      ...("actorUserId" in command && command.actorUserId != null
        ? { actorUserId: command.actorUserId }
        : {}),
    },
  };

  switch (command.type) {
    // T3-CUSTOM(expbkt3): ownership and membership stay in application project events.
    case "project.member.add": {
      if (activeProject === undefined) return missingProject();
      if ((activeProject.memberUserIds ?? []).includes(command.userId))
        return invariant("The user is already a project member.");
      return Result.succeed({
        ...base,
        type: "project.member-added",
        payload: { projectId: command.projectId, userId: command.userId, updatedAt: occurredAt },
      });
    }
    case "project.member.remove": {
      if (activeProject === undefined) return missingProject();
      if (activeProject.ownerUserId === command.userId)
        return invariant("Transfer ownership before you remove the owner.");
      if (!(activeProject.memberUserIds ?? []).includes(command.userId))
        return invariant("The user is not a project member.");
      return Result.succeed({
        ...base,
        type: "project.member-removed",
        payload: { projectId: command.projectId, userId: command.userId, updatedAt: occurredAt },
      });
    }
    case "project.owner.transfer": {
      if (activeProject === undefined) return missingProject();
      if (activeProject.ownerUserId === command.userId)
        return invariant("The user already owns the project.");
      return Result.succeed({
        ...base,
        type: "project.owner-transferred",
        payload: {
          projectId: command.projectId,
          userId: command.userId,
          previousOwnerUserId: activeProject.ownerUserId ?? null,
          updatedAt: occurredAt,
        },
      });
    }
    case "project.create": {
      if (state.project !== undefined) {
        return invariant(
          `Project '${command.projectId}' already exists and cannot be created twice.`,
        );
      }
      const conflict = requireWorkspaceAvailable(command.workspaceRoot);
      if (conflict !== undefined) return Result.fail(conflict);
      return Result.succeed({
        ...base,
        type: "project.created",
        payload: {
          // T3-CUSTOM(expbkt3): seed durable project ownership.
          createdByUserId: command.actorUserId ?? null,
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          // Project creation has no user model choice. Older clients sent an
          // automatic seed, but only a metadata update records an explicit default.
          defaultModelSelection: null,
          faviconPath: null,
          projectIcon: null,
          scripts: command.scripts ?? [],
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      });
    }

    case "project.meta.update": {
      const project = activeProject;
      if (project === undefined) return missingProject();
      if (
        command.projectIcon?.kind === "monogram" &&
        Array.from(monogramSegmenter.segment(command.projectIcon.text)).length > 2
      ) {
        return invariant("Project monograms must contain at most two characters.");
      }
      if (command.scripts !== undefined) {
        // Persisted IDs predate shortcut validation. Let users edit or remove them
        // without allowing another invalid ID to enter the project.
        const existingIds = new Set(project.scripts.map((script) => script.id));
        for (const script of command.scripts) {
          if (!existingIds.has(script.id) && !isScriptRunCommand(`script.${script.id}.run`)) {
            // The raw ID is unbounded user input and this detail is persisted.
            return invariant(
              `Script IDs must be 1-${MAX_SCRIPT_ID_LENGTH} lowercase letters, digits or hyphens, starting with a letter or digit (got ${script.id.length} characters).`,
            );
          }
        }
      }
      if (command.workspaceRoot !== undefined) {
        const conflict = requireWorkspaceAvailable(command.workspaceRoot);
        if (conflict !== undefined) return Result.fail(conflict);
      }
      return Result.succeed({
        ...base,
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.workspaceRoot === undefined ? {} : { workspaceRoot: command.workspaceRoot }),
          ...(command.defaultModelSelection === undefined
            ? {}
            : { defaultModelSelection: command.defaultModelSelection }),
          ...(command.defaultThreadEnvMode === undefined
            ? {}
            : { defaultThreadEnvMode: command.defaultThreadEnvMode }),
          ...(command.autoPull === undefined ? {} : { autoPull: command.autoPull }),
          ...(command.faviconPath === undefined ? {} : { faviconPath: command.faviconPath }),
          ...(command.projectIcon === undefined ? {} : { projectIcon: command.projectIcon }),
          ...(command.scripts === undefined ? {} : { scripts: command.scripts }),
          updatedAt: occurredAt,
        },
      });
    }

    case "project.delete": {
      if (activeProject === undefined) return missingProject();
      // Thread children are deleted by ProjectService before this event commits.
      return Result.succeed({
        ...base,
        type: "project.deleted",
        payload: { projectId: command.projectId, deletedAt: occurredAt },
      });
    }
  }
}
