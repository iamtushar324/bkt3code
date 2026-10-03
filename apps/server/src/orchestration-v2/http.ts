import {
  AuthOrchestrationReadScope,
  // T3-CUSTOM(expbkt3): retained automation command endpoint.
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  // T3-CUSTOM(expbkt3): HTTP reads retain durable actor access.
  EnvironmentAuthenticatedPrincipal,
  ThreadId,
  TurnItemId,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
// T3-CUSTOM(expbkt3): resolve the bound operator.
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as OrchestrationEventStore from "../persistence/Services/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  InvalidThreadHistoryCursorError,
  selectHistoryPageFromCursor,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
  THREAD_HISTORY_PAGE_POLICY,
  OLDER_THREAD_USER_TURN_LIMIT,
} from "./threadHistoryPaging.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { buildActiveShellSnapshot } from "./ShellStream.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";
// T3-CUSTOM(expbkt3): fork API and team access use native V2 projections.
import { OrchestrationAccessControl } from "./Services/AccessControl.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ClerkDirectory } from "../auth/ClerkDirectory.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { discoverPullRequestLinks } from "../sourceControl/PullRequestLinkDiscovery.ts";
import { filterReadModel, filterShellSnapshot } from "./accessRules.ts";
import { filterNativeShell } from "../wsV2Visibility.expbkt3.ts";
// T3-CUSTOM(expbkt3): automation payloads enter the native runtime through the compatibility boundary.
import {
  normalizeDispatchCommand,
  cleanupFailedUploadedAttachments,
} from "./Normalizer.expbkt3.ts";
import { TurnStartBootstrap } from "./turnStartBootstrap.expbkt3.ts";
import { resolveDelegatedThreadOwner } from "./DelegatedThreadOwnership.ts";
import { checkCommandAccess } from "./commandAccess.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";

function isThreadNotFound(error: unknown): boolean {
  return (
    Predicate.hasProperty(error, "cause") &&
    Predicate.hasProperty(error.cause, "_tag") &&
    error.cause._tag === "ProjectionStoreThreadNotFoundError"
  );
}

function selectHistoryPageFromCursorOrError(
  input: Parameters<typeof selectHistoryPageFromCursor>[0],
):
  | { readonly _tag: "ok"; readonly page: ReturnType<typeof selectHistoryPageFromCursor> }
  | { readonly _tag: "invalid_cursor" }
  | { readonly _tag: "error"; readonly cause: unknown } {
  try {
    return { _tag: "ok", page: selectHistoryPageFromCursor(input) };
  } catch (cause) {
    if (cause instanceof InvalidThreadHistoryCursorError) {
      return { _tag: "invalid_cursor" };
    }
    return { _tag: "error", cause };
  }
}

/**
 * Serves orchestration V2 snapshots over HTTP so clients can load the
 * (potentially large) shell and thread projections off the socket; gzip
 * compressible and cacheable — and then resume the WebSocket subscription via
 * `afterSequence`.
 */
