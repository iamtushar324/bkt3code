/**
 * T3-CUSTOM(expbkt3): how the agent toolkit reads and names sessions.
 *
 * Pure helpers over the V2 shell: what state a session is in, what it waits
 * on, how a person or an agent may refer to it, and the small pieces of
 * Markdown the tools return. The handlers load data; everything here runs
 * without a server, so the rules are tested directly.
 */
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { parseLinearIssueUrl, threadLinearLinks } from "@t3tools/shared/linearIssue";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  classifySessionAttention,
  type SessionAttentionKind,
} from "@t3tools/shared/sessionAttention";
import * as DateTime from "effect/DateTime";

import { isSnoozed } from "../../../orchestration-v2/ThreadSettlementService.ts";

export type SessionShell = OrchestrationV2ThreadShell;

/** What an inbox item waits for: an attention kind, or a finished run nobody has opened. */
export type InboxKind = SessionAttentionKind | "unread";

/** Inbox order: what blocks an agent first, then what only waits to be read. */
export const INBOX_KIND_ORDER: ReadonlyArray<InboxKind> = [
  "approval",
  "question",
  "async-question",
  "plan",
  "failed",
  "unread",
];

export const INBOX_KIND_LABEL: Record<InboxKind, string> = {
  approval: "Approval",
  question: "Question",
  "async-question": "Question (agent keeps working)",
  plan: "Plan to review",
  failed: "Failed",
  unread: "Finished, not read",
};

const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export const toMillis = (value: DateTime.Utc | null | undefined): number | null =>
  value === null || value === undefined ? null : DateTime.toEpochMillis(value);

export const toIso = (value: DateTime.Utc | null | undefined): string | null =>
  value === null || value === undefined ? null : DateTime.formatIso(value);

/**
 * A run is preparing, queued, starting, running or waiting, or the turn ended
 * on background work that will wake the agent (a background command, a
 * subagent, a monitor), which the sidebar shows as working too.
 */
export const isAgentActive = (shell: SessionShell): boolean =>
  shell.activeRunId !== null ||
  ACTIVE_STATUSES.has(shell.activityRunStatus ?? shell.status) ||
  backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? []);

export const attentionOf = (shell: SessionShell): SessionAttentionKind | null =>
  classifySessionAttention({
    pendingRequestKind: shell.pendingRuntimeRequest?.kind ?? null,
    hasPendingAsyncUserInput: shell.hasPendingAsyncUserInput === true,
    hasActionableProposedPlan: shell.hasActionableProposedPlan,
    agentActive: isAgentActive(shell),
    failed: shell.status === "failed",
  });

/**
 * A run finished after the session was last opened. A server that does not
 * track visits reports nothing as unread, rather than everything.
 */
export const isUnread = (shell: SessionShell): boolean => {
  if (isAgentActive(shell) || shell.status !== "completed") return false;
  if (shell.lastVisitedAt === undefined) return false;
  const completed = toMillis(shell.latestRunCompletedAt);
  if (completed === null) return false;
  const visited = toMillis(shell.lastVisitedAt);
  return visited === null || visited < completed;
};

export const isSettled = (shell: SessionShell): boolean =>
  shell.settledOverride === "settled" ||
  (shell.settledOverride !== "active" && shell.settledAt !== null);

export const isSnoozedNow = (shell: SessionShell, nowMs: number): boolean =>
  isSnoozed(shell, nowMs);

export const isSubagent = (shell: SessionShell): boolean =>
  shell.lineage.relationshipToParent === "subagent";

export type SessionState =
  | "waiting"
  | "running"
  | "failed"
  | "unread"
  | "idle"
  | "snoozed"
  | "settled"
  | "archived";

