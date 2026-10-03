/**
 * T3-CUSTOM(expbkt3): Fork websocket RPC handlers.
 *
 * Personal MCP, source-control identity profiles, environment user management,
 * resource/rate-limit streams, and the execution-stop + event-replay
 * orchestration RPCs. Upstream-owned `ws.ts` builds these in one marked seam and
 * spreads them into `WsRpcGroup.of`, so adding or removing a fork RPC no longer
 * edits the upstream handler map.
 *
 * Every dependency is injected rather than resolved from context: the caller
 * passes the exact service instances and connection-scoped closures it already
 * built, so behaviour is identical to the previously inlined handlers.
 */
import {
  ORCHESTRATION_WS_METHODS,
  WS_FORK_METHODS,
  WS_METHODS,
  WsRpcGroup,
  EnvironmentAuthorizationError,
  // T3-CUSTOM(expbkt3): agent-rendered UI surfaces in chat.
  AgentUiError,
  OrchestrationGetSnapshotError,
  PlanReviewError,
  SessionArchiveError,
  SourceControlProfileError,
  // T3-CUSTOM(expbkt3): review comments on assistant messages in chat.
  ThreadCommentsError,
  // T3-CUSTOM(expbkt3): per-thread API-level cost.
  UsageReadError,
  // T3-CUSTOM(expbkt3): Claude account profiles per thread.
  ClaudeAccountsError,
  type AuthSessionId,
  type OrchestrationEvent,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { HttpClient } from "effect/unstable/http";

import type * as EnvironmentUserService from "./auth/EnvironmentUserService.ts";
// T3-CUSTOM(expbkt3): Claude account access per user checks ids against the org.
import type { ClerkDirectoryShape } from "./auth/ClerkDirectory.ts";
import type * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import type * as UserMcpProfileStore from "./mcp/UserMcpProfileStore.ts";
import type * as OrchestrationEngine from "./orchestration-v2/Services/OrchestrationEngine.ts";
import type * as PlanReviewService from "./planreview/PlanReviewService.ts";
// T3-CUSTOM(expbkt3): agent-rendered UI surfaces in chat.
import type * as AgentUiService from "./agentui/AgentUiService.ts";
// T3-CUSTOM(expbkt3): review comments on assistant messages in chat.
import type * as ThreadCommentsService from "./threadcomments/ThreadCommentsService.ts";
import type * as ProjectionSnapshotQuery from "./orchestration-v2/Services/ProjectionSnapshotQuery.ts";
// T3-CUSTOM(expbkt3): per-thread API-level cost.
import type * as UsageService from "./usage/UsageService.ts";
import type { ProjectionRepositoryError } from "./persistence/Errors.ts";
import { githubSshRemoteToHttps } from "./sourceControl/GitHubRemoteUrl.ts";
import type * as SourceControlProfileService from "./sourceControl/SourceControlProfileService.ts";
import { resolveLinearIssueStatuses } from "./linear/LinearIssueResolver.ts";
import { sharedLinearIssueStatusCache } from "./linear/LinearIssueStatusCache.ts";
import { linearStatusBridgeToken, makeLinearStatusBridge } from "./linear/LinearStatusBridge.ts";
import type { SessionArchiveServiceShape } from "./sessionArchive/SessionArchiveService.ts";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
// T3-CUSTOM(expbkt3): Claude account profiles per thread.
import type * as ClaudeAccountsService from "./claudeAccounts/ClaudeAccountsService.ts";
// T3-CUSTOM(expbkt3): toolyard auto-connect
import { connectToolyard } from "./mcp/ToolyardConnect.ts";

type WsRpcs = RpcGroup.Rpcs<typeof WsRpcGroup>;
type ForkWsMethod = (typeof WS_FORK_METHODS)[keyof typeof WS_FORK_METHODS];

/** The fork's slice of the websocket handler map, typed by the RPC group. */
export type ForkWsHandlers = Pick<RpcGroup.HandlersFrom<WsRpcs>, ForkWsMethod>;

export interface ForkWsHandlerDeps {
  readonly currentSessionId: AuthSessionId;
  readonly actorUserId: UserId | null;
  /** Deterministic profile id for local/single-user transports. */
  readonly personalMcpUserId: UserId;
  readonly personalMcpProfiles: UserMcpProfileStore.UserMcpProfileStore["Service"];
  readonly httpClient: HttpClient.HttpClient;
  readonly sourceControlProfiles: SourceControlProfileService.SourceControlProfileService["Service"];
  readonly environmentUsers: EnvironmentUserService.EnvironmentUserService["Service"];
  // T3-CUSTOM(expbkt3): native plan review.
  readonly planReview: PlanReviewService.PlanReviewService["Service"];
  // T3-CUSTOM(expbkt3): agent-rendered UI surfaces in chat.
  readonly agentUi: AgentUiService.AgentUiServiceShape;
  // T3-CUSTOM(expbkt3): review comments on assistant messages in chat.
  readonly threadComments: ThreadCommentsService.ThreadCommentsServiceShape;
  /** Display name for the acting user, stamped onto their review comments. */
  readonly actorLabel: string | null;
  // T3-CUSTOM(expbkt3): per-thread API-level cost.
  readonly usage: UsageService.UsageService["Service"];
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly orchestrationEngine: OrchestrationEngine.OrchestrationEngineService["Service"];
  readonly gitVcsDriver: GitVcsDriver.GitVcsDriver["Service"];
  // T3-CUSTOM(expbkt3): archived-session worktree reclaim.
  readonly sessionArchive: SessionArchiveServiceShape;
  /** Serialises source-control actions per thread. */
  readonly sourceControlActionLock: {
    readonly runExclusive: <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  };
  readonly enrichOrchestrationEvents: (
    events: ReadonlyArray<OrchestrationEvent>,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, never, never>;
  readonly observeRpcEffect: <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
  readonly observeRpcStream: <A, E, R>(
    method: string,
    stream: Stream.Stream<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Stream.Stream<A, E | EnvironmentAuthorizationError, R>;
  readonly requireThreadAccess: (
    threadId: ThreadId,
  ) => Effect.Effect<void, OrchestrationGetSnapshotError>;
  readonly visibleAggregateIdsForActor: (
    userId: UserId,
  ) => Effect.Effect<
    { readonly threadIds: ReadonlySet<string>; readonly projectIds: ReadonlySet<string> },
    ProjectionRepositoryError
  >;
  // T3-CUSTOM(expbkt3): Claude account profiles per thread.
  readonly claudeAccounts: ClaudeAccountsService.ClaudeAccountsServiceShape;
  /** Whether the connection's user is a Clerk org admin; false for the local operator. */
  readonly actorIsAdmin: boolean;
  /** The org directory; assigned users must be in it when team mode is on. */
  readonly clerkDirectory: Pick<ClerkDirectoryShape, "enabled" | "listOrgMembers">;
}

export const makeForkWsHandlers = ({
  currentSessionId,
  actorUserId,
  personalMcpUserId,
  personalMcpProfiles,
  httpClient,
  sourceControlProfiles,
  environmentUsers,
  planReview,
  agentUi,
  threadComments,
  actorLabel,
  usage,
  projectionSnapshotQuery,
  orchestrationEngine,
  gitVcsDriver,
  sessionArchive,
  sourceControlActionLock,
  enrichOrchestrationEvents,
  observeRpcEffect,
  observeRpcStream,
  requireThreadAccess,
  visibleAggregateIdsForActor,
  // T3-CUSTOM(expbkt3): Claude account profiles per thread.
  claudeAccounts,
  actorIsAdmin,
  clerkDirectory,
}: ForkWsHandlerDeps) => {
  // T3-CUSTOM(expbkt3): review comments. Access denial reads as "not found" so
  // a caller cannot tell a hidden thread from a missing one.
  const guardCommentsThread = (operation: string, threadId: ThreadId) =>
    requireThreadAccess(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadCommentsError({ operation, reason: "not-found", detail: cause.message }),
      ),
    );
  // T3-CUSTOM(expbkt3): BEGIN native plan review helpers.
  const planReviewAccessError = (cause: OrchestrationGetSnapshotError) =>
    new PlanReviewError({ operation: "access", reason: "not-found", detail: cause.message });

  const toPlanReviewError =
    (operation: string) => (cause: { readonly _tag: string; readonly message: string }) =>
      cause._tag === "PlanReviewError"
        ? (cause as unknown as PlanReviewError)
        : new PlanReviewError({
            operation,
            reason:
              cause._tag === "PlanReviewNotFoundError"
                ? "not-found"
                : cause._tag === "PlanDraftConflictError"
                  ? "draft-conflict"
                  : cause._tag === "PlanVersionConflictError"
                    ? "version-conflict"
                    : "invalid",
            detail: cause.message,
          });

  /**
   * Reviews are reachable only through the thread that owns them, so every
   * entry point resolves the document first and then applies thread access.
   * A denial reads as "not found" so the check cannot leak existence.
   */
  const guardDocument = (documentId: string) =>
    planReview.getReview(documentId).pipe(
      Effect.mapError(toPlanReviewError("access")),
      Effect.tap((snapshot) =>
        requireThreadAccess(snapshot.document.threadId).pipe(
          Effect.mapError(planReviewAccessError),
        ),
      ),
    );

  const guardedReview = (documentId: string) => guardDocument(documentId);
  // T3-CUSTOM(expbkt3): END native plan review helpers.

  // T3-CUSTOM(expbkt3): BEGIN Claude account profiles per thread. The host
  // snapshot is readable by any authenticated user of the environment, narrowed
  // to the accounts that user may use (admins see all, flagged). Thread
  // calls run the normal per-thread access check once the thread exists; a
  // draft thread (the web sets a mode before the first send, under the id the
  // bootstrap will adopt) has no row to check yet, so the caller is trusted.
  const guardClaudeAccountsThread = (operation: string, threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadShellById(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeAccountsError({ operation, reason: "internal", detail: cause.message }),
      ),
      Effect.flatMap((shell) =>
        Option.isNone(shell)
          ? Effect.void
          : requireThreadAccess(threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new ClaudeAccountsError({
                    operation,
                    reason: "not-found",
                    detail: cause.message,
                  }),
              ),
            ),
      ),
    );
  const requireClaudeAccountsAdmin = (operation: string) =>
    actorUserId === null || actorIsAdmin
      ? Effect.void
      : Effect.fail(
          new ClaudeAccountsError({
            operation,
            reason: "forbidden",
            detail: "Only workspace admins can manage Claude account access.",
          }),
        );
  /** In team mode every assigned id must be an org member; local mode has no directory. */
  const requireOrgMembers = (userIds: ReadonlyArray<UserId>) =>
    !clerkDirectory.enabled || userIds.length === 0
      ? Effect.void
      : clerkDirectory.listOrgMembers().pipe(
          Effect.mapError(
            (cause) =>
              new ClaudeAccountsError({
                operation: "setAccess",
                reason: "unavailable",
                detail: `Could not read the workspace directory: ${cause.message}`,
              }),
          ),
          Effect.flatMap((members) => {
            const known = new Set<string>(members.map((member) => member.id));
            const unknown = userIds.filter((id) => !known.has(id));
            return unknown.length === 0
              ? Effect.void
              : Effect.fail(
                  new ClaudeAccountsError({
                    operation: "setAccess",
                    reason: "invalid",
                    detail: `Not workspace members: ${unknown.join(", ")}.`,
                  }),
                );
          }),
        );
  const claudeAccountsHandlers = {
    [WS_FORK_METHODS.claudeAccountsGetThread]: (input) =>
      observeRpcEffect(
        WS_FORK_METHODS.claudeAccountsGetThread,
        guardClaudeAccountsThread("getThread", input.threadId).pipe(
          Effect.andThen(claudeAccounts.getThread(input.threadId)),
        ),
        { "rpc.aggregate": "claude-accounts" },
      ),
    [WS_FORK_METHODS.claudeAccountsSetThreadMode]: (input) =>
      observeRpcEffect(
        WS_FORK_METHODS.claudeAccountsSetThreadMode,
        guardClaudeAccountsThread("setThreadMode", input.threadId).pipe(
          Effect.andThen(claudeAccounts.setThreadMode({ ...input, actorUserId })),
        ),
        { "rpc.aggregate": "claude-accounts" },
      ),
    [WS_FORK_METHODS.subscribeClaudeAccounts]: () =>
      observeRpcStream(
        WS_FORK_METHODS.subscribeClaudeAccounts,
        claudeAccounts.watchSnapshot({ userId: actorUserId, isAdmin: actorIsAdmin }),
        { "rpc.aggregate": "claude-accounts" },
      ),
    // Who may use each account is managed by Clerk org admins, like project
    // access. The unidentified local operator is unrestricted.
    [WS_FORK_METHODS.claudeAccountsAccessList]: () =>
      observeRpcEffect(
        WS_FORK_METHODS.claudeAccountsAccessList,
        requireClaudeAccountsAdmin("listAccess").pipe(Effect.andThen(claudeAccounts.listAccess())),
        { "rpc.aggregate": "claude-accounts" },
      ),
    [WS_FORK_METHODS.claudeAccountsAccessSet]: (input) =>
      observeRpcEffect(
        WS_FORK_METHODS.claudeAccountsAccessSet,
        requireClaudeAccountsAdmin("setAccess").pipe(
          Effect.andThen(requireOrgMembers(input.userIds)),
          Effect.andThen(claudeAccounts.setAccess({ ...input, actorUserId })),
        ),
        { "rpc.aggregate": "claude-accounts" },
      ),
    [WS_FORK_METHODS.subscribeThreadClaudeAccount]: (input) =>
      observeRpcStream(
        WS_FORK_METHODS.subscribeThreadClaudeAccount,
        Stream.fromEffect(guardClaudeAccountsThread("watch", input.threadId)).pipe(
          Stream.flatMap(() => claudeAccounts.watchThread(input.threadId)),
        ),
        { "rpc.aggregate": "claude-accounts" },
      ),
  } satisfies Pick<
    ForkWsHandlers,
    | typeof WS_FORK_METHODS.claudeAccountsGetThread
    | typeof WS_FORK_METHODS.claudeAccountsSetThreadMode
    | typeof WS_FORK_METHODS.subscribeClaudeAccounts
    | typeof WS_FORK_METHODS.subscribeThreadClaudeAccount
    | typeof WS_FORK_METHODS.claudeAccountsAccessList
    | typeof WS_FORK_METHODS.claudeAccountsAccessSet
  >;
  // T3-CUSTOM(expbkt3): END Claude account profiles per thread.

  return {
    [WS_METHODS.personalMcpGetProfile]: (_input) =>
      observeRpcEffect(
        WS_METHODS.personalMcpGetProfile,
        personalMcpProfiles.get(personalMcpUserId),
        { "rpc.aggregate": "personal-mcp" },
      ),
    [WS_METHODS.personalMcpUpdateProfile]: (input) =>
      observeRpcEffect(
        WS_METHODS.personalMcpUpdateProfile,
        personalMcpProfiles.update(personalMcpUserId, input),
        { "rpc.aggregate": "personal-mcp" },
      ),
    [WS_METHODS.personalMcpRotateToken]: (_input) =>
      observeRpcEffect(
        WS_METHODS.personalMcpRotateToken,
        personalMcpProfiles.rotateExternalToken(personalMcpUserId),
        { "rpc.aggregate": "personal-mcp" },
      ),
    [WS_METHODS.personalMcpRevokeToken]: (_input) =>
      observeRpcEffect(
        WS_METHODS.personalMcpRevokeToken,
        personalMcpProfiles.revokeExternalToken(personalMcpUserId),
        { "rpc.aggregate": "personal-mcp" },
      ),
    [WS_METHODS.linearIssuesResolve]: (input) =>
      observeRpcEffect(
        WS_METHODS.linearIssuesResolve,
        sharedLinearIssueStatusCache().pipe(
          Effect.flatMap((cache) => {
            const token = linearStatusBridgeToken();
            return resolveLinearIssueStatuses({
              userId: personalMcpUserId,
              identifiers: input.identifiers,
              profiles: personalMcpProfiles,
              httpClient,
              cache,
              ...(token === undefined
                ? {}
                : { bridge: makeLinearStatusBridge({ httpClient, token }) }),
            });
          }),
        ),
        { "rpc.aggregate": "linear-issues" },
      ),
    // T3-CUSTOM(expbkt3): BEGIN — archived-session worktree reclaim.
    [WS_METHODS.sessionArchiveScan]: (_input) =>
      observeRpcEffect(WS_METHODS.sessionArchiveScan, sessionArchive.scan(), {
        "rpc.aggregate": "session-archive",
      }),
    [WS_METHODS.sessionArchiveExport]: (input) =>
      observeRpcEffect(
        WS_METHODS.sessionArchiveExport,
        sessionArchive.exportHistory(input.threadIds),
        { "rpc.aggregate": "session-archive" },
      ),
    [WS_METHODS.sessionArchiveReclaim]: (input) =>
      observeRpcEffect(WS_METHODS.sessionArchiveReclaim, sessionArchive.reclaim(input), {
        "rpc.aggregate": "session-archive",
      }),
    [WS_METHODS.sessionArchiveBackfill]: (input) =>
      observeRpcEffect(WS_METHODS.sessionArchiveBackfill, sessionArchive.backfill(input), {
        "rpc.aggregate": "session-archive",
      }),
    // Context handoff: thread-scoped read, so it applies per-thread access
    // where the archive batch RPCs above rely on the operate scope alone.
    [WS_METHODS.threadContextExport]: (input) =>
      observeRpcEffect(
        WS_METHODS.threadContextExport,
        requireThreadAccess(input.threadId).pipe(
          Effect.mapError(
            (cause) =>
              new SessionArchiveError({ operation: "context-export", message: cause.message }),
          ),
          Effect.andThen(sessionArchive.exportContext(input.threadId)),
        ),
        { "rpc.aggregate": "session-archive" },
      ),
    // T3-CUSTOM(expbkt3): agent-rendered UI surfaces. Thread-scoped: the render
    // body only goes out to someone who can already read that thread.
    [WS_METHODS.agentUiGetRender]: (input) =>
      observeRpcEffect(
        WS_METHODS.agentUiGetRender,
        requireThreadAccess(input.threadId).pipe(
          Effect.mapError(
            (cause) => new AgentUiError({ operation: "get-render", message: cause.message }),
          ),
          Effect.andThen(agentUi.getRender({ threadId: input.threadId, renderId: input.renderId })),
          Effect.map((render) => ({ render })),
        ),
        { "rpc.aggregate": "agent-ui" },
      ),
    // T3-CUSTOM(expbkt3): END
    // T3-CUSTOM(expbkt3): BEGIN per-thread API-level cost. Thread-scoped read:
    // the figures go only to someone who can already read that thread. The
    // provider session behind the thread comes from the shell projection.
    [WS_METHODS.threadUsageGet]: (input) =>
      observeRpcEffect(
        WS_METHODS.threadUsageGet,
        requireThreadAccess(input.threadId).pipe(
          Effect.mapError(
            (cause) =>
              new UsageReadError({
                reason: "scanFailed",
                detail: cause.message,
                cause,
              }),
          ),
          Effect.andThen(
            projectionSnapshotQuery.getShellSnapshot().pipe(
              Effect.mapError(
                (cause) =>
                  new UsageReadError({
                    reason: "scanFailed",
                    detail: "Thread projection could not be read.",
                    cause,
                  }),
              ),
            ),
          ),
          Effect.flatMap((snapshot) => {
            const thread = snapshot.threads.find((candidate) => candidate.id === input.threadId);
            const providerThreadId = thread?.session?.providerThreadId ?? null;
            return usage.readThreadUsage({
              threadId: input.threadId,
              sessionIds: providerThreadId === null ? [] : [providerThreadId],
              sinceMs: thread === undefined ? 0 : Date.parse(thread.createdAt),
              timeZone: input.timeZone,
            });
          }),
        ),
        { "rpc.aggregate": "usage" },
      ),
    // T3-CUSTOM(expbkt3): END
    [WS_METHODS.sourceControlProfilesList]: (_input) =>
      observeRpcEffect(WS_METHODS.sourceControlProfilesList, sourceControlProfiles.list, {
        "rpc.aggregate": "source-control-profile",
      }),
    [WS_METHODS.sourceControlProfilesUpsert]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlProfilesUpsert,
        environmentUsers
          .assertAdministrator(currentSessionId)
          .pipe(Effect.andThen(sourceControlProfiles.upsert(input))),
        { "rpc.aggregate": "source-control-profile" },
      ),
    [WS_METHODS.sourceControlProfilesTest]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlProfilesTest,
        environmentUsers
          .assertAdministrator(currentSessionId)
          .pipe(Effect.andThen(sourceControlProfiles.test(input))),
        { "rpc.aggregate": "source-control-profile" },
      ),
    [WS_METHODS.sourceControlProfilesReplaceCredential]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlProfilesReplaceCredential,
        environmentUsers
          .assertAdministrator(currentSessionId)
          .pipe(Effect.andThen(sourceControlProfiles.replaceCredential(input))),
        { "rpc.aggregate": "source-control-profile" },
      ),
    [WS_METHODS.sourceControlProfilesDisconnect]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlProfilesDisconnect,
        environmentUsers
          .assertAdministrator(currentSessionId)
          .pipe(Effect.andThen(sourceControlProfiles.disconnect(input))),
        { "rpc.aggregate": "source-control-profile" },
      ),
    [WS_METHODS.sourceControlProfilesArchive]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlProfilesArchive,
        environmentUsers
          .assertAdministrator(currentSessionId)
          .pipe(Effect.andThen(sourceControlProfiles.archive(input))),
        { "rpc.aggregate": "source-control-profile" },
      ),
    [WS_METHODS.usersList]: (_input) =>
      observeRpcEffect(WS_METHODS.usersList, environmentUsers.list(currentSessionId), {
        "rpc.aggregate": "users",
      }),
    [WS_METHODS.usersUpdate]: (input) =>
      observeRpcEffect(
        WS_METHODS.usersUpdate,
        environmentUsers
          .assertAdministrator(currentSessionId)
          .pipe(Effect.andThen(environmentUsers.update(input))),
        { "rpc.aggregate": "users" },
      ),
    [WS_METHODS.usersRevokeSessions]: (input) =>
      observeRpcEffect(
        WS_METHODS.usersRevokeSessions,
        environmentUsers
          .assertAdministrator(currentSessionId)
          .pipe(Effect.andThen(environmentUsers.revokeSessions(input))),
        { "rpc.aggregate": "users" },
      ),
    [WS_METHODS.usersSourceControlProfileSet]: (input) =>
      observeRpcEffect(
        WS_METHODS.usersSourceControlProfileSet,
        environmentUsers
          .assertAdministrator(currentSessionId)
          .pipe(Effect.andThen(environmentUsers.setSourceControlProfile(input))),
        { "rpc.aggregate": "users" },
      ),
    [WS_METHODS.sourceControlThreadOwnerSet]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlThreadOwnerSet,
        // T3-CUSTOM(expbkt3): GitHub identity follows durable T3
        // ownership. Keep this RPC decodable for older clients.
        Effect.fail(
          new SourceControlProfileError({
            operation: "switch-thread-owner",
            reason: "validation-failed",
            detail:
              "GitHub identity follows the durable thread owner. Transfer thread ownership instead.",
            profileId: input.sourceControlProfileId,
            threadId: input.threadId,
          }),
        ),
        { "rpc.aggregate": "source-control-profile" },
      ),
    [WS_METHODS.sourceControlConvertRemote]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlConvertRemote,
        sourceControlActionLock.runExclusive(
          input.threadId,
          Effect.gen(function* () {
            const threadOption = yield* projectionSnapshotQuery
              .getThreadShellById(input.threadId)
              .pipe(
                Effect.mapError(
                  () =>
                    new SourceControlProfileError({
                      operation: "convert-remote",
                      reason: "thread-not-found",
                      detail: "Could not read the selected thread.",
                      threadId: input.threadId,
                    }),
                ),
              );
            if (Option.isNone(threadOption)) {
              return yield* new SourceControlProfileError({
                operation: "convert-remote",
                reason: "thread-not-found",
                detail: "The selected thread no longer exists.",
                threadId: input.threadId,
              });
            }
            const context = yield* sourceControlProfiles.resolveThreadExecutionContext(
              input.threadId,
              threadOption.value.ownerUserId,
            );
            const environment = context?.environment ?? process.env;
            const current = yield* gitVcsDriver
              .execute({
                operation: "SourceControlRemote.getUrl",
                cwd: input.cwd,
                args: ["remote", "get-url", input.remoteName],
                env: environment,
              })
              .pipe(
                Effect.mapError(
                  () =>
                    new SourceControlProfileError({
                      operation: "convert-remote",
                      reason: "remote-not-found",
                      detail: `Git remote '${input.remoteName}' could not be read.`,
                      threadId: input.threadId,
                    }),
                ),
              );
            const previousUrl = current.stdout.trim();
            const remoteUrl = githubSshRemoteToHttps(previousUrl);
            if (remoteUrl === null) {
              return yield* new SourceControlProfileError({
                operation: "convert-remote",
                reason: "ssh-remote",
                detail: "The selected remote is not a GitHub SSH URL that can be converted.",
                threadId: input.threadId,
              });
            }
            yield* gitVcsDriver
              .execute({
                operation: "SourceControlRemote.setUrl",
                cwd: input.cwd,
                args: ["remote", "set-url", input.remoteName, remoteUrl],
                env: environment,
              })
              .pipe(
                Effect.mapError(
                  () =>
                    new SourceControlProfileError({
                      operation: "convert-remote",
                      reason: "validation-failed",
                      detail: "The GitHub remote could not be converted to HTTPS.",
                      threadId: input.threadId,
                    }),
                ),
              );
            return { remoteName: input.remoteName, previousUrl, remoteUrl };
          }),
        ),
        { "rpc.aggregate": "source-control-profile" },
      ),
    // T3-CUSTOM(expbkt3): BEGIN native plan review.
    [WS_METHODS.planReviewGet]: (input) =>
      observeRpcEffect(WS_METHODS.planReviewGet, guardedReview(input.documentId), {
        "rpc.aggregate": "plan-review",
      }),
    [WS_METHODS.planReviewList]: (input) =>
      observeRpcEffect(
        WS_METHODS.planReviewList,
        requireThreadAccess(input.threadId).pipe(
          Effect.mapError(planReviewAccessError),
          Effect.andThen(planReview.listForThread(input.threadId)),
          Effect.map((documents) => ({ documents })),
          Effect.mapError(toPlanReviewError("list")),
        ),
        { "rpc.aggregate": "plan-review" },
      ),
    [WS_METHODS.planReviewSaveDraft]: (input) =>
      observeRpcEffect(
        WS_METHODS.planReviewSaveDraft,
        guardDocument(input.documentId).pipe(
          Effect.andThen(
            planReview.saveDraft({
              documentId: input.documentId,
              contentValueJson: input.contentValueJson,
              expectedRevisionToken: input.expectedRevisionToken,
              actorUserId,
            }),
          ),
          Effect.mapError(toPlanReviewError("saveDraft")),
        ),
        { "rpc.aggregate": "plan-review" },
      ),
    [WS_METHODS.planReviewCutVersion]: (input) =>
      observeRpcEffect(
        WS_METHODS.planReviewCutVersion,
        guardDocument(input.documentId).pipe(
          Effect.andThen(
            planReview.cutVersion({
              documentId: input.documentId,
              contentMarkdown: input.contentMarkdown,
              contentValueJson: input.contentValueJson,
              summary: input.summary,
              actorUserId,
            }),
          ),
          Effect.andThen(planReview.getReview(input.documentId)),
          Effect.mapError(toPlanReviewError("cutVersion")),
        ),
        { "rpc.aggregate": "plan-review" },
      ),
    [WS_METHODS.planReviewUpsertDiscussion]: (input) =>
      observeRpcEffect(
        WS_METHODS.planReviewUpsertDiscussion,
        guardDocument(input.documentId).pipe(
          Effect.andThen(
            planReview.upsertDiscussion({
              documentId: input.documentId,
              discussionId: input.discussionId,
              quotedText: input.quotedText,
              bodyMarkdown: input.bodyMarkdown,
              actorUserId,
            }),
          ),
          Effect.andThen(planReview.getReview(input.documentId)),
          Effect.mapError(toPlanReviewError("upsertDiscussion")),
        ),
        { "rpc.aggregate": "plan-review" },
      ),
    [WS_METHODS.planReviewResolveDiscussion]: (input) =>
      observeRpcEffect(
        WS_METHODS.planReviewResolveDiscussion,
        guardDocument(input.documentId).pipe(
          Effect.andThen(
            planReview.resolveDiscussion({
              documentId: input.documentId,
              discussionId: input.discussionId,
              isResolved: input.isResolved,
              actorUserId,
            }),
          ),
          Effect.andThen(planReview.getReview(input.documentId)),
          Effect.mapError(toPlanReviewError("resolveDiscussion")),
        ),
        { "rpc.aggregate": "plan-review" },
      ),
    [WS_METHODS.planReviewVersionDiff]: (input) =>
      observeRpcEffect(
        WS_METHODS.planReviewVersionDiff,
        guardDocument(input.documentId).pipe(
          Effect.andThen(planReview.getVersionDiff(input)),
          Effect.mapError(toPlanReviewError("versionDiff")),
        ),
        { "rpc.aggregate": "plan-review" },
      ),
    [WS_METHODS.planReviewSubmit]: (input) =>
      observeRpcEffect(
        WS_METHODS.planReviewSubmit,
        guardDocument(input.documentId).pipe(
          Effect.andThen(
            planReview.submit({
              documentId: input.documentId,
              decision: input.decision,
              globalComment: input.globalComment,
              editedMarkdown: input.editedMarkdown,
              actorUserId,
              actorLabel,
            }),
          ),
          Effect.mapError(toPlanReviewError("submit")),
        ),
        { "rpc.aggregate": "plan-review" },
      ),
    [WS_METHODS.subscribePlanReview]: (input) =>
      observeRpcStream(
        WS_METHODS.subscribePlanReview,
        Stream.fromEffect(guardDocument(input.documentId)).pipe(
          Stream.flatMap(() => planReview.watch(input.documentId)),
          Stream.mapError(toPlanReviewError("watch")),
        ),
        { "rpc.aggregate": "plan-review" },
      ),
    // T3-CUSTOM(expbkt3): END native plan review.
    // T3-CUSTOM(expbkt3): BEGIN review comments on assistant messages. Every
    // method is thread-scoped: a caller who cannot read the thread gets the
    // same "not found" a missing thread would produce.
    [WS_METHODS.threadCommentsList]: (input) =>
      observeRpcEffect(
        WS_METHODS.threadCommentsList,
        guardCommentsThread("list", input.threadId).pipe(
          Effect.andThen(threadComments.snapshot(input.threadId)),
        ),
        { "rpc.aggregate": "thread-comments" },
      ),
    [WS_METHODS.threadCommentsAdd]: (input) =>
      observeRpcEffect(
        WS_METHODS.threadCommentsAdd,
        guardCommentsThread("add", input.threadId).pipe(
          Effect.andThen(threadComments.add({ ...input, actorUserId, actorLabel })),
        ),
        { "rpc.aggregate": "thread-comments" },
      ),
    [WS_METHODS.threadCommentsReply]: (input) =>
      observeRpcEffect(
        WS_METHODS.threadCommentsReply,
        guardCommentsThread("reply", input.threadId).pipe(
          Effect.andThen(threadComments.reply({ ...input, actorUserId, actorLabel })),
        ),
        { "rpc.aggregate": "thread-comments" },
      ),
    [WS_METHODS.threadCommentsSetStatus]: (input) =>
      observeRpcEffect(
        WS_METHODS.threadCommentsSetStatus,
        guardCommentsThread("setStatus", input.threadId).pipe(
          Effect.andThen(threadComments.setStatus(input)),
        ),
        { "rpc.aggregate": "thread-comments" },
      ),
    [WS_METHODS.threadCommentsResolveAll]: (input) =>
      observeRpcEffect(
        WS_METHODS.threadCommentsResolveAll,
        guardCommentsThread("resolveAll", input.threadId).pipe(
          Effect.andThen(threadComments.resolveAll(input)),
        ),
        { "rpc.aggregate": "thread-comments" },
      ),
    [WS_METHODS.threadCommentsRemove]: (input) =>
      observeRpcEffect(
        WS_METHODS.threadCommentsRemove,
        guardCommentsThread("remove", input.threadId).pipe(
          Effect.andThen(threadComments.remove(input)),
        ),
        { "rpc.aggregate": "thread-comments" },
      ),
    [WS_METHODS.threadCommentsSetDeliveryPaused]: (input) =>
      observeRpcEffect(
        WS_METHODS.threadCommentsSetDeliveryPaused,
        guardCommentsThread("setDeliveryPaused", input.threadId).pipe(
          Effect.andThen(threadComments.setDeliveryPaused(input)),
        ),
        { "rpc.aggregate": "thread-comments" },
      ),
    [WS_METHODS.subscribeThreadComments]: (input) =>
      observeRpcStream(
        WS_METHODS.subscribeThreadComments,
        Stream.fromEffect(guardCommentsThread("watch", input.threadId)).pipe(
          Stream.flatMap(() => threadComments.watch(input.threadId)),
        ),
        { "rpc.aggregate": "thread-comments" },
      ),
    // T3-CUSTOM(expbkt3): END review comments.
    // T3-CUSTOM(expbkt3): Claude account profiles per thread.
    ...claudeAccountsHandlers,
    // T3-CUSTOM(expbkt3): toolyard auto-connect. The Clerk token in the payload
    // is handed to toolyard once and is never logged or traced; the result
    // carries no credential either way. Bound to the connection's actor, never
    // the shared local fallback profile: an unbound session is refused.
    [WS_METHODS.personalMcpConnectToolyard]: (input) =>
      observeRpcEffect(
        WS_METHODS.personalMcpConnectToolyard,
        connectToolyard({
          actorUserId,
          clerkToken: input.clerkToken,
          profiles: personalMcpProfiles,
          httpClient,
        }),
        { "rpc.aggregate": "personal-mcp" },
      ),
  } satisfies ForkWsHandlers;
};
