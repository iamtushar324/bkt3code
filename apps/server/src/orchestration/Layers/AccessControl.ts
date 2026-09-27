import { UserId, userIdFromSubject } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { isOwnerOrMember } from "../accessRules.ts";
import {
  OrchestrationAccessControl,
  type OrchestrationAccessControlShape,
} from "../Services/AccessControl.ts";

const makeAccessControl = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;

  const actorFor: OrchestrationAccessControlShape["actorFor"] = (subject, boundUserId) => {
    if (boundUserId !== null) {
      return Option.some(UserId.make(boundUserId));
    }
    const userId = userIdFromSubject(subject);
    return userId === null ? Option.none() : Option.some(userId);
  };

  const canAccessThread: OrchestrationAccessControlShape["canAccessThread"] = (userId, threadId) =>
    Effect.gen(function* () {
      // Archived threads must stay authorizable — otherwise unarchive/delete on
      // one's own archived thread reads back as "not found".
      const threadOption = yield* snapshotQuery.getThreadAccessById(threadId);
      if (Option.isNone(threadOption)) {
        return false;
      }
      // Thread access = own it or be tagged on it directly. Project membership
      // does not grant access to a project's threads.
      return isOwnerOrMember(threadOption.value, userId);
    });

  const canAccessProject: OrchestrationAccessControlShape["canAccessProject"] = (
    userId,
    projectId,
  ) =>
    Effect.gen(function* () {
      const projectOption = yield* snapshotQuery.getProjectShellById(projectId);
      if (Option.isNone(projectOption)) {
        return false;
      }
      if (isOwnerOrMember(projectOption.value, userId)) {
        return true;
      }
      // Project also "appears" (and is manageable) when it contains a thread
      // the user can see directly.
      const threads = yield* snapshotQuery.listThreadShellsByProjectId(projectId);
      return threads.some((thread) => isOwnerOrMember(thread, userId));
    });

  const canTransferThreadOwnership: OrchestrationAccessControlShape["canTransferThreadOwnership"] =
    (userId, threadId) =>
      snapshotQuery.getThreadAccessById(threadId).pipe(
        Effect.map(
          Option.match({
            onNone: () => false,
            onSome: (thread) =>
              thread.ownerUserId === userId ||
              (thread.ownerUserId === null && thread.memberUserIds.includes(userId)),
          }),
        ),
      );

  const canTransferProjectOwnership: OrchestrationAccessControlShape["canTransferProjectOwnership"] =
    (userId, projectId) =>
      snapshotQuery.getProjectShellById(projectId).pipe(
        Effect.map(
          Option.match({
            onNone: () => false,
            onSome: (project) =>
              project.ownerUserId === userId ||
              (project.ownerUserId === null && project.memberUserIds.includes(userId)),
          }),
        ),
      );

  return {
    actorFor,
    canAccessThread,
    canAccessProject,
    canTransferThreadOwnership,
    canTransferProjectOwnership,
  } satisfies OrchestrationAccessControlShape;
});

export const OrchestrationAccessControlLive = Layer.effect(
  OrchestrationAccessControl,
  makeAccessControl,
);
