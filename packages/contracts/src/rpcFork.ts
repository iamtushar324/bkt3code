/**
 * T3-CUSTOM(expbkt3): Fork websocket RPC definitions.
 *
 * Method names and RPC definitions that exist only in this fork: personal MCP,
 * source-control identity profiles, and environment user management.
 * Upstream-owned `rpc.ts` merges these through a single spread in
 * `WS_METHODS` and one in `WsRpcGroup`.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  PersonalMcpProfile,
  PersonalMcpProfileUpdate,
  PersonalMcpSettingsError,
  PersonalMcpTokenResult,
} from "./personalMcp.ts";
import { LinearIssueStatusInput, LinearIssueStatusResult } from "./linearIssue.ts";
// T3-CUSTOM(expbkt3): agent-rendered UI surfaces in chat.
import { AgentUiError, AgentUiGetRenderInput, AgentUiGetRenderResult } from "./agentUi.ts";
import {
  PlanReviewCutVersionInput,
  PlanReviewDocumentIdInput,
  PlanReviewError,
  PlanReviewListInput,
  PlanReviewListResult,
  PlanReviewResolveDiscussionInput,
  PlanReviewSaveDraftInput,
  PlanReviewSaveDraftResult,
  PlanReviewSnapshotResult,
  PlanReviewSubmitInput,
  PlanReviewSubmitResult,
  PlanReviewUpsertDiscussionInput,
  PlanReviewVersionDiffInput,
  PlanReviewVersionDiffResult,
} from "./planReview.ts";
import { ThreadUsage, ThreadUsageInput } from "./threadUsage.ts";
import {
  ThreadCommentsAddInput,
  ThreadCommentsError,
  ThreadCommentsRemoveInput,
  ThreadCommentsReplyInput,
  ThreadCommentsSetDeliveryPausedInput,
  ThreadCommentsSetStatusInput,
  ThreadCommentsSnapshot,
  ThreadCommentsResolveAllInput,
  ThreadCommentsThreadInput,
} from "./threadComments.ts";
import { UsageReadError } from "./usage.ts";
// T3-CUSTOM(expbkt3): Claude account profiles per thread.
import {
  ClaudeAccountsError,
  ClaudeAccountsSetThreadModeInput,
  ClaudeAccountsSnapshot,
  ClaudeAccountsThreadInput,
  ThreadClaudeAccount,
} from "./claudeAccounts.ts";
import {
  SessionArchiveBackfillInput,
  SessionArchiveBackfillResult,
  SessionArchiveError,
  SessionArchiveExportInput,
  SessionArchiveExportResult,
  SessionArchiveReclaimInput,
  SessionArchiveReclaimResult,
  SessionArchiveScanResult,
  ThreadContextExportInput,
  ThreadContextExportResult,
} from "./sessionArchive.ts";
import {
  GitHubSourceControlProfile,
  SourceControlProfileArchiveInput,
  SourceControlProfileError,
  SourceControlProfileIdInput,
  SourceControlProfileReplaceCredentialInput,
  SourceControlProfileUpsertInput,
  SourceControlProfilesListResult,
  SourceControlConvertRemoteInput,
  SourceControlConvertRemoteResult,
  SourceControlThreadOwnerSetInput,
} from "./sourceControlProfiles.ts";
import {
  EnvironmentUser,
  EnvironmentUserDirectoryResult,
  EnvironmentUserIdInput,
  EnvironmentUserManagementError,
  EnvironmentUserSourceControlProfileSetInput,
  EnvironmentUserUpdateInput,
} from "./users.ts";
// T3-CUSTOM(expbkt3): Claude account access per user.
import { ClaudeAccountAccessList, ClaudeAccountsAccessSetInput } from "./claudeAccounts.ts";
// T3-CUSTOM(expbkt3): toolyard auto-connect
import {
  PersonalMcpToolyardConnectInput,
  PersonalMcpToolyardConnectResult,
} from "./personalMcp.ts";

export const WS_FORK_METHODS = {
  personalMcpGetProfile: "personalMcp.getProfile",
  personalMcpUpdateProfile: "personalMcp.updateProfile",
  personalMcpRotateToken: "personalMcp.rotateToken",
  personalMcpRevokeToken: "personalMcp.revokeToken",
  sourceControlProfilesList: "sourceControl.profiles.list",
  sourceControlProfilesUpsert: "sourceControl.profiles.upsert",
  sourceControlProfilesTest: "sourceControl.profiles.test",
  sourceControlProfilesReplaceCredential: "sourceControl.profiles.replaceCredential",
  sourceControlProfilesDisconnect: "sourceControl.profiles.disconnect",
  sourceControlProfilesArchive: "sourceControl.profiles.archive",
  sourceControlThreadOwnerSet: "sourceControl.threadOwner.set",
  sourceControlConvertRemote: "sourceControl.remote.convertToHttps",
  usersList: "users.list",
  usersUpdate: "users.update",
  usersRevokeSessions: "users.revokeSessions",
  usersSourceControlProfileSet: "users.sourceControlProfile.set",
  linearIssuesResolve: "linearIssues.resolve",
  planReviewGet: "planReview.get",
  planReviewList: "planReview.list",
  planReviewSaveDraft: "planReview.saveDraft",
  planReviewCutVersion: "planReview.cutVersion",
  planReviewUpsertDiscussion: "planReview.upsertDiscussion",
  planReviewResolveDiscussion: "planReview.resolveDiscussion",
  planReviewVersionDiff: "planReview.versionDiff",
  planReviewSubmit: "planReview.submit",
  subscribePlanReview: "subscribePlanReview",
  sessionArchiveScan: "sessionArchive.scan",
  sessionArchiveExport: "sessionArchive.export",
  sessionArchiveReclaim: "sessionArchive.reclaim",
  sessionArchiveBackfill: "sessionArchive.backfill",
  threadContextExport: "threadContext.export",
  // T3-CUSTOM(expbkt3): agent-rendered UI surfaces in chat.
  agentUiGetRender: "agentUi.getRender",
  // T3-CUSTOM(expbkt3): per-thread API-level cost.
  threadUsageGet: "threadUsage.get",
  // T3-CUSTOM(expbkt3): review comments on agent messages.
  threadCommentsList: "threadComments.list",
  threadCommentsAdd: "threadComments.add",
  threadCommentsReply: "threadComments.reply",
  threadCommentsSetStatus: "threadComments.setStatus",
  threadCommentsResolveAll: "threadComments.resolveAll",
  threadCommentsRemove: "threadComments.remove",
  threadCommentsSetDeliveryPaused: "threadComments.setDeliveryPaused",
  subscribeThreadComments: "subscribeThreadComments",
  // T3-CUSTOM(expbkt3): Claude account profiles per thread.
  claudeAccountsGetThread: "claudeAccounts.getThread",
  claudeAccountsSetThreadMode: "claudeAccounts.setThreadMode",
  subscribeClaudeAccounts: "subscribeClaudeAccounts",
  subscribeThreadClaudeAccount: "subscribeThreadClaudeAccount",
  // T3-CUSTOM(expbkt3): Claude account access per user (admin only).
  claudeAccountsAccessList: "claudeAccounts.access.list",
  claudeAccountsAccessSet: "claudeAccounts.access.set",
  // T3-CUSTOM(expbkt3): toolyard auto-connect
  personalMcpConnectToolyard: "personalMcp.connectToolyard",
} as const;

export const WsPersonalMcpGetProfileRpc = Rpc.make(WS_FORK_METHODS.personalMcpGetProfile, {
  payload: Schema.Struct({}),
  success: PersonalMcpProfile,
  error: Schema.Union([PersonalMcpSettingsError, EnvironmentAuthorizationError]),
});

export const WsPersonalMcpUpdateProfileRpc = Rpc.make(WS_FORK_METHODS.personalMcpUpdateProfile, {
  payload: PersonalMcpProfileUpdate,
  success: PersonalMcpProfile,
  error: Schema.Union([PersonalMcpSettingsError, EnvironmentAuthorizationError]),
});

export const WsPersonalMcpRotateTokenRpc = Rpc.make(WS_FORK_METHODS.personalMcpRotateToken, {
  payload: Schema.Struct({}),
  success: PersonalMcpTokenResult,
  error: Schema.Union([PersonalMcpSettingsError, EnvironmentAuthorizationError]),
});

export const WsPersonalMcpRevokeTokenRpc = Rpc.make(WS_FORK_METHODS.personalMcpRevokeToken, {
  payload: Schema.Struct({}),
  success: PersonalMcpProfile,
  error: Schema.Union([PersonalMcpSettingsError, EnvironmentAuthorizationError]),
});

export const WsSourceControlProfilesListRpc = Rpc.make(WS_FORK_METHODS.sourceControlProfilesList, {
  payload: Schema.Struct({}),
  success: SourceControlProfilesListResult,
  error: Schema.Union([SourceControlProfileError, EnvironmentAuthorizationError]),
});

export const WsSourceControlProfilesUpsertRpc = Rpc.make(
  WS_FORK_METHODS.sourceControlProfilesUpsert,
  {
    payload: SourceControlProfileUpsertInput,
    success: GitHubSourceControlProfile,
    error: Schema.Union([
      SourceControlProfileError,
      EnvironmentUserManagementError,
      EnvironmentAuthorizationError,
    ]),
  },
);

export const WsSourceControlProfilesTestRpc = Rpc.make(WS_FORK_METHODS.sourceControlProfilesTest, {
  payload: SourceControlProfileIdInput,
  success: GitHubSourceControlProfile,
  error: Schema.Union([
    SourceControlProfileError,
    EnvironmentUserManagementError,
    EnvironmentAuthorizationError,
  ]),
});

export const WsSourceControlProfilesReplaceCredentialRpc = Rpc.make(
  WS_FORK_METHODS.sourceControlProfilesReplaceCredential,
  {
    payload: SourceControlProfileReplaceCredentialInput,
    success: GitHubSourceControlProfile,
    error: Schema.Union([
      SourceControlProfileError,
      EnvironmentUserManagementError,
      EnvironmentAuthorizationError,
    ]),
  },
);

export const WsSourceControlProfilesDisconnectRpc = Rpc.make(
  WS_FORK_METHODS.sourceControlProfilesDisconnect,
  {
    payload: SourceControlProfileIdInput,
    success: GitHubSourceControlProfile,
    error: Schema.Union([
      SourceControlProfileError,
      EnvironmentUserManagementError,
      EnvironmentAuthorizationError,
    ]),
  },
);

export const WsSourceControlProfilesArchiveRpc = Rpc.make(
  WS_FORK_METHODS.sourceControlProfilesArchive,
  {
    payload: SourceControlProfileArchiveInput,
    success: GitHubSourceControlProfile,
    error: Schema.Union([
      SourceControlProfileError,
      EnvironmentUserManagementError,
      EnvironmentAuthorizationError,
    ]),
  },
);

export const WsSourceControlThreadOwnerSetRpc = Rpc.make(
  WS_FORK_METHODS.sourceControlThreadOwnerSet,
  {
    payload: SourceControlThreadOwnerSetInput,
    success: GitHubSourceControlProfile,
    error: Schema.Union([SourceControlProfileError, EnvironmentAuthorizationError]),
  },
);

export const WsSourceControlConvertRemoteRpc = Rpc.make(
  WS_FORK_METHODS.sourceControlConvertRemote,
  {
    payload: SourceControlConvertRemoteInput,
    success: SourceControlConvertRemoteResult,
    error: Schema.Union([SourceControlProfileError, EnvironmentAuthorizationError]),
  },
);

export const WsUsersListRpc = Rpc.make(WS_FORK_METHODS.usersList, {
  payload: Schema.Struct({}),
  success: EnvironmentUserDirectoryResult,
  error: Schema.Union([EnvironmentUserManagementError, EnvironmentAuthorizationError]),
});

export const WsUsersUpdateRpc = Rpc.make(WS_FORK_METHODS.usersUpdate, {
  payload: EnvironmentUserUpdateInput,
  success: EnvironmentUser,
  error: Schema.Union([EnvironmentUserManagementError, EnvironmentAuthorizationError]),
});

export const WsUsersRevokeSessionsRpc = Rpc.make(WS_FORK_METHODS.usersRevokeSessions, {
  payload: EnvironmentUserIdInput,
  success: EnvironmentUser,
  error: Schema.Union([EnvironmentUserManagementError, EnvironmentAuthorizationError]),
});

export const WsUsersSourceControlProfileSetRpc = Rpc.make(
  WS_FORK_METHODS.usersSourceControlProfileSet,
  {
    payload: EnvironmentUserSourceControlProfileSetInput,
    success: EnvironmentUser,
    error: Schema.Union([EnvironmentUserManagementError, EnvironmentAuthorizationError]),
  },
);

export const WsLinearIssuesResolveRpc = Rpc.make(WS_FORK_METHODS.linearIssuesResolve, {
  payload: LinearIssueStatusInput,
  success: LinearIssueStatusResult,
  error: EnvironmentAuthorizationError,
});

// T3-CUSTOM(expbkt3): archived-session worktree reclaim.
export const WsSessionArchiveScanRpc = Rpc.make(WS_FORK_METHODS.sessionArchiveScan, {
  payload: Schema.Struct({}),
  success: SessionArchiveScanResult,
  error: Schema.Union([SessionArchiveError, EnvironmentAuthorizationError]),
});

export const WsSessionArchiveExportRpc = Rpc.make(WS_FORK_METHODS.sessionArchiveExport, {
  payload: SessionArchiveExportInput,
  success: SessionArchiveExportResult,
  error: Schema.Union([SessionArchiveError, EnvironmentAuthorizationError]),
});

export const WsSessionArchiveReclaimRpc = Rpc.make(WS_FORK_METHODS.sessionArchiveReclaim, {
  payload: SessionArchiveReclaimInput,
  success: SessionArchiveReclaimResult,
  error: Schema.Union([SessionArchiveError, EnvironmentAuthorizationError]),
});

export const WsSessionArchiveBackfillRpc = Rpc.make(WS_FORK_METHODS.sessionArchiveBackfill, {
  payload: SessionArchiveBackfillInput,
  success: SessionArchiveBackfillResult,
  error: Schema.Union([SessionArchiveError, EnvironmentAuthorizationError]),
});

// T3-CUSTOM(expbkt3): on-demand context handoff digest for live or archived threads.
export const WsThreadContextExportRpc = Rpc.make(WS_FORK_METHODS.threadContextExport, {
  payload: ThreadContextExportInput,
  success: ThreadContextExportResult,
  error: Schema.Union([SessionArchiveError, EnvironmentAuthorizationError]),
});

// T3-CUSTOM(expbkt3): agent-rendered UI surfaces. The render body is fetched on
// demand rather than pushed through activity payloads, which keeps oversized
// documents off the websocket and out of the activity string cap.
export const WsAgentUiGetRenderRpc = Rpc.make(WS_FORK_METHODS.agentUiGetRender, {
  payload: AgentUiGetRenderInput,
  success: AgentUiGetRenderResult,
  error: Schema.Union([AgentUiError, EnvironmentAuthorizationError]),
});

// T3-CUSTOM(expbkt3): per-thread API-level cost, read-only.
export const WsThreadUsageGetRpc = Rpc.make(WS_FORK_METHODS.threadUsageGet, {
  payload: ThreadUsageInput,
  success: ThreadUsage,
  error: Schema.Union([EnvironmentAuthorizationError, UsageReadError]),
});

// T3-CUSTOM(expbkt3): native plan review.
export const WsPlanReviewGetRpc = Rpc.make(WS_FORK_METHODS.planReviewGet, {
  payload: PlanReviewDocumentIdInput,
  success: PlanReviewSnapshotResult,
  error: Schema.Union([PlanReviewError, EnvironmentAuthorizationError]),
});

export const WsPlanReviewListRpc = Rpc.make(WS_FORK_METHODS.planReviewList, {
  payload: PlanReviewListInput,
  success: PlanReviewListResult,
  error: Schema.Union([PlanReviewError, EnvironmentAuthorizationError]),
});

export const WsPlanReviewSaveDraftRpc = Rpc.make(WS_FORK_METHODS.planReviewSaveDraft, {
  payload: PlanReviewSaveDraftInput,
  success: PlanReviewSaveDraftResult,
  error: Schema.Union([PlanReviewError, EnvironmentAuthorizationError]),
});

export const WsPlanReviewCutVersionRpc = Rpc.make(WS_FORK_METHODS.planReviewCutVersion, {
  payload: PlanReviewCutVersionInput,
  success: PlanReviewSnapshotResult,
  error: Schema.Union([PlanReviewError, EnvironmentAuthorizationError]),
});

export const WsPlanReviewUpsertDiscussionRpc = Rpc.make(
  WS_FORK_METHODS.planReviewUpsertDiscussion,
  {
    payload: PlanReviewUpsertDiscussionInput,
    success: PlanReviewSnapshotResult,
    error: Schema.Union([PlanReviewError, EnvironmentAuthorizationError]),
  },
);

export const WsPlanReviewResolveDiscussionRpc = Rpc.make(
  WS_FORK_METHODS.planReviewResolveDiscussion,
  {
    payload: PlanReviewResolveDiscussionInput,
    success: PlanReviewSnapshotResult,
    error: Schema.Union([PlanReviewError, EnvironmentAuthorizationError]),
  },
);

export const WsPlanReviewVersionDiffRpc = Rpc.make(WS_FORK_METHODS.planReviewVersionDiff, {
  payload: PlanReviewVersionDiffInput,
  success: PlanReviewVersionDiffResult,
  error: Schema.Union([PlanReviewError, EnvironmentAuthorizationError]),
});

export const WsPlanReviewSubmitRpc = Rpc.make(WS_FORK_METHODS.planReviewSubmit, {
  payload: PlanReviewSubmitInput,
  success: PlanReviewSubmitResult,
  error: Schema.Union([PlanReviewError, EnvironmentAuthorizationError]),
});

/** Pushes a fresh snapshot whenever any client mutates the review. */
export const WsSubscribePlanReviewRpc = Rpc.make(WS_FORK_METHODS.subscribePlanReview, {
  payload: PlanReviewDocumentIdInput,
  success: PlanReviewSnapshotResult,
  error: Schema.Union([PlanReviewError, EnvironmentAuthorizationError]),
  stream: true,
});

