import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { cleanupFailedUploadedAttachments, normalizeDispatchCommand } from "./Normalizer.ts";
// T3-CUSTOM(expbkt3): BEGIN — bootstrap turn starts + delegated thread ownership.
import { TurnStartBootstrap } from "./turnStartBootstrap.expbkt3.ts";
// T3-CUSTOM(expbkt3): actorless trusted HTTP callers may delegate thread ownership.
import { resolveDelegatedThreadOwner } from "./DelegatedThreadOwnership.ts";
// T3-CUSTOM(expbkt3): END
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { OrchestrationAccessControl } from "./Services/AccessControl.ts";
import { filterReadModel, filterShellSnapshot } from "./accessRules.ts";
import { checkCommandAccess } from "./commandAccess.ts";
import { ClerkDirectory } from "../auth/ClerkDirectory.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { discoverPullRequestLinks } from "../sourceControl/PullRequestLinkDiscovery.ts";

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const turnStartBootstrap = yield* TurnStartBootstrap;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const accessControl = yield* OrchestrationAccessControl;
    const clerkDirectory = yield* ClerkDirectory;
    const providerRegistry = yield* ProviderRegistry;
    const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
    const projectCloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;

    // Resolve the operating durable user, or null for an unrestricted local operator.
    const currentActorUserId = Effect.gen(function* () {
      const principal = yield* EnvironmentAuthenticatedPrincipal;
      // T3-CUSTOM(expbkt3): A browser identity bind updates userId without
      // rewriting the original one-time-token subject.
      return Option.getOrNull(accessControl.actorFor(principal.subject, principal.userId));
    });

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const actorUserId = yield* currentActorUserId;
          // Serve the lightweight command read model (thread bodies empty)
          // instead of the fully hydrated snapshot. Hydrating every message
          // and activity payload in the database has OOM-killed servers, and
          // the route's only consumer (the project CLI) reads projects alone —
          // UI clients load the shell and per-thread snapshots instead.
          const snapshot = yield* projectionSnapshotQuery
            .getCommandReadModel()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
          // T3-CUSTOM(expbkt3): keep per-actor filtering on this route so the
          // multi-user deployment cannot leak other operators' projects and
          // threads. Executions are intentionally not attached here, matching
          // upstream: this read model carries no thread bodies.
          return actorUserId === null ? snapshot : filterReadModel(snapshot, actorUserId);
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const actorUserId = yield* currentActorUserId;
          const snapshot = yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
          return actorUserId === null ? snapshot : filterShellSnapshot(snapshot, actorUserId);
        }),
      )
      .handle(
        "providers",
        Effect.fn("environment.orchestration.providers")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* providerRegistry.getProviders;
        }),
      )
      .handle(
        "users",
        Effect.fn("environment.orchestration.users")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // Backs the tagging UI. Serves a stale cache on a Clerk outage, and
          // an empty list in single-user mode (Clerk disabled).
          const users = yield* clerkDirectory
            .listOrgMembers()
            .pipe(Effect.catch(() => Effect.succeed([])));
          return { users };
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const actorUserId = yield* currentActorUserId;
          // Deny inaccessible threads as "not found" (no existence leak).
          if (actorUserId !== null) {
            const accessible = yield* accessControl
              .canAccessThread(actorUserId, args.params.threadId)
              .pipe(
                Effect.catch((cause) =>
                  failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
                ),
              );
            if (!accessible) {
              return yield* failEnvironmentNotFound("thread_not_found");
            }
          }
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(
              args.params.threadId,
              args.payload.turnLimit === undefined
                ? undefined
                : {
                    turnLimit: args.payload.turnLimit,
                    ...(args.payload.beforeCursor !== undefined
                      ? { beforeCursor: args.payload.beforeCursor }
                      : {}),
                  },
            )
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(
            snapshot.value,
            args.payload.reasoningMessages === "true",
          );
        }),
      )
      .handle(
        "pullRequestLinks",
        Effect.fn("environment.orchestration.pullRequestLinks")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const actorUserId = yield* currentActorUserId;
          const snapshot = yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
          const accessibleSnapshot =
            actorUserId === null ? snapshot : filterShellSnapshot(snapshot, actorUserId);
          return yield* discoverPullRequestLinks({
            snapshot: accessibleSnapshot,
            getStatus: vcsStatusBroadcaster.getStatus,
          });
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const actorUserId = yield* currentActorUserId;
          yield* ProjectCloneTracker.rejectCommandsDuringClone(
            projectCloneTracker,
            args.payload,
          ).pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          // Team mode: reject commands on threads/projects the operator can't
          // access. Reads as "invalid_command" so we don't leak existence.
          if (actorUserId !== null) {
            const actorIsAdmin = yield* clerkDirectory.isOrgAdmin(actorUserId);
            const allowed = yield* checkCommandAccess(
              accessControl,
              actorUserId,
              actorIsAdmin,
              normalizedCommand,
            ).pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_dispatch_failed", cause),
              ),
            );
            if (!allowed) {
              return yield* failEnvironmentInvalidRequest("invalid_command");
            }
          }
          // T3-CUSTOM(expbkt3): resolve after access checks so authenticated callers
          // cannot impersonate a supplied owner while scoped actorless callers can.
          const dispatchActorUserId = resolveDelegatedThreadOwner(normalizedCommand, actorUserId);
          // Bootstrap turn starts (the Linear bridge creates sessions this way)
          // get upstream's ws.ts semantics through the fork service.
          const result = yield* turnStartBootstrap
            .dispatch(normalizedCommand, { actorUserId: dispatchActorUserId })
            .pipe(
              Effect.tapError(() =>
                cleanupFailedUploadedAttachments(args.payload, normalizedCommand),
              ),
              Effect.catchTag("OrchestrationDispatchCommandError", (cause) =>
                failEnvironmentInternal("orchestration_dispatch_failed", cause),
              ),
            );
          yield* ProjectCloneTracker.discardCloneForDeletedProject(
            projectCloneTracker,
            normalizedCommand,
          );
          return result;
        }),
      );
  }),
);