export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
    // T3-CUSTOM(expbkt3): retain authenticated team reads and fork catalog routes.
    const accessControl = yield* OrchestrationAccessControl;
    const clerkDirectory = yield* ClerkDirectory;
    const providerRegistry = yield* ProviderRegistry;
    const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
    const forkSnapshots = yield* ProjectionSnapshotQuery;
    const forkDispatcher = yield* TurnStartBootstrap;
    const cloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
    const currentActorUserId = Effect.gen(function* () {
      const principal = yield* EnvironmentAuthenticatedPrincipal;
      return Option.getOrNull(accessControl.actorFor(principal.subject, principal.userId));
    });
    const requireThreadAccess = Effect.fn("http.orchestration.requireThreadAccess")(function* (
      threadId: ThreadId,
    ) {
      const actor = yield* currentActorUserId;
      if (actor === null) return;
      const allowed = yield* accessControl
        .canAccessThread(actor, threadId)
        .pipe(
          Effect.catch((cause) =>
            failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
          ),
        );
      if (!allowed) return yield* failEnvironmentNotFound("thread_not_found");
    });

    const enrichProjectShells = Effect.fn("http.orchestration.enrichProjectShells")(
      (projects: ReadonlyArray<OrchestrationProjectShell>) =>
        Effect.forEach(
          projects,
          (project) =>
            // Use immediately available enrichment only. Awaiting git-backed
            // identity resolution can exceed the client shell-snapshot budget
            // (ProcessRunner allows probes up to one minute). Background workers
            // plus the WS enrichment subscription fill in repositoryIdentity.
            projectEnrichment.getAvailable(project.workspaceRoot).pipe(
              Effect.map((enrichment) => ({
                ...project,
                repositoryIdentity: enrichment.repositoryIdentity,
              })),
            ),
          { concurrency: 16 },
        ),
    );

    const loadShellSnapshot = Effect.fn("http.orchestration.loadShellSnapshot")(function* () {
      const base = yield* sql.withTransaction(
        Effect.gen(function* () {
          const threads = yield* threadManagement.getShellSnapshot({ location: "active" });
          return buildActiveShellSnapshot({
            projects: yield* projectStore.listShells(),
            threads,
            snapshotSequence: yield* applicationEvents.latestApplicationSequence,
          });
        }),
      );
      const projects = yield* enrichProjectShells(base.projects);
      // T3-CUSTOM(expbkt3): HTTP shell visibility matches the native socket stream.
      return filterNativeShell({ ...base, projects }, yield* currentActorUserId);
    });

    const loadThreadSnapshot = Effect.fn("http.orchestration.loadThreadSnapshot")(function* (
      threadId: Parameters<typeof threadManagement.getThreadSnapshot>[0],
      failureReason:
        | "orchestration_thread_snapshot_failed"
        | "orchestration_thread_bounded_snapshot_failed"
        | "orchestration_thread_history_failed",
    ) {
      // T3-CUSTOM(expbkt3): deny hidden threads before the projection read.
      yield* requireThreadAccess(threadId);
      return yield* threadManagement.getThreadSnapshot(threadId).pipe(
        Effect.map((snapshot) => ({
          ...snapshot,
          projection: projectThreadProjectionForWire(snapshot.projection),
        })),
        Effect.catch(
          Effect.fnUntraced(function* (error) {
            if (isThreadNotFound(error)) {
              return yield* failEnvironmentNotFound("thread_not_found");
            }
            return yield* failEnvironmentInternal(failureReason, error);
          }),
        ),
      );
    });

    const loadThreadSnapshotWindow = Effect.fn("http.orchestration.loadThreadSnapshotWindow")(
      function* (
        threadId: Parameters<typeof threadManagement.getThreadSnapshot>[0],
        anchorItemId?: Parameters<
          typeof threadManagement.getThreadSnapshotWindow
        >[1]["anchorItemId"],
        anchorThreadId?: Parameters<
          typeof threadManagement.getThreadSnapshotWindow
        >[1]["anchorThreadId"],
      ) {
        // T3-CUSTOM(expbkt3): bounded and history reads use the same access gate.
        yield* requireThreadAccess(threadId);
        if (anchorThreadId !== undefined && anchorThreadId !== threadId)
          yield* requireThreadAccess(anchorThreadId);
        return yield* threadManagement
          .getThreadSnapshotWindow(threadId, {
            rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
            userTurnLimit:
              anchorItemId === undefined
                ? THREAD_HISTORY_PAGE_POLICY.maxUserTurns
                : OLDER_THREAD_USER_TURN_LIMIT,
            ...(anchorItemId === undefined ? {} : { anchorItemId }),
            ...(anchorThreadId === undefined ? {} : { anchorThreadId }),
          })
          .pipe(
            Effect.map((snapshot) => ({
              ...snapshot,
              projection: projectThreadProjectionForWire(snapshot.projection),
            })),
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (isThreadNotFound(error)) {
                  return yield* failEnvironmentNotFound("thread_not_found");
                }
                return yield* failEnvironmentInternal("orchestration_thread_history_failed", error);
              }),
            ),
          );
      },
    );

    return (
      handlers
        // T3-CUSTOM(expbkt3): automation reads stay lightweight and commands retain access checks.
        .handle(
          "snapshot",
          Effect.fn("environment.orchestration.snapshot")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            const actor = yield* currentActorUserId;
            const snapshot = yield* forkSnapshots
              .getCommandReadModel()
              .pipe(
                Effect.catch((cause) =>
                  failEnvironmentInternal("orchestration_snapshot_failed", cause),
                ),
              );
            return actor === null ? snapshot : filterReadModel(snapshot, actor);
          }),
        )
        .handle(
          "dispatch",
          Effect.fn("environment.orchestration.dispatch")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
            const actor = yield* currentActorUserId;
            yield* ProjectCloneTracker.rejectCommandsDuringClone(cloneTracker, args.payload).pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_dispatch_failed", cause),
              ),
            );
            const command = yield* normalizeDispatchCommand(args.payload).pipe(
              Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
            );
            const admin = actor === null ? false : yield* clerkDirectory.isOrgAdmin(actor);
            const allowed = yield* checkCommandAccess(accessControl, actor, admin, command).pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_dispatch_failed", cause),
              ),
            );
            if (!allowed) return yield* failEnvironmentInvalidRequest("invalid_command");
            return yield* forkDispatcher
              .dispatch(command, { actorUserId: resolveDelegatedThreadOwner(command, actor) })
              .pipe(
                Effect.tapError(() => cleanupFailedUploadedAttachments(args.payload, command)),
                Effect.tap(() =>
                  command.type === "project.delete"
                    ? cloneTracker.discard(command.projectId)
                    : Effect.void,
                ),
                Effect.catch((cause) =>
                  failEnvironmentInternal("orchestration_dispatch_failed", cause),
                ),
              );
          }),
        )
        // T3-CUSTOM(expbkt3): preserve provider catalog, tags, and linked pull requests.
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
            return {
              users: yield* clerkDirectory
                .listOrgMembers()
                .pipe(Effect.catch(() => Effect.succeed([]))),
            };
          }),
        )
        .handle(
          "pullRequestLinks",
          Effect.fn("environment.orchestration.pullRequestLinks")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            const actor = yield* currentActorUserId;
            const snapshot = yield* forkSnapshots
              .getShellSnapshot()
              .pipe(
                Effect.catch((cause) =>
                  failEnvironmentInternal("orchestration_snapshot_failed", cause),
                ),
              );
            return yield* discoverPullRequestLinks({
              snapshot: actor === null ? snapshot : filterShellSnapshot(snapshot, actor),
              getStatus: vcsStatusBroadcaster.getStatus,
            });
          }),
        )
        .handle(
          "shellSnapshot",
          Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            return yield* loadShellSnapshot().pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
          }),
        )
        .handle(
          "threadSnapshot",
          Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            const snapshot = yield* loadThreadSnapshot(
              args.params.threadId,
              "orchestration_thread_snapshot_failed",
            );
            return {
              snapshotSequence: snapshot.snapshotSequence,
              projection: snapshot.projection,
            };
          }),
        )
        .handle(
          "threadBoundedSnapshot",
          Effect.fn("environment.orchestration.threadBoundedSnapshot")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            const snapshot = yield* loadThreadSnapshotWindow(args.params.threadId);
            const bounded = buildBoundedThreadProjection({
              projection: snapshot.projection,
              snapshotSequence: snapshot.snapshotSequence,
            });
            return {
              snapshotSequence: snapshot.snapshotSequence,
              projection: bounded.projection,
              historyCursor: bounded.historyCursor,
              hasMoreHistory: bounded.hasMoreHistory,
              latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
              payloadBudgetExceeded: bounded.payloadBudgetExceeded,
            };
          }),
        )
        .handle(
          "threadHistoryPage",
          Effect.fn("environment.orchestration.threadHistoryPage")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            let anchorItemId;
            try {
              anchorItemId = TurnItemId.make(decodeThreadHistoryCursor(args.query.cursor).si);
            } catch (cause) {
              if (cause instanceof InvalidThreadHistoryCursorError) {
                return yield* failEnvironmentInvalidRequest("invalid_history_cursor");
              }
              return yield* failEnvironmentInternal("orchestration_thread_history_failed", cause);
            }
            const decodedCursor = decodeThreadHistoryCursor(args.query.cursor);
            const snapshot = yield* loadThreadSnapshotWindow(
              args.params.threadId,
              anchorItemId,
              ThreadId.make(decodedCursor.st),
            );
            const pageOrError = selectHistoryPageFromCursorOrError({
              items: snapshot.projection.visibleTurnItems,
              cursor: args.query.cursor,
              snapshotSequence: snapshot.snapshotSequence,
            });
            if (pageOrError._tag === "invalid_cursor") {
              return yield* failEnvironmentInvalidRequest("invalid_history_cursor");
            }
            if (pageOrError._tag === "error") {
              return yield* failEnvironmentInternal(
                "orchestration_thread_history_failed",
                pageOrError.cause,
              );
            }
            return {
              snapshotSequence: snapshot.snapshotSequence,
              items: pageOrError.page.items,
              nextCursor: pageOrError.page.nextCursor,
              hasMoreHistory: pageOrError.page.hasMoreHistory,
            };
          }),
        )
    );
  }),
);