// T3-CUSTOM(expbkt3): review comments on agent messages. Every mutation returns
// the thread's fresh snapshot; the subscription pushes one after any client's write.
const threadCommentsError = Schema.Union([ThreadCommentsError, EnvironmentAuthorizationError]);

export const WsThreadCommentsListRpc = Rpc.make(WS_FORK_METHODS.threadCommentsList, {
  payload: ThreadCommentsThreadInput,
  success: ThreadCommentsSnapshot,
  error: threadCommentsError,
});

export const WsThreadCommentsAddRpc = Rpc.make(WS_FORK_METHODS.threadCommentsAdd, {
  payload: ThreadCommentsAddInput,
  success: ThreadCommentsSnapshot,
  error: threadCommentsError,
});

export const WsThreadCommentsReplyRpc = Rpc.make(WS_FORK_METHODS.threadCommentsReply, {
  payload: ThreadCommentsReplyInput,
  success: ThreadCommentsSnapshot,
  error: threadCommentsError,
});

export const WsThreadCommentsSetStatusRpc = Rpc.make(WS_FORK_METHODS.threadCommentsSetStatus, {
  payload: ThreadCommentsSetStatusInput,
  success: ThreadCommentsSnapshot,
  error: threadCommentsError,
});

export const WsThreadCommentsResolveAllRpc = Rpc.make(WS_FORK_METHODS.threadCommentsResolveAll, {
  payload: ThreadCommentsResolveAllInput,
  success: ThreadCommentsSnapshot,
  error: threadCommentsError,
});

