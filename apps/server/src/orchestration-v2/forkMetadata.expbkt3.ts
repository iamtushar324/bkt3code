// T3-CUSTOM(expbkt3): retained BK behavior at the native V2 boundary.
import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import { threadLinearLinks } from "@t3tools/shared/linearIssue";

/** Durable fork fields shared by native and compatibility shell projections. */
export const forkThreadMetadata = (thread: OrchestrationV2AppThread) => ({
  pendingAsyncUserInputIds: thread.pendingAsyncUserInputIds ?? [],
  titleManuallySet: thread.titleManuallySet ?? false,
  ownerUserId: thread.ownerUserId ?? null,
  memberUserIds: thread.memberUserIds ?? [],
  sourceControlProfileId: thread.sourceControlProfileId ?? null,
  priority: thread.priority ?? null,
  customGroup: thread.customGroup ?? null,
  linearIssueUrl: thread.linearIssueUrl ?? null,
  // Threads tagged before multi-tagging read their single tag as a list.
  linearLinks: threadLinearLinks(thread),
  mattermostThreadUrl: thread.mattermostThreadUrl ?? null,
  parentThreadId:
    thread.parentThreadId === undefined ? thread.lineage.parentThreadId : thread.parentThreadId,
  parentEnvironmentId: thread.parentEnvironmentId ?? null,
});
