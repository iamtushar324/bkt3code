import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as O from "effect/Order";
import { computeTurnDurationMs } from "@t3tools/contracts";
import type {
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationTurnCatchupSummary,
  ThreadPullRequestLink,
  TurnId,
} from "@t3tools/contracts";
import { threadPullRequestKeysEqual } from "@t3tools/shared/threadPullRequests";
import { isImportedAgentSessionMessageId } from "@t3tools/contracts";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";

export type ThreadDetailReducerResult =
  | { readonly kind: "updated"; readonly thread: OrchestrationThread }
  | { readonly kind: "deleted" }
  | { readonly kind: "unchanged" };

/** Keep only a legacy route supplied by the server; detail events cannot resolve project hosts. */
function withPullRequests(
  thread: OrchestrationThread,
  pullRequests: ReadonlyArray<ThreadPullRequestLink>,
  updatedAt: string,
): ThreadDetailReducerResult {
  return {
    kind: "updated",
    thread: {
      ...thread,
      pullRequests,
      linkedPullRequest:
        thread.linkedPullRequest &&
        pullRequests.some(
          (link) => link.source !== "stack-dismissed" && link.url === thread.linkedPullRequest?.url,
        )
          ? thread.linkedPullRequest
          : null,
      updatedAt,
    },
  };
}

const proposedPlanOrder = O.combine<OrchestrationThread["proposedPlans"][number]>(
  O.mapInput(O.String, (p) => p.createdAt),
  O.mapInput(O.String, (p) => p.id),
);

const checkpointOrder = O.mapInput(
  O.Number,
  (cp: OrchestrationThread["checkpoints"][number]) =>
    cp.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER,
);

const turnSummaryOrder = O.mapInput(
  O.String,
  (summary: OrchestrationTurnCatchupSummary) => summary.createdAt,
);

const activityOrder = O.combineAll<OrchestrationThreadActivity>([
  O.mapInput(O.Number, (a) => a.sequence ?? Number.MAX_SAFE_INTEGER),
  O.mapInput(O.String, (a) => a.createdAt),
  O.mapInput(O.String, (a) => a.id),
]);

// Per-array id index so the streaming append path can reject a re-delivered
// id without rescanning the history. Only arrays this reducer produced are
// indexed: presence also proves the array is activityOrder-sorted, which
// snapshot-loaded arrays (DB order, null sequences first) are not.
const activityIdIndex = new WeakMap<
  ReadonlyArray<OrchestrationThreadActivity>,
  Set<OrchestrationThreadActivity["id"]>
>();

/**
 * Matches the validity rule in `deriveLatestContextWindowSnapshot` (and the
 * server's snapshot-side `dropStaleContextWindowActivities`): rows without a
 * finite, non-negative `usedTokens` are skipped during the consumer's backward
 * walk, so they must not replace an earlier resolvable row here.
 */
function isResolvableContextWindowActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-window.updated") {
    return false;
  }
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const usedTokens = payload?.usedTokens;
  return typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
}

/**
 * Apply a single orchestration event to an `OrchestrationThread`, returning
 * the updated thread, a deletion signal, or an "unchanged" marker when the
 * event doesn't affect this thread.
 *
 * This is a pure reducer operating on contract types. UI-specific mapping
 * (e.g. resolving attachment preview URLs, normalising model slugs, adding
 * scoped fields like `environmentId`) is the caller's responsibility.
 */