export const WsThreadCommentsRemoveRpc = Rpc.make(WS_FORK_METHODS.threadCommentsRemove, {
  payload: ThreadCommentsRemoveInput,
  success: ThreadCommentsSnapshot,
  error: threadCommentsError,
});

export const WsThreadCommentsSetDeliveryPausedRpc = Rpc.make(
  WS_FORK_METHODS.threadCommentsSetDeliveryPaused,
  {
    payload: ThreadCommentsSetDeliveryPausedInput,
    success: ThreadCommentsSnapshot,
    error: threadCommentsError,
  },
);

export const WsSubscribeThreadCommentsRpc = Rpc.make(WS_FORK_METHODS.subscribeThreadComments, {
  payload: ThreadCommentsThreadInput,
  success: ThreadCommentsSnapshot,
  error: threadCommentsError,
  stream: true,
});

// T3-CUSTOM(expbkt3): Claude account profiles per thread. The snapshot stream
// pushes every account's limits and live session count; the thread stream
// pushes that thread's mode and the account it resolved to.
const claudeAccountsError = Schema.Union([ClaudeAccountsError, EnvironmentAuthorizationError]);

export const WsClaudeAccountsGetThreadRpc = Rpc.make(WS_FORK_METHODS.claudeAccountsGetThread, {
  payload: ClaudeAccountsThreadInput,
  success: ThreadClaudeAccount,
  error: claudeAccountsError,
});

