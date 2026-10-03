/**
 * T3-CUSTOM(expbkt3): Per-connection access control for the websocket layer.
 *
 * Team mode filters what a connected operator may see and command. These
 * closures were inlined in `makeWsRpcLayer`; they are pure functions of the
 * projection snapshot query, the access-control service and the connection's
 * actor, so they live here and `ws.ts` binds them in one marked seam.
 *
 * Behaviour is intentionally identical to the inlined originals — denials read
 * as "not found" so thread/project existence never leaks.
 */
import {
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationAccessControl } from "./Services/AccessControl.ts";
import { filterShellSnapshot, isOwnerOrMember } from "./accessRules.ts";
import { checkCommandAccess } from "./commandAccess.ts";

export interface WsVisibilityDeps {
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly accessControl: OrchestrationAccessControl["Service"];
  /** The Clerk operator on this connection, or null when unrestricted. */
  readonly actorUserId: UserId | null;
  readonly actorIsAdmin: boolean;
}

export const makeWsVisibility = ({
  projectionSnapshotQuery,
  accessControl,
  actorUserId,
  actorIsAdmin,
}: WsVisibilityDeps) => {
  // The set of thread/project ids the operator may see (active + archived),
  // derived from the filtered shell snapshots. Used to filter raw event
  // replays.
  const visibleAggregateIdsForActor = (userId: UserId) =>
    Effect.all([
      projectionSnapshotQuery.getShellSnapshot(),
      projectionSnapshotQuery.getArchivedShellSnapshot(),
    ]).pipe(
      Effect.map(([activeSnapshot, archivedSnapshot]) => {
        const active = filterShellSnapshot(activeSnapshot, userId);
        const archived = filterShellSnapshot(archivedSnapshot, userId);
        const threadIds = new Set<string>([
          ...active.threads.map((thread) => thread.id),
          ...archived.threads.map((thread) => thread.id),
        ]);
        const projectIds = new Set<string>([
          ...active.projects.map((project) => project.id),
          ...archived.projects.map((project) => project.id),
        ]);
        return { threadIds, projectIds };
      }),
    );
  // Guard a per-thread read; denials read as "not found" (no existence leak)
  // and are re-wrapped into each caller's error type.
  const requireThreadAccess = (
    threadId: ThreadId,
  ): Effect.Effect<void, OrchestrationGetSnapshotError> =>
    actorUserId === null
      ? Effect.void
      : accessControl.canAccessThread(actorUserId, threadId).pipe(
          Effect.orElseSucceed(() => false),
          Effect.flatMap((allowed) =>
            allowed
              ? Effect.void
              : Effect.fail(
                  new OrchestrationGetSnapshotError({
                    message: `Thread ${threadId} was not found`,
                    cause: threadId,
                  }),
                ),
          ),
        );

  // Team mode: transform a global shell delta into what the operating user
  // may see. A thread/project that becomes visible (e.g. the user is tagged)
  // is forwarded as an upsert — for a project tag we also emit upserts for
  // all of the project's now-visible threads. A thread/project that is no
  // longer visible (untagged) is converted to a removal so it disappears
  // live from the sidebar. Removals pass through unchanged.
  const shellEventsForActor = (
    event: OrchestrationShellStreamEvent,
    userId: UserId,
  ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamEvent>, never, never> => {
    switch (event.kind) {
      case "thread-removed":
      case "project-removed":
        return Effect.succeed([event]);
      case "thread-upserted": {
        const thread = event.thread;
        // A thread is delivered only if the user owns it or is tagged on it
        // directly (project membership does not reveal threads). When it is
        // visible, resolve the parent project so the thread arrives together
        // with its container shell — otherwise it lands in the sidebar with
        // no project to group under ("unknown project").
        if (!isOwnerOrMember(thread, userId)) {
          return Effect.succeed([
            {
              kind: "thread-removed" as const,
              sequence: event.sequence,
              threadId: thread.id,
            },
          ]);
        }
        return projectionSnapshotQuery.getProjectShellById(thread.projectId).pipe(
          Effect.map((projectOption) => {
            const project = Option.getOrNull(projectOption);
            return project !== null
              ? [{ kind: "project-upserted" as const, sequence: event.sequence, project }, event]
              : [event];
          }),
          Effect.orElseSucceed(() => [event]),
        );
      }
      case "project-upserted": {
        const project = event.project;
        const directlyVisible = isOwnerOrMember(project, userId);
        if (directlyVisible) {
          // Owner/member: the project is visible. Do NOT fan out its threads
          // — a project tag grants workspace access, not thread visibility.
          return Effect.succeed([event]);
        }
        // Otherwise the project only appears if it contains a thread the user
        // can see directly; if not, remove it from their sidebar.
        return projectionSnapshotQuery.listThreadShellsByProjectId(project.id).pipe(
          Effect.map((threads) => {
            const hasVisibleThread = threads.some((thread) => isOwnerOrMember(thread, userId));
            if (hasVisibleThread) {
              return [event];
            }
            return [
              {
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: project.id,
              },
            ];
          }),
          Effect.orElseSucceed(() =>
            directlyVisible
              ? [event]
              : [
                  {
                    kind: "project-removed" as const,
                    sequence: event.sequence,
                    projectId: project.id,
                  },
                ],
          ),
        );
      }
    }
  };

  // Wrap a shell-event stream with per-user visibility (no-op for an
  // unrestricted operator).
  const applyShellVisibility = <E, R>(
    stream: Stream.Stream<OrchestrationShellStreamEvent, E, R>,
  ): Stream.Stream<OrchestrationShellStreamEvent, E, R> =>
    actorUserId === null
      ? stream
      : stream.pipe(
          Stream.mapEffect((event) => shellEventsForActor(event, actorUserId)),
          Stream.flatMap((events) => Stream.fromIterable(events)),
        );

  const applyShellItemVisibility = <E, R>(
    stream: Stream.Stream<OrchestrationShellStreamItem, E, R>,
  ): Stream.Stream<OrchestrationShellStreamItem, E, R> =>
    actorUserId === null
      ? stream
      : stream.pipe(
          Stream.mapEffect(
            (item): Effect.Effect<ReadonlyArray<OrchestrationShellStreamItem>, never, never> => {
              switch (item.kind) {
                case "project-upserted":
                case "project-removed":
                case "thread-upserted":
                case "thread-removed":
                  return shellEventsForActor(item, actorUserId);
                case "snapshot":
                  return Effect.succeed<ReadonlyArray<OrchestrationShellStreamItem>>([
                    {
                      ...item,
                      snapshot: filterShellSnapshot(item.snapshot, actorUserId),
                    },
                  ]);
                case "synchronized":
                  return Effect.succeed<ReadonlyArray<OrchestrationShellStreamItem>>([item]);
              }
            },
          ),
          Stream.flatMap((items) => Stream.fromIterable(items)),
        );

  const authorizeNormalizedCommand = (normalizedCommand: OrchestrationCommand) =>
    Effect.gen(function* () {
      // Team mode: reject commands on threads/projects this operator can't
      // access before they reach the engine.
      if (actorUserId !== null) {
        const allowed = yield* checkCommandAccess(
          accessControl,
          actorUserId,
          actorIsAdmin,
          normalizedCommand,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: "Failed to authorize orchestration command",
                cause,
              }),
          ),
        );
        if (!allowed) {
          // Reads as "not found" — no existence leak.
          return yield* new OrchestrationDispatchCommandError({
            message: "Thread or project not found.",
            cause: normalizedCommand.type,
          });
        }
      }
    });

  return {
    visibleAggregateIdsForActor,
    requireThreadAccess,
    shellEventsForActor,
    applyShellVisibility,
    applyShellItemVisibility,
    authorizeNormalizedCommand,
  };
};
