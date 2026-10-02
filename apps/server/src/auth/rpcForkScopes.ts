/**
 * T3-CUSTOM(expbkt3): Authorization scopes for fork-only RPC methods.
 *
 * Upstream owns `RPC_REQUIRED_SCOPES` in `RpcAuthorization.ts`, and every method
 * in `WsRpcGroup` must appear there or `requiredScopeForRpcMethod` throws. The
 * fork's methods are declared here and spread in through a single seam so the
 * upstream table stays a one-line fork diff.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ORCHESTRATION_WS_METHODS,
  WS_FORK_METHODS,
} from "@t3tools/contracts";

export const FORK_RPC_REQUIRED_SCOPES = {
  [WS_FORK_METHODS.personalMcpGetProfile]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.personalMcpUpdateProfile]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.personalMcpRotateToken]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.personalMcpRevokeToken]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.sourceControlProfilesList]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.sourceControlProfilesUpsert]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.sourceControlProfilesTest]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.sourceControlProfilesReplaceCredential]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.sourceControlProfilesDisconnect]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.sourceControlProfilesArchive]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.sourceControlThreadOwnerSet]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.sourceControlConvertRemote]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.usersList]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.usersUpdate]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.usersRevokeSessions]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.usersSourceControlProfileSet]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.linearIssuesResolve]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.planReviewGet]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.planReviewList]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.planReviewVersionDiff]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.subscribePlanReview]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.planReviewSaveDraft]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.planReviewCutVersion]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.planReviewUpsertDiscussion]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.planReviewResolveDiscussion]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.planReviewSubmit]: AuthOrchestrationOperateScope,
  // T3-CUSTOM(expbkt3): archived-session worktree reclaim. Scanning is a read;
  // exporting writes files and reclaiming deletes them, so both need operate.
  [WS_FORK_METHODS.sessionArchiveScan]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.sessionArchiveExport]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.sessionArchiveReclaim]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.sessionArchiveBackfill]: AuthOrchestrationOperateScope,
  // T3-CUSTOM(expbkt3): context handoff renders a string and writes nothing.
  [WS_FORK_METHODS.threadContextExport]: AuthOrchestrationReadScope,
  // T3-CUSTOM(expbkt3): agent-rendered UI surfaces. A read of thread content,
  // and the handler additionally gates on per-thread access.
  [WS_FORK_METHODS.agentUiGetRender]: AuthOrchestrationReadScope,
  // T3-CUSTOM(expbkt3): per-thread cost is a read of that thread's usage.
  [WS_FORK_METHODS.threadUsageGet]: AuthOrchestrationReadScope,
  // T3-CUSTOM(expbkt3): review comments on assistant messages. Listing and
  // subscribing read thread content; every mutation needs operate, and the
  // handlers additionally gate on per-thread access.
  [WS_FORK_METHODS.threadCommentsList]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.subscribeThreadComments]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.threadCommentsAdd]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.threadCommentsReply]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.threadCommentsSetStatus]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.threadCommentsResolveAll]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.threadCommentsRemove]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.threadCommentsSetDeliveryPaused]: AuthOrchestrationOperateScope,
  // T3-CUSTOM(expbkt3): Claude account profiles per thread. Reading the host
  // snapshot or a thread's account is a read; choosing the account is operate.
  [WS_FORK_METHODS.claudeAccountsGetThread]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.subscribeClaudeAccounts]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.subscribeThreadClaudeAccount]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.claudeAccountsSetThreadMode]: AuthOrchestrationOperateScope,
} as const;