export const WsClaudeAccountsSetThreadModeRpc = Rpc.make(
  WS_FORK_METHODS.claudeAccountsSetThreadMode,
  {
    payload: ClaudeAccountsSetThreadModeInput,
    success: ThreadClaudeAccount,
    error: claudeAccountsError,
  },
);

export const WsSubscribeClaudeAccountsRpc = Rpc.make(WS_FORK_METHODS.subscribeClaudeAccounts, {
  payload: Schema.Struct({}),
  success: ClaudeAccountsSnapshot,
  error: claudeAccountsError,
  stream: true,
});

export const WsSubscribeThreadClaudeAccountRpc = Rpc.make(
  WS_FORK_METHODS.subscribeThreadClaudeAccount,
  {
    payload: ClaudeAccountsThreadInput,
    success: ThreadClaudeAccount,
    error: claudeAccountsError,
    stream: true,
  },
);

// T3-CUSTOM(expbkt3): Claude account access per user. Admins list and replace
// each account's allow list; the handlers refuse everyone else as `forbidden`.
export const WsClaudeAccountsAccessListRpc = Rpc.make(WS_FORK_METHODS.claudeAccountsAccessList, {
  payload: Schema.Struct({}),
  success: ClaudeAccountAccessList,
  error: claudeAccountsError,
});