/** One word for where a session is: lifecycle shelves first, then what it does. */
export const sessionStateOf = (shell: SessionShell, nowMs: number): SessionState => {
  if (shell.archivedAt !== null) return "archived";
  const attention = attentionOf(shell);
  if (attention !== null && attention !== "failed") return "waiting";
  if (isSnoozedNow(shell, nowMs)) return "snoozed";
  if (isSettled(shell) && attention === null && !isAgentActive(shell)) return "settled";
  if (attention === "failed") return "failed";
  if (isAgentActive(shell)) return "running";
  return isUnread(shell) ? "unread" : "idle";
};

/** P0 or P1, or "urgent" in the title: the same signal the attention digest uses. */
export const isUrgent = (shell: SessionShell): boolean =>
  (shell.priority !== null && shell.priority !== undefined && shell.priority <= 1) ||
  /\burgent\b/i.test(shell.title);

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The first 8 characters of the id's last UUID, or the whole id when it has none. */
export const shortRef = (id: string): string => {
  const uuid = id.match(UUID_PATTERN)?.at(-1);
  return uuid === undefined ? id : uuid.slice(0, 8).toLowerCase();
};

/** Linear issue keys the session is tagged with, such as `TEC-1488`. */
export const linearKeysOf = (shell: SessionShell): ReadonlyArray<string> =>
  threadLinearLinks(shell).flatMap((link) => {
    const issue = parseLinearIssueUrl(link.url);
    return issue === null ? [] : [issue.identifier];
  });

export interface SessionPullRequest {
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly state: string | null;
  readonly checks: string | null;
}

/** Linked pull requests, newest link first, without the tombstones of unlinked stack layers. */
export const pullRequestsOf = (shell: SessionShell): ReadonlyArray<SessionPullRequest> => {
  const linked = (shell.pullRequests ?? [])
    .filter((link) => link.source !== "stack-dismissed")
    .map((link) => ({
      repository: link.repository,
      number: link.number,
      url: link.url,
      state: link.snapshot?.state ?? null,
      checks: link.snapshot?.checksState ?? null,
    }));
  const legacy = shell.linkedPullRequest;
  if (legacy === null || legacy === undefined) return linked;
  if (linked.some((link) => link.url === legacy.url)) return linked;
  return [
    ...linked,
    {
      repository: legacy.repository,
      number: legacy.number,
      url: legacy.url,
      state: null,
      checks: null,
    },
  ];
};

const LINEAR_KEY_PATTERN = /^[a-z][a-z0-9]*-\d+$/i;
const PULL_REQUEST_PATH = /\/([^/]+\/[^/]+)\/pulls?\/(\d+)/;

const parseUrl = (value: string): URL | null => {
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/** The thread id a T3 session link names: `https://<host>/<environmentId>/<threadId>`. */
const threadIdFromLink = (url: URL): string | undefined => {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  if (segments.length < 2 || last === undefined) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return undefined;
  }
};

/**
 * The sessions a reference may mean, best match first: an exact id, a T3
 * link, a Linear issue key or URL, a pull request URL, an id prefix of six or
 * more characters, an exact title, then a title that contains the text. The
 * caller decides what one, none or several matches mean.
 */
