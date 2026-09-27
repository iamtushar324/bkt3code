/**
 * T3-CUSTOM(expbkt3): build a handoff digest from the client's own cache.
 *
 * Handing a session off is at its most valuable exactly when the host that owns
 * it is unreachable: the work has stalled, and the operator wants to carry the
 * context somewhere that still runs. The server RPC cannot answer then, so this
 * renders the same digest from the thread snapshot the client already holds.
 *
 * It is deliberately the *same* renderer the host uses. What differs is only
 * what the client can know: there is no git state to read from another machine,
 * and the cached window may not reach the start of the conversation. Both are
 * declared in the digest itself rather than papered over, so the agent that
 * receives it can tell how much to trust it.
 *
 * @module handoff/offlineDigest
 */
import {
  renderThreadContextDigest,
  type ThreadContextDigestInput,
} from "@t3tools/shared/sessionDigest";
import type {
  OrchestrationProjectShell,
  OrchestrationThread,
  ThreadContextExportResult,
} from "@t3tools/contracts";

export const OFFLINE_DIGEST_PROVENANCE_NOTE =
  "Built from a local cache while the host that owns this session was unreachable: " +
  "there is no git state below, and messages sent after the last sync are missing. " +
  "Re-read the worktree before acting on anything here.";

export interface CachedThreadDigestInput {
  readonly thread: OrchestrationThread;
  /** Names the workspace in the digest; absent when the shell cache lacks it. */
  readonly project: OrchestrationProjectShell | null;
  /** True when older turns exist on the host but not in the cached window. */
  readonly hasMoreHistory: boolean;
}

export interface CachedThreadDigest extends ThreadContextExportResult {
  /** Distinguishes this from a host-rendered digest at the call site. */
  readonly source: "cache";
}

export function cachedThreadDigestInput(input: CachedThreadDigestInput): ThreadContextDigestInput {
  const { thread, project, hasMoreHistory } = input;
  return {
    threadId: thread.id,
    title: thread.title,
    projectName: project?.title ?? "unknown-project",
    workspaceRoot: project?.workspaceRoot ?? "",
    worktreePath: thread.worktreePath,
    branch: thread.branch,
    providerInstanceId: thread.modelSelection.instanceId,
    model: thread.modelSelection.model,
    createdAt: thread.createdAt,
    // Git facts are read from the host's filesystem, which is the thing that is
    // unreachable. Rendering "no git information" is honest; guessing is not.
    git: null,
    messages: thread.messages.map((message) => ({
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
    })),
    provenanceNote: OFFLINE_DIGEST_PROVENANCE_NOTE,
    historyIncomplete: hasMoreHistory,
  };
}

export function renderCachedThreadDigest(input: CachedThreadDigestInput): CachedThreadDigest {
  const digest = renderThreadContextDigest(cachedThreadDigestInput(input));
  return {
    threadId: input.thread.id,
    projectId: input.thread.projectId,
    title: input.thread.title,
    markdown: digest.markdown,
    messageCount: input.thread.messages.length,
    // The cached window itself elides history, so a handoff built from it is
    // truncated whenever either the renderer or the cache dropped something.
    truncated: digest.truncated || input.hasMoreHistory,
    source: "cache",
  };
}
