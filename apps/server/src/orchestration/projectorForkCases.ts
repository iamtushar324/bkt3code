/**
 * T3-CUSTOM(expbkt3): Fork orchestration event projections.
 *
 * Membership/ownership and thread source-control identity.
 * Upstream's `projectEvent` delegates here through a single type-narrowing
 * guard. `decodeForEvent` and `updateThread` are passed in rather than imported
 * so this module stays below `projector.ts` in the import graph.
 */
import {
  ProjectMemberAddedPayload,
  ProjectMemberRemovedPayload,
  ProjectOwnerTransferredPayload,
  ThreadMemberAddedPayload,
  ThreadMemberRemovedPayload,
  ThreadOwnerTransferredPayload,
  ThreadSourceControlProfileSetPayload,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import type { OrchestrationProjectorDecodeError } from "./Errors.ts";

const FORK_EVENT_TYPES = [
  "thread.member-added",
  "thread.member-removed",
  "thread.owner-transferred",
  "project.member-added",
  "project.member-removed",
  "project.owner-transferred",
  "thread.source-control-profile-set",
] as const;

export type ForkOrchestrationEvent = Extract<
  OrchestrationEvent,
  { readonly type: (typeof FORK_EVENT_TYPES)[number] }
>;

const FORK_EVENT_TYPE_SET: ReadonlySet<string> = new Set(FORK_EVENT_TYPES);

export function isForkOrchestrationEvent(
  event: OrchestrationEvent,
): event is ForkOrchestrationEvent {
  return FORK_EVENT_TYPE_SET.has(event.type);
}

type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId">>;

/** Projector-local helpers handed to the fork cases. */
export interface ForkProjectorInternals {
  readonly decodeForEvent: <A>(
    schema: Schema.Decoder<A, never>,
    value: unknown,
    eventType: OrchestrationEvent["type"],
    field: string,
  ) => Effect.Effect<A, OrchestrationProjectorDecodeError>;
  readonly updateThread: (
    threads: ReadonlyArray<OrchestrationThread>,
    threadId: ThreadId,
    patch: ThreadPatch,
  ) => ReadonlyArray<OrchestrationThread>;
}

export function projectForkEvent(
  nextBase: OrchestrationReadModel,
  event: ForkOrchestrationEvent,
  internals: ForkProjectorInternals,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const { decodeForEvent, updateThread } = internals;
  switch (event.type) {
    case "thread.member-added":
      return decodeForEvent(ThreadMemberAddedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread || thread.memberUserIds.includes(payload.userId)) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              memberUserIds: [...thread.memberUserIds, payload.userId],
              updatedAt: payload.addedAt,
            }),
          };
        }),
      );

    case "thread.member-removed":
      return decodeForEvent(ThreadMemberRemovedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              memberUserIds: thread.memberUserIds.filter((id) => id !== payload.userId),
              updatedAt: payload.removedAt,
            }),
          };
        }),
      );

    case "thread.owner-transferred":
      return decodeForEvent(
        ThreadOwnerTransferredPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }
          const memberUserIds = thread.memberUserIds.filter((id) => id !== payload.ownerUserId);
          if (
            payload.previousOwnerUserId !== null &&
            payload.previousOwnerUserId !== payload.ownerUserId &&
            !memberUserIds.includes(payload.previousOwnerUserId)
          ) {
            memberUserIds.push(payload.previousOwnerUserId);
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ownerUserId: payload.ownerUserId,
              memberUserIds,
              updatedAt: payload.transferredAt,
            }),
          };
        }),
      );

    case "project.member-added":
      return decodeForEvent(ProjectMemberAddedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const project = nextBase.projects.find((entry) => entry.id === payload.projectId);
          if (!project || project.memberUserIds.includes(payload.userId)) {
            return nextBase;
          }
          return {
            ...nextBase,
            projects: nextBase.projects.map((entry) =>
              entry.id === payload.projectId
                ? {
                    ...entry,
                    memberUserIds: [...entry.memberUserIds, payload.userId],
                    updatedAt: payload.addedAt,
                  }
                : entry,
            ),
          };
        }),
      );

    case "project.member-removed":
      return decodeForEvent(ProjectMemberRemovedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const project = nextBase.projects.find((entry) => entry.id === payload.projectId);
          if (!project) {
            return nextBase;
          }
          return {
            ...nextBase,
            projects: nextBase.projects.map((entry) =>
              entry.id === payload.projectId
                ? {
                    ...entry,
                    memberUserIds: entry.memberUserIds.filter((id) => id !== payload.userId),
                    updatedAt: payload.removedAt,
                  }
                : entry,
            ),
          };
        }),
      );

    case "project.owner-transferred":
      return decodeForEvent(
        ProjectOwnerTransferredPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const project = nextBase.projects.find((entry) => entry.id === payload.projectId);
          if (!project) {
            return nextBase;
          }
          const memberUserIds = project.memberUserIds.filter((id) => id !== payload.ownerUserId);
          if (
            payload.previousOwnerUserId !== null &&
            payload.previousOwnerUserId !== payload.ownerUserId &&
            !memberUserIds.includes(payload.previousOwnerUserId)
          ) {
            memberUserIds.push(payload.previousOwnerUserId);
          }
          return {
            ...nextBase,
            projects: nextBase.projects.map((entry) =>
              entry.id === payload.projectId
                ? {
                    ...entry,
                    ownerUserId: payload.ownerUserId,
                    memberUserIds,
                    updatedAt: payload.transferredAt,
                  }
                : entry,
            ),
          };
        }),
      );

    case "thread.source-control-profile-set":
      return decodeForEvent(
        ThreadSourceControlProfileSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            sourceControlProfileId: payload.sourceControlProfileId,
            updatedAt: payload.changedAt,
          }),
        })),
      );
  }
}