export function applyThreadDetailEvent(
  thread: OrchestrationThread,
  event: OrchestrationEvent,
): ThreadDetailReducerResult {
  switch (event.type) {
    // ── Project events (irrelevant to thread detail) ────────────────
    case "project.created":
    case "project.meta-updated":
    case "project.deleted":
      return { kind: "unchanged" };

    // ── Thread lifecycle ────────────────────────────────────────────
    case "thread.created":
      return {
        kind: "updated",
        thread: {
          id: event.payload.threadId,
          projectId: event.payload.projectId,
          title: event.payload.title,
          modelSelection: event.payload.modelSelection,
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          branch: event.payload.branch,
          worktreePath: event.payload.worktreePath,
          sourceControlProfileId: event.payload.sourceControlProfileId,
          // T3-CUSTOM(expbkt3): bootstrap arrives in its own durable event.
          bootstrap: null,
          branchPullRequest: null,
          latestTurn: null,
          ownerUserId: event.payload.createdByUserId ?? null,
          // T3-CUSTOM(expbkt3): BEGIN — creation tags the authenticated owner too.
          memberUserIds:
            event.payload.createdByUserId === null || event.payload.createdByUserId === undefined
              ? []
              : [event.payload.createdByUserId],
          // T3-CUSTOM(expbkt3): END
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          unsettledAt: null,
          activeOrderKey: null,
          snoozedUntil: null,
          snoozedAt: null,
          deletedAt: null,
          pullRequests: [],
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          rollingSummary: null,
          // T3-CUSTOM(expbkt3): work summaries stream into the active thread detail.
          workSummary: null,
          turnSummaries: [],
          session: null,
        },
      };

    case "thread.deleted":
      return { kind: "deleted" };

    case "thread.source-control-profile-set":
      return event.payload.threadId === thread.id
        ? {
            kind: "updated",
            thread: {
              ...thread,
              sourceControlProfileId: event.payload.sourceControlProfileId,
              updatedAt: event.payload.changedAt,
            },
          }
        : { kind: "unchanged" };

    case "thread.archived":
      return {
        kind: "updated",
        thread: {
          ...thread,
          archivedAt: event.payload.archivedAt,
          titleRegeneration: null,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unarchived":
      return {
        kind: "updated",
        thread: { ...thread, archivedAt: null, updatedAt: event.payload.updatedAt },
      };

    case "thread.settled":
      return {
        kind: "updated",
        thread: {
          ...thread,
          settledOverride: "settled",
          settledAt: event.payload.settledAt,
          unsettledAt: null,
          activeOrderKey: null,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unsettled":
      return {
        kind: "updated",
        thread: {
          ...thread,
          settledOverride: event.payload.reason === "user" ? "active" : null,
          settledAt: null,
          // A thread already pinned active keeps its re-entry stamp: the
          // activity reset that clears the pin must not reorder the list.
          unsettledAt:
            thread.settledOverride === "active"
              ? (thread.unsettledAt ?? null)
              : event.payload.updatedAt,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.snoozed":
      return {
        kind: "updated",
        thread: {
          ...thread,
          snoozedUntil: event.payload.snoozedUntil,
          snoozedAt: event.payload.snoozedAt,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unsnoozed":
      return {
        kind: "updated",
        thread: {
          ...thread,
          snoozedUntil: null,
          snoozedAt: null,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.pinned":
      return {
        kind: "updated",
        thread: {
          ...thread,
          pinnedAt: event.payload.pinnedAt,
          ...(event.payload.pinOrderKey !== undefined
            ? { pinOrderKey: event.payload.pinOrderKey }
            : {}),
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unpinned":
      return {
        kind: "updated",
        thread: {
          ...thread,
          pinnedAt: null,
          pinOrderKey: null,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.pin-reordered":
      return {
        kind: "updated",
        thread: {
          ...thread,
          pinOrderKey: event.payload.orderKey,
          updatedAt: event.payload.updatedAt,
        },
      };

    // ── Thread metadata ─────────────────────────────────────────────
    case "thread.meta-updated":
      return {
        kind: "updated",
        thread: {
          ...thread,
          ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
          ...(event.payload.titleRegeneration !== undefined
            ? { titleRegeneration: event.payload.titleRegeneration }
            : {}),
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
          ...(event.payload.worktreePath !== undefined
            ? { worktreePath: event.payload.worktreePath }
            : {}),
          // T3-CUSTOM(expbkt3): session priority.
          ...(event.payload.priority !== undefined ? { priority: event.payload.priority } : {}),
          // T3-CUSTOM(expbkt3): durable manual Linear tag.
          ...(event.payload.linearIssueUrl !== undefined
            ? { linearIssueUrl: event.payload.linearIssueUrl }
            : {}),
          // T3-CUSTOM(expbkt3): durable Mattermost conversation link.
          ...(event.payload.mattermostThreadUrl !== undefined
            ? { mattermostThreadUrl: event.payload.mattermostThreadUrl }
            : {}),
          // T3-CUSTOM(expbkt3): session lineage re-parent / detach. The parent's
          // environment travels with its id, so a lineage that moved across
          // machines renders without waiting for a refetch.
          ...(event.payload.parentThreadId !== undefined
            ? { parentThreadId: event.payload.parentThreadId }
            : {}),
          ...(event.payload.parentEnvironmentId !== undefined
            ? { parentEnvironmentId: event.payload.parentEnvironmentId }
            : {}),
          ...(event.payload.linkedPullRequest !== undefined
            ? { linkedPullRequest: event.payload.linkedPullRequest }
            : {}),
          ...(event.payload.branchPullRequest !== undefined
            ? { branchPullRequest: event.payload.branchPullRequest }
            : {}),
          ...(event.payload.activeOrderKey !== undefined
            ? { activeOrderKey: event.payload.activeOrderKey }
            : {}),
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.member-added":
      return thread.memberUserIds.includes(event.payload.userId)
        ? { kind: "unchanged" }
        : {
            kind: "updated",
            thread: {
              ...thread,
              memberUserIds: [...thread.memberUserIds, event.payload.userId],
              updatedAt: event.payload.addedAt,
            },
          };

    case "thread.member-removed":
      return thread.memberUserIds.includes(event.payload.userId)
        ? {
            kind: "updated",
            thread: {
              ...thread,
              memberUserIds: thread.memberUserIds.filter((id) => id !== event.payload.userId),
              updatedAt: event.payload.removedAt,
            },
          }
        : { kind: "unchanged" };

    case "thread.owner-transferred": {
      const memberUserIds = thread.memberUserIds.filter((id) => id !== event.payload.ownerUserId);
      if (
        event.payload.previousOwnerUserId !== null &&
        event.payload.previousOwnerUserId !== event.payload.ownerUserId &&
        !memberUserIds.includes(event.payload.previousOwnerUserId)
      ) {
        memberUserIds.push(event.payload.previousOwnerUserId);
      }
      return {
        kind: "updated",
        thread: {
          ...thread,
          ownerUserId: event.payload.ownerUserId,
          memberUserIds,
          updatedAt: event.payload.transferredAt,
        },
      };
    }

    case "project.member-added":
    case "project.member-removed":
    case "project.owner-transferred":
      return { kind: "unchanged" };

    case "thread.pull-request-linked": {
      const link = event.payload.link;
      const others = thread.pullRequests.filter(
        (existing) => !threadPullRequestKeysEqual(existing, link),
      );
      return withPullRequests(thread, [...others, link], event.payload.updatedAt);
    }

    case "thread.pull-request-unlinked":
      return withPullRequests(
        thread,
        thread.pullRequests.filter(
          (existing) => !threadPullRequestKeysEqual(existing, event.payload),
        ),
        event.payload.updatedAt,
      );

    case "thread.pull-request-synced": {
      if (
        !thread.pullRequests.some((existing) => threadPullRequestKeysEqual(existing, event.payload))
      ) {
        return { kind: "unchanged" };
      }
      return withPullRequests(
        thread,
        thread.pullRequests.map((existing) =>
          threadPullRequestKeysEqual(existing, event.payload)
            ? { ...existing, snapshot: event.payload.snapshot, stack: event.payload.stack }
            : existing,
        ),
        event.payload.updatedAt,
      );
    }

    case "thread.runtime-mode-set":
      return {
        kind: "updated",
        thread: {
          ...thread,
          runtimeMode: event.payload.runtimeMode,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.interaction-mode-set":
      return {
        kind: "updated",
        thread: {
          ...thread,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.payload.updatedAt,
        },
      };

    // ── Turn lifecycle ──────────────────────────────────────────────
    case "thread.turn-start-requested":
      return {
        kind: "updated",
        thread: {
          ...thread,
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.occurredAt,
        },
      };

    case "thread.turn-interrupt-requested": {
      if (event.payload.turnId === undefined) {
        return { kind: "unchanged" };
      }
      const latestTurn = thread.latestTurn;
      if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
        return { kind: "unchanged" };
      }
      return {
        kind: "updated",
        thread: {
          ...thread,
          latestTurn: {
            ...latestTurn,
            state: "interrupted",
            startedAt: latestTurn.startedAt ?? event.payload.createdAt,
            completedAt: latestTurn.completedAt ?? event.payload.createdAt,
            durationMs: computeTurnDurationMs(
              latestTurn.startedAt ?? event.payload.createdAt,
              latestTurn.completedAt ?? event.payload.createdAt,
            ),
          },
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Messages ────────────────────────────────────────────────────
    case "thread.message-sent": {
      const message: OrchestrationMessage = {
        id: event.payload.messageId,
        role: event.payload.role,
        text: event.payload.text,
        ...(event.payload.attachments !== undefined
          ? { attachments: event.payload.attachments }
          : {}),
        ...(event.payload.context !== undefined ? { context: event.payload.context } : {}),
        turnId: event.payload.turnId,
        streaming: event.payload.streaming,
        sentByUserId: event.payload.sentByUserId ?? null,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
      };

      let found = false;
      const messages = thread.messages.map((entry) => {
        if (entry.id !== message.id) return entry;
        found = true;
        return {
          ...entry,
          text: message.streaming
            ? `${entry.text}${message.text}`
            : message.text.length > 0
              ? message.text
              : entry.text,
          streaming: message.streaming,
          ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
          ...(message.streaming ? {} : { updatedAt: message.updatedAt }),
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          ...(message.context !== undefined ? { context: message.context } : {}),
        };
      });
      if (!found) messages.push(message);
      // T3-CUSTOM(expbkt3): Messages can annotate a turn, but they cannot settle it. Only an
      // observed execution transition has lifecycle authority.
      const messageTurnStartedAt =
        thread.latestTurn?.turnId === event.payload.turnId
          ? (thread.latestTurn.startedAt ?? event.payload.createdAt)
          : event.payload.createdAt;
      const messageTurnCompletedAt =
        thread.latestTurn?.turnId === event.payload.turnId
          ? (thread.latestTurn.completedAt ?? null)
          : null;
      const latestTurn = reuseLatestTurn(
        thread.latestTurn,
        event.payload.role === "assistant" &&
          event.payload.turnId !== null &&
          (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
          ? {
              turnId: event.payload.turnId,
              state: thread.latestTurn?.state ?? "running",
              requestedAt:
                thread.latestTurn?.turnId === event.payload.turnId
                  ? thread.latestTurn.requestedAt
                  : event.payload.createdAt,
              startedAt: messageTurnStartedAt,
              completedAt: messageTurnCompletedAt,
              assistantMessageId: event.payload.messageId,
              durationMs: computeTurnDurationMs(messageTurnStartedAt, messageTurnCompletedAt),
            }
          : thread.latestTurn,
      );

      // Rebind checkpoint assistant message IDs for assistant messages. The
      // helper hands back the same array when the entry is already bound.
      const checkpoints =
        event.payload.role === "assistant" && event.payload.turnId !== null
          ? rebindCheckpointAssistantMessage(
              thread.checkpoints,
              event.payload.turnId,
              event.payload.messageId,
            )
          : thread.checkpoints;

      return {
        kind: "updated",
        thread: {
          ...thread,
          messages,
          checkpoints,
          latestTurn,
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Session ─────────────────────────────────────────────────────
    case "thread.session-set": {
      return {
        kind: "updated",
        thread: {
          ...thread,
          session: event.payload.session,
          updatedAt: event.occurredAt,
        },
      };
    }

    case "thread.session-stop-requested":
    case "thread.session-restart-requested":
      // An intent receipt is not a lifecycle observation. The execution
      // snapshot (and, for internal cleanup, a later session-set event) owns
      // the visible state transition.
      return { kind: "unchanged" };

    // ── Proposed plans ──────────────────────────────────────────────
    case "thread.proposed-plan-upserted": {
      const proposedPlan = event.payload.proposedPlan;

      const proposedPlans = pipe(
        thread.proposedPlans,
        Arr.filter((entry) => entry.id !== proposedPlan.id),
        Arr.append(proposedPlan),
        Arr.sort(proposedPlanOrder),
      );

      return {
        kind: "updated",
        thread: { ...thread, proposedPlans, updatedAt: event.occurredAt },
      };
    }

    // ── Checkpoints / turn diffs ────────────────────────────────────
    case "thread.turn-diff-completed": {
      const checkpoint: OrchestrationCheckpointSummary = {
        turnId: event.payload.turnId,
        checkpointTurnCount: event.payload.checkpointTurnCount,
        checkpointRef: event.payload.checkpointRef,
        status: event.payload.status,
        files: event.payload.files,
        assistantMessageId: event.payload.assistantMessageId,
        completedAt: event.payload.completedAt,
      };

      const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
      // Don't overwrite a non-missing checkpoint with a missing one.
      if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
        return { kind: "unchanged" };
      }

      const checkpoints = pipe(
        thread.checkpoints,
        Arr.filter((entry) => entry.turnId !== checkpoint.turnId),
        Arr.append(checkpoint),
        Arr.sort(checkpointOrder),
      );

      return {
        kind: "updated",
        thread: { ...thread, checkpoints, updatedAt: event.occurredAt },
      };
    }

    // ── Revert ──────────────────────────────────────────────────────
    case "thread.reverted": {
      const checkpoints = pipe(
        thread.checkpoints,
        Arr.filter(
          (entry) =>
            entry.checkpointTurnCount !== undefined &&
            entry.checkpointTurnCount <= event.payload.turnCount,
        ),
        Arr.sort(checkpointOrder),
      );

      const retainedTurnIds = new Set(Arr.map(checkpoints, (entry) => entry.turnId));
      const messages = retainMessagesAfterRevert(
        thread.messages,
        retainedTurnIds,
        event.payload.turnCount,
      );
      const proposedPlans = pipe(
        thread.proposedPlans,
        Arr.filter((plan) => plan.turnId === null || retainedTurnIds.has(plan.turnId)),
      );
      const activities = pipe(
        thread.activities,
        Arr.filter((activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId)),
      );
      // Drop catch-up cards for turns the revert removed.
      const turnSummaries = pipe(
        thread.turnSummaries,
        Arr.filter((entry) => retainedTurnIds.has(entry.turnId)),
      );
      const latestCheckpoint = checkpoints.at(-1) ?? null;

      return {
        kind: "updated",
        thread: {
          ...thread,
          checkpoints,
          messages,
          proposedPlans,
          activities,
          turnSummaries,
          latestTurn:
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToTurnState(
                    latestCheckpoint.status as "ready" | "missing" | "error",
                  ),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                  // Reverted turns collapse to a single checkpoint instant.
                  durationMs: 0,
                },
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Catch-up summaries ──────────────────────────────────────────
    case "thread.catchup-summary-updated": {
      // A null rolling summary means "unchanged" (e.g. the pending marker).
      const rollingSummary = event.payload.rollingSummary ?? thread.rollingSummary;
      const withoutTurn = pipe(
        thread.turnSummaries,
        Arr.filter((entry) => entry.turnId !== event.payload.turnId),
      );

      // "cleared" retracts the card for a below-cutoff turn. Failures remain
      // present as an "error" summary so the user can retry in place.
      if (event.payload.progress === "cleared") {
        return {
          kind: "updated",
          thread: { ...thread, rollingSummary, turnSummaries: withoutTurn },
        };
      }

      const turnSummaries = pipe(
        withoutTurn,
        Arr.append({
          turnId: event.payload.turnId,
          assistantMessageId: event.payload.assistantMessageId,
          summary: event.payload.displaySummary,
          status: event.payload.progress,
          createdAt: event.payload.createdAt,
        }),
        Arr.sort(turnSummaryOrder),
      );

      return {
        kind: "updated",
        thread: { ...thread, rollingSummary, turnSummaries },
      };
    }

    // T3-CUSTOM(expbkt3): BEGIN — keep the composer summary player in sync.
    case "thread.work-summary-requested":
      return event.payload.threadId === thread.id
        ? {
            kind: "updated",
            thread: {
              ...thread,
              workSummary: {
                status: "pending",
                summary: null,
                stage: null,
                remaining: null,
                percent: null,
                error: null,
                requestId: event.payload.requestId,
                updatedAt: event.payload.requestedAt,
              },
            },
          }
        : { kind: "unchanged" };

    case "thread.work-summary-updated":
      return event.payload.threadId === thread.id &&
        (thread.workSummary?.requestId === null ||
          thread.workSummary?.requestId === undefined ||
          thread.workSummary.requestId === event.payload.requestId)
        ? {
            kind: "updated",
            thread: { ...thread, workSummary: event.payload.workSummary },
          }
        : { kind: "unchanged" };
    // T3-CUSTOM(expbkt3): END

    // ── Activities ──────────────────────────────────────────────────
    case "thread.activity-appended": {
      const activity = event.payload.activity;
      // A resolvable context-window update supersedes earlier resolvable ones
      // for the same turn: consumers only read the latest value (walking the
      // array backwards), and providers stream these updates continuously, so
      // retaining the history grows the thread by thousands of rows over a
      // long session. Mirrors the server-side snapshot rule in
      // dropStaleContextWindowActivities; retention stays per turn so a
      // thread.reverted that discards turns can still resolve a value from
      // the turns that survive.
      const supersedesContextWindow = isResolvableContextWindowActivity(activity);
      // Live streams append in order: an unseen id sorting at/after the tail
      // of a known-sorted array appends without re-filtering and re-sorting
      // the whole history on every event. The id set moves forward to the new
      // array; a superseded array falls back to the sorting path.
      const ids = activityIdIndex.get(thread.activities);
      const lastActivity = thread.activities.at(-1);
      if (
        !supersedesContextWindow &&
        ids !== undefined &&
        (lastActivity === undefined || activityOrder(lastActivity, activity) <= 0) &&
        !ids.has(activity.id)
      ) {
        const activities = Arr.append(thread.activities, activity);
        activityIdIndex.delete(thread.activities);
        ids.add(activity.id);
        activityIdIndex.set(activities, ids);
        return {
          kind: "updated",
          thread: {
            ...thread,
            activities,
            updatedAt: event.occurredAt,
          },
        };
      }
      // T3-CUSTOM(expbkt3): BEGIN — an in-order context-window update drops the
      // rows it supersedes in one linear pass instead of re-filtering, re-sorting
      // and re-indexing the whole history. These updates are ~20% of a busy
      // thread's activities, so replaying a long thread paid a full sort for each.
      // Same result as the path below: the array is sorted, the id is unseen and
      // the new row sorts at/after the tail, so it simply goes last.
      if (
        supersedesContextWindow &&
        ids !== undefined &&
        (lastActivity === undefined || activityOrder(lastActivity, activity) <= 0) &&
        !ids.has(activity.id)
      ) {
        const activities: OrchestrationThreadActivity[] = [];
        for (const entry of thread.activities) {
          if (entry.turnId === activity.turnId && isResolvableContextWindowActivity(entry)) {
            ids.delete(entry.id);
          } else {
            activities.push(entry);
          }
        }
        activities.push(activity);
        activityIdIndex.delete(thread.activities);
        ids.add(activity.id);
        activityIdIndex.set(activities, ids);
        return {
          kind: "updated",
          thread: { ...thread, activities, updatedAt: event.occurredAt },
        };
      }
      // T3-CUSTOM(expbkt3): END
      const activities = pipe(
        thread.activities,
        Arr.filter(
          (entry) =>
            entry.id !== activity.id &&
            !(
              supersedesContextWindow &&
              entry.turnId === activity.turnId &&
              isResolvableContextWindowActivity(entry)
            ),
        ),
        Arr.append(activity),
        Arr.sort(activityOrder),
      );
      activityIdIndex.set(activities, new Set(activities.map((entry) => entry.id)));

      return {
        kind: "updated",
        thread: { ...thread, activities, updatedAt: event.occurredAt },
      };
    }

    // T3-CUSTOM(expbkt3): durable worktree/setup/agent progress is reduced from
    // events so live views and reconnected snapshots converge identically.
    case "thread.bootstrap-requested":
      return event.payload.threadId === thread.id
        ? {
            kind: "updated",
            thread: {
              ...thread,
              bootstrap: event.payload.progress,
              updatedAt: event.payload.createdAt,
            },
          }
        : { kind: "unchanged" };

    case "thread.bootstrap-step-updated": {
      if (
        event.payload.threadId !== thread.id ||
        !thread.bootstrap ||
        thread.bootstrap.id !== event.payload.bootstrapId
      ) {
        return { kind: "unchanged" };
      }
      const current = thread.bootstrap[event.payload.step];
      const step = {
        ...current,
        status: event.payload.status,
        attempt: event.payload.attempt,
        ...(event.payload.terminalId !== undefined ? { terminalId: event.payload.terminalId } : {}),
        ...(event.payload.exitCode !== undefined ? { exitCode: event.payload.exitCode } : {}),
        ...(event.payload.error !== undefined ? { error: event.payload.error } : {}),
        ...(event.payload.worktreePath !== undefined
          ? { worktreePath: event.payload.worktreePath }
          : {}),
      };
      return {
        kind: "updated",
        thread: {
          ...thread,
          bootstrap: {
            ...thread.bootstrap,
            status:
              event.payload.status === "failed"
                ? "failed"
                : event.payload.status === "running" || event.payload.status === "pending"
                  ? "running"
                  : thread.bootstrap.status === "failed"
                    ? "running"
                    : thread.bootstrap.status,
            [event.payload.step]: step,
            updatedAt: event.payload.updatedAt,
          },
          updatedAt: event.payload.updatedAt,
        },
      };
    }

    case "thread.bootstrap-completed":
      return event.payload.threadId === thread.id && thread.bootstrap
        ? {
            kind: "updated",
            thread: {
              ...thread,
              bootstrap: {
                ...thread.bootstrap,
                status: "ready",
                updatedAt: event.payload.completedAt,
              },
              updatedAt: event.payload.completedAt,
            },
          }
        : { kind: "unchanged" };

    // ── Events that don't mutate thread state directly ──────────────
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.checkpoint-revert-requested":
    case "thread.bootstrap-stop-requested":
    case "thread.bootstrap-retry-requested":
    case "thread.bootstrap-continue-requested":
      return { kind: "unchanged" };
  }

  // Forward-compatible: ignore unrecognized event types.
  return { kind: "unchanged" };
}

// ── Helpers ──────────────────────────────────────────────────────────

function checkpointStatusToTurnState(
  status: "ready" | "missing" | "error",
): OrchestrationLatestTurn["state"] {
  switch (status) {
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "missing":
      return "completed";
  }
}

/**
 * Returns `previous` when `next` matches it field for field, otherwise `next`.
 * Streaming cases recompute the latest turn on every delta, and keeping the
 * old reference lets selectors and memos keyed on `latestTurn` skip work.
 */
function reuseLatestTurn(
  previous: OrchestrationLatestTurn | null,
  next: OrchestrationLatestTurn | null,
): OrchestrationLatestTurn | null {
  if (previous === null || next === null) {
    return next;
  }
  return previous.turnId === next.turnId &&
    previous.state === next.state &&
    previous.requestedAt === next.requestedAt &&
    previous.startedAt === next.startedAt &&
    previous.completedAt === next.completedAt &&
    // T3-CUSTOM(expbkt3): derived duration is part of visible turn state.
    previous.durationMs === next.durationMs &&
    previous.assistantMessageId === next.assistantMessageId &&
    previous.sourceProposedPlan?.threadId === next.sourceProposedPlan?.threadId &&
    previous.sourceProposedPlan?.planId === next.sourceProposedPlan?.planId
    ? previous
    : next;
}

/**
 * Points the checkpoint for `turnId` at `messageId`. Returns the input array
 * untouched when no checkpoint needs rebinding, so streaming deltas for an
 * already-bound message do not allocate a new `checkpoints` reference.
 */
function rebindCheckpointAssistantMessage(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
  messageId: MessageId,
): ReadonlyArray<OrchestrationCheckpointSummary> {
  const needsRebind = checkpoints.some(
    (entry) => entry.turnId === turnId && entry.assistantMessageId !== messageId,
  );
  if (!needsRebind) {
    return checkpoints;
  }
  return Arr.map(checkpoints, (entry) =>
    entry.turnId === turnId ? { ...entry, assistantMessageId: messageId } : entry,
  );
}

function retainMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): OrchestrationMessage[] {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system" || isImportedAgentSessionMessageId(message.id)) {
      retainedMessageIds.add(message.id);
    } else if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  for (const role of ["user", "assistant"] as const) {
    const retainedCount = messages.filter(
      (message) =>
        message.role === role &&
        !isImportedAgentSessionMessageId(message.id) &&
        retainedMessageIds.has(message.id),
    ).length;
    const missingCount = Math.max(0, turnCount - retainedCount);
    const fallbackMessages = messages
      .filter(
        (message) =>
          message.role === role &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      // `.sort()`, not `.toSorted()`: `.filter()` above already returned a fresh array, and
      // this is shared with mobile, which runs on Hermes and has no ES2023 array methods.
      .sort(
        (left, right) =>
          compareDateTimeStrings(left.createdAt, right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, missingCount);
    for (const message of fallbackMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return Arr.filter(messages, (message) => retainedMessageIds.has(message.id));
}