export function matchSessionRef(
  ref: string,
  shells: ReadonlyArray<SessionShell>,
): ReadonlyArray<SessionShell> {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return [];
  const exact = shells.filter((shell) => shell.id === trimmed);
  if (exact.length > 0) return exact;

  const url = parseUrl(trimmed);
  if (url !== null) {
    if (url.hostname === "linear.app") {
      const issue = parseLinearIssueUrl(trimmed);
      return issue === null
        ? []
        : shells.filter((shell) => linearKeysOf(shell).includes(issue.identifier));
    }
    const pullRequest = PULL_REQUEST_PATH.exec(url.pathname);
    if (pullRequest !== null) {
      const repository = pullRequest[1]?.toLowerCase();
      const number = Number(pullRequest[2]);
      return shells.filter((shell) =>
        pullRequestsOf(shell).some(
          (link) =>
            link.url === trimmed ||
            (link.number === number && link.repository.toLowerCase() === repository),
        ),
      );
    }
    const threadId = threadIdFromLink(url);
    return threadId === undefined ? [] : shells.filter((shell) => shell.id === threadId);
  }

  if (LINEAR_KEY_PATTERN.test(trimmed)) {
    const key = trimmed.toUpperCase();
    const tagged = shells.filter((shell) => linearKeysOf(shell).includes(key));
    if (tagged.length > 0) return tagged;
  }

  const lower = trimmed.toLowerCase();
  if (lower.length >= 6) {
    const prefixed = shells.filter(
      (shell) =>
        shell.id.toLowerCase().startsWith(lower) ||
        shortRef(shell.id).startsWith(lower) ||
        (shell.id.match(UUID_PATTERN) ?? []).some((uuid) => uuid.toLowerCase().startsWith(lower)),
    );
    if (prefixed.length > 0) return prefixed;
  }

  const sameTitle = shells.filter((shell) => shell.title.trim().toLowerCase() === lower);
  if (sameTitle.length > 0) return sameTitle;
  return shells.filter((shell) => shell.title.toLowerCase().includes(lower));
}

/** `2m`, `3h`, `4d`: how long ago, or how long for. */
export const duration = (fromMs: number, nowMs: number): string => {
  const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};

/** One line of at most `max` characters, for excerpts inside a list. */
export const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** At most `max` characters, keeping line breaks, with a note of what was cut. */
export const cutText = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text;

/** The web link to a session, when the request's origin is known. */
export const sessionLink = (
  origin: string | undefined,
  environmentId: string,
  threadId: string,
): string | null =>
  origin === undefined
    ? null
    : `${origin}/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;

/** A ready-to-copy tool call for the "next step" lines. */
export const callHint = (tool: string, args: Record<string, unknown>): string =>
  `\`${tool} ${JSON.stringify(args)}\``;

/** `ms` as an ISO timestamp. */
export const isoFromMillis = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));

export interface InboxCandidate {
  readonly kind: InboxKind;
  readonly shell: SessionShell;
  readonly waitingSinceMs: number;
  readonly urgent: boolean;
}

/**
 * The sessions that wait on a person, in inbox order: urgent first, then by
 * kind (INBOX_KIND_ORDER), then the longest wait. A question or approval
 * always shows; a plan, failure or unread result in a snoozed or settled
 * session is hidden unless asked for, and `hidden` counts those.
 */
export function inboxCandidates(
  shells: ReadonlyArray<SessionShell>,
  nowMs: number,
  options: { readonly includeSnoozed: boolean },
): { readonly entries: ReadonlyArray<InboxCandidate>; readonly hidden: number } {
  const entries: Array<InboxCandidate> = [];
  let hidden = 0;
  for (const shell of shells) {
    if (shell.archivedAt !== null || shell.deletedAt !== null || isSubagent(shell)) continue;
    const kind: InboxKind | null = attentionOf(shell) ?? (isUnread(shell) ? "unread" : null);
    if (kind === null) continue;
    const blocking = kind === "question" || kind === "approval" || kind === "async-question";
    if (!blocking && !options.includeSnoozed && (isSnoozedNow(shell, nowMs) || isSettled(shell))) {
      hidden += 1;
      continue;
    }
    entries.push({
      kind,
      shell,
      waitingSinceMs:
        (blocking ? toMillis(shell.pendingRuntimeRequest?.createdAt ?? null) : null) ??
        toMillis(shell.latestRunCompletedAt ?? null) ??
        toMillis(shell.updatedAt) ??
        nowMs,
      urgent: isUrgent(shell),
    });
  }
  entries.sort(
    (left, right) =>
      Number(right.urgent) - Number(left.urgent) ||
      INBOX_KIND_ORDER.indexOf(left.kind) - INBOX_KIND_ORDER.indexOf(right.kind) ||
      left.waitingSinceMs - right.waitingSinceMs,
  );
  return { entries, hidden };
}
