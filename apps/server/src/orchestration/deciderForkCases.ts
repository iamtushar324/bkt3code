/**
 * T3-CUSTOM(expbkt3): Fork orchestration command decisions.
 *
 * Membership/ownership transfer, thread source-control identity, session
 * restart, catch-up summaries and bulk-session-manager work summaries.
 * Upstream's `decideOrchestrationCommand`
 * delegates here through a single type-narrowing guard, so the upstream switch
 * keeps its exhaustive `command satisfies never` default.
 */
import {
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type UserId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  requireMemberAddable,
  requireMemberRemovable,
  requireOwnershipTransferable,
  requireProject,
  requireThread,
} from "./commandInvariants.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const FORK_COMMAND_TYPES = [
  "thread.member.add",
  "thread.member.remove",
  "thread.owner.transfer",
  "project.member.add",
  "project.member.remove",
  "project.owner.transfer",
  "thread.source-control-profile.set",
  "thread.session.restart",
] as const;

export type ForkOrchestrationCommand = Extract<
  OrchestrationCommand,
  { readonly type: (typeof FORK_COMMAND_TYPES)[number] }
>;

const FORK_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(FORK_COMMAND_TYPES);

export function isForkOrchestrationCommand(
  command: OrchestrationCommand,
): command is ForkOrchestrationCommand {
  return FORK_COMMAND_TYPE_SET.has(command.type);
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

/**
 * Builds the immutable prefix every planned event carries. Passed in from the
 * decider rather than imported so this module stays below it in the import
 * graph.
 */
export type WithEventBase = (
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
) => Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
>;

export const decideForkOrchestrationCommand = Effect.fn("decideForkOrchestrationCommand")(
  function* ({
    command,
    readModel,
    actor,
    withEventBase,
  }: {
    readonly command: ForkOrchestrationCommand;
    readonly readModel: OrchestrationReadModel;
    readonly actor: UserId | null;
    readonly withEventBase: WithEventBase;
  }): Effect.fn.Return<
    PlannedOrchestrationEvent,
    OrchestrationCommandInvariantError | PlatformError.PlatformError,
    Crypto.Crypto
  > {
    switch (command.type) {
      case "thread.member.add": {
        const thread = yield* requireThread({
          readModel,
          command,
          threadId: command.threadId,
        });
        yield* requireMemberAddable({
          commandType: command.type,
          entityLabel: `thread '${command.threadId}'`,
          ownerUserId: thread.ownerUserId,
          memberUserIds: thread.memberUserIds,
          userId: command.userId,
        });
        const occurredAt = yield* nowIso;
        return {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.member-added",
          payload: {
            threadId: command.threadId,
            userId: command.userId,
            addedByUserId: actor,
            addedAt: occurredAt,
          },
        };
      }
      case "thread.member.remove": {
        const thread = yield* requireThread({
          readModel,
          command,
          threadId: command.threadId,
        });
        yield* requireMemberRemovable({
          commandType: command.type,
          entityLabel: `thread '${command.threadId}'`,
          ownerUserId: thread.ownerUserId,
          memberUserIds: thread.memberUserIds,
          userId: command.userId,
        });
        const occurredAt = yield* nowIso;
        return {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.member-removed",
          payload: {
            threadId: command.threadId,
            userId: command.userId,
            removedByUserId: actor,
            removedAt: occurredAt,
          },
        };
      }
      case "thread.owner.transfer": {
        const thread = yield* requireThread({
          readModel,
          command,
          threadId: command.threadId,
        });
        yield* requireOwnershipTransferable({
          commandType: command.type,
          entityLabel: `thread '${command.threadId}'`,
          ownerUserId: thread.ownerUserId,
          userId: command.userId,
        });
        const occurredAt = yield* nowIso;
        return {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.owner-transferred",
          payload: {
            threadId: command.threadId,
            previousOwnerUserId: thread.ownerUserId,
            ownerUserId: command.userId,
            transferredByUserId: actor,
            transferredAt: occurredAt,
          },
        };
      }
      case "project.member.add": {
        const project = yield* requireProject({
          readModel,
          command,
          projectId: command.projectId,
        });
        yield* requireMemberAddable({
          commandType: command.type,
          entityLabel: `project '${command.projectId}'`,
          ownerUserId: project.ownerUserId,
          memberUserIds: project.memberUserIds,
          userId: command.userId,
        });
        const occurredAt = yield* nowIso;
        return {
          ...(yield* withEventBase({
            aggregateKind: "project",
            aggregateId: command.projectId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "project.member-added",
          payload: {
            projectId: command.projectId,
            userId: command.userId,
            addedByUserId: actor,
            addedAt: occurredAt,
          },
        };
      }
      case "project.member.remove": {
        const project = yield* requireProject({
          readModel,
          command,
          projectId: command.projectId,
        });
        yield* requireMemberRemovable({
          commandType: command.type,
          entityLabel: `project '${command.projectId}'`,
          ownerUserId: project.ownerUserId,
          memberUserIds: project.memberUserIds,
          userId: command.userId,
        });
        const occurredAt = yield* nowIso;
        return {
          ...(yield* withEventBase({
            aggregateKind: "project",
            aggregateId: command.projectId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "project.member-removed",
          payload: {
            projectId: command.projectId,
            userId: command.userId,
            removedByUserId: actor,
            removedAt: occurredAt,
          },
        };
      }
      case "project.owner.transfer": {
        const project = yield* requireProject({
          readModel,
          command,
          projectId: command.projectId,
        });
        yield* requireOwnershipTransferable({
          commandType: command.type,
          entityLabel: `project '${command.projectId}'`,
          ownerUserId: project.ownerUserId,
          userId: command.userId,
        });
        const occurredAt = yield* nowIso;
        return {
          ...(yield* withEventBase({
            aggregateKind: "project",
            aggregateId: command.projectId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "project.owner-transferred",
          payload: {
            projectId: command.projectId,
            previousOwnerUserId: project.ownerUserId,
            ownerUserId: command.userId,
            transferredByUserId: actor,
            transferredAt: occurredAt,
          },
        };
      }
      case "thread.source-control-profile.set": {
        const thread = yield* requireThread({
          readModel,
          command,
          threadId: command.threadId,
        });
        if (
          thread.latestTurn?.state === "running" ||
          thread.session?.status === "starting" ||
          thread.session?.status === "running"
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} is busy and its source-control owner cannot change`,
          });
        }
        return {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.source-control-profile-set",
          payload: {
            threadId: command.threadId,
            previousSourceControlProfileId: thread.sourceControlProfileId,
            sourceControlProfileId: command.sourceControlProfileId,
            changedAt: command.createdAt,
          },
        };
      }
      case "thread.session.restart": {
        yield* requireThread({
          readModel,
          command,
          threadId: command.threadId,
        });
        return {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.session-restart-requested",
          payload: {
            threadId: command.threadId,
            createdAt: command.createdAt,
          },
        };
      }
      default: {
        command satisfies never;
        const fallback = command as never as { type: string };
        return yield* new OrchestrationCommandInvariantError({
          commandType: fallback.type,
          detail: `Unknown fork command type: ${fallback.type}`,
        });
      }
    }
  },
);