export const WsClaudeAccountsAccessSetRpc = Rpc.make(WS_FORK_METHODS.claudeAccountsAccessSet, {
  payload: ClaudeAccountsAccessSetInput,
  success: ClaudeAccountAccessList,
  error: claudeAccountsError,
});

// T3-CUSTOM(expbkt3): toolyard auto-connect
/**
 * Connects the built-in toolyard integration: the server exchanges the
 * browser's Clerk token for a toolyard agent token and stores it. toolyard's
 * own refusals come back as `error` codes, never as an RPC failure.
 */
export const WsPersonalMcpConnectToolyardRpc = Rpc.make(
  WS_FORK_METHODS.personalMcpConnectToolyard,
  {
    payload: PersonalMcpToolyardConnectInput,
    success: PersonalMcpToolyardConnectResult,
    error: Schema.Union([PersonalMcpSettingsError, EnvironmentAuthorizationError]),
  },
);

export const FORK_WS_RPCS = [
  WsThreadCommentsListRpc,
  WsThreadCommentsAddRpc,
  WsThreadCommentsReplyRpc,
  WsThreadCommentsSetStatusRpc,
  WsThreadCommentsResolveAllRpc,
  WsThreadCommentsRemoveRpc,
  WsThreadCommentsSetDeliveryPausedRpc,
  WsSubscribeThreadCommentsRpc,
  WsThreadUsageGetRpc,
  WsPlanReviewGetRpc,
  WsPlanReviewListRpc,
  WsPlanReviewSaveDraftRpc,
  WsPlanReviewCutVersionRpc,
  WsPlanReviewUpsertDiscussionRpc,
  WsPlanReviewResolveDiscussionRpc,
  WsPlanReviewVersionDiffRpc,
  WsPlanReviewSubmitRpc,
  WsSubscribePlanReviewRpc,
  WsPersonalMcpGetProfileRpc,
  WsPersonalMcpUpdateProfileRpc,
  WsPersonalMcpRotateTokenRpc,
  WsPersonalMcpRevokeTokenRpc,
  WsSourceControlProfilesListRpc,
  WsSourceControlProfilesUpsertRpc,
  WsSourceControlProfilesTestRpc,
  WsSourceControlProfilesReplaceCredentialRpc,
  WsSourceControlProfilesDisconnectRpc,
  WsSourceControlProfilesArchiveRpc,
  WsSourceControlThreadOwnerSetRpc,
  WsSourceControlConvertRemoteRpc,
  WsUsersListRpc,
  WsUsersUpdateRpc,
  WsUsersRevokeSessionsRpc,
  WsUsersSourceControlProfileSetRpc,
  WsLinearIssuesResolveRpc,
  WsSessionArchiveScanRpc,
  WsSessionArchiveExportRpc,
  WsSessionArchiveReclaimRpc,
  WsSessionArchiveBackfillRpc,
  WsThreadContextExportRpc,
  WsAgentUiGetRenderRpc,
  // T3-CUSTOM(expbkt3): Claude account profiles per thread.
  WsClaudeAccountsGetThreadRpc,
  WsClaudeAccountsSetThreadModeRpc,
  WsSubscribeClaudeAccountsRpc,
  WsSubscribeThreadClaudeAccountRpc,
  // T3-CUSTOM(expbkt3): Claude account access per user.
  WsClaudeAccountsAccessListRpc,
  WsClaudeAccountsAccessSetRpc,
  // T3-CUSTOM(expbkt3): toolyard auto-connect
  WsPersonalMcpConnectToolyardRpc,
] as const;
