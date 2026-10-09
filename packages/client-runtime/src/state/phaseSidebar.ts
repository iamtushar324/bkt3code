// T3-CUSTOM(expbkt3): Phase-grouped session list logic, shared by web and mobile.
//
// This is the pure half of the fork's experimental "control center" sidebar:
// which lifecycle phase a thread is in, how rows partition into active,
// snoozed and settled shelves, what the priority / Linear / pull-request /
// worktree badges say, how filters and sorting behave, and the lifecycle
// counters.
//
// It lives in client-runtime rather than apps/web because the mobile app needs
// exactly the same answers and cannot import from apps/web. The web sidebar
// keeps a re-export shim at
// apps/web/src/components/sidebar/PhaseGroupedSidebar.logic.ts, which also
// holds the Tailwind class-name helpers — those must stay under apps/web,
// where Tailwind scans for literal class names.
//
// HERMES. Everything here also runs on React Native, whose Hermes engine does
// not ship the ES2023 change-array-by-copy methods. Sort a copy with `.sort()`;
// never reach for `.toSorted()`. phaseSidebar.test.ts asserts this by deleting
// the method from Array.prototype.
import type {
  ServerConfig,
  // T3-CUSTOM(expbkt3): the thread's auto-detected branch review.
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
  UserId,
  VcsStatusResult,
} from "@t3tools/contracts";
// T3-CUSTOM(expbkt3): custom sidebar groups compare case-insensitively.
import { normalizeThreadCustomGroup } from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import {
  linearIssueFromBranch,
  parseLinearIssueUrl,
  type LinearIssueRef,
} from "@t3tools/shared/linearIssue";
import { resolveChangeRequestPresentation } from "@t3tools/shared/sourceControl";
import {
  resolveThreadCurrentPullRequestLink,
  resolveThreadPullRequestBadge,
  resolveThreadPullRequestChains,
} from "@t3tools/shared/threadPullRequests";
// T3-CUSTOM(expbkt3): memorable worktree codenames.
import {
  disambiguateWorktreeCodenames,
  resolveWorktreeCodename,
  worktreeCodenameToneIndex,
} from "@t3tools/shared/worktreeCodename";

import {
  scopeProjectRef,
  scopeThreadRef,
  scopedProjectKey,
  scopedThreadKey,
} from "../environment/scoped.ts";
// T3-CUSTOM(expbkt3): when a working row's current work started.
import { resolveThreadWorkingStartedAt } from "./models.ts";
import { deriveLogicalProjectKey } from "./projectGrouping.ts";
import type { EnvironmentProject, EnvironmentThreadShell } from "./shell.ts";
import {
  effectiveSettled,
  effectiveSnoozed,
  type ChangeRequestStateLike,
} from "./threadSettled.ts";
import { getThreadSortTimestamp } from "./threadSort.ts";

/**
 * The two shapes every helper here works with. Aliased rather than imported
 * under these names so the moved code reads exactly as it did under apps/web,
 * where `../../types` aliases the same two client-runtime types.
 */
type Project = EnvironmentProject;
type ThreadShell = EnvironmentThreadShell;

/**
 * Copied from upstream's apps/web/src/components/Sidebar.logic.ts rather than
 * imported: that file is upstream-owned, and re-exporting from it would put a
 * fork edit inside it for no functional gain. Both are small, pure and stable
 * — but if upstream changes the settled-sort rule, change it here too.
 */
function firstValidTimestamp(
  ...candidates: ReadonlyArray<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (!Number.isNaN(Date.parse(candidate))) return candidate;
  }
  return null;
}

/**
 * The timestamp a settled row sorts and labels by: settledAt when stamped,
 * otherwise last activity, with updatedAt as the final net. See the note on
 * firstValidTimestamp above for why this is a copy.
 */
export function resolveSettledTimestamp(
  thread: Pick<ThreadShell, "settledAt" | "latestUserMessageAt" | "latestRun" | "updatedAt">,
): string | null {
  const settledAt = firstValidTimestamp(thread.settledAt);
  if (settledAt !== null) return settledAt;
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestRun?.requestedAt,
    thread.latestRun?.startedAt,
    thread.latestRun?.completedAt,
  ]) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed) && parsed > latestMs) {
      latest = candidate;
      latestMs = parsed;
    }
  }
  return latest ?? firstValidTimestamp(thread.updatedAt);
}

export const PHASE_SIDEBAR_PHASE_IDS = [
  "needs_input",
  // T3-CUSTOM(expbkt3): an async question — the agent asked something and kept
  // working. It ranks directly below Needs Input and above Plan Ready.
  "ask",
  "plan_ready",
  "ready",
  "planning",
  "implementing",
] as const;

export type PhaseSidebarPhaseId = (typeof PHASE_SIDEBAR_PHASE_IDS)[number];

export interface PhaseSidebarCheckoutMetadata {
  readonly kind: "current" | "worktree";
  readonly label: string;
  readonly tooltip: string;
  /**
   * Color bucket for the codename, or `null` for a current checkout. Consumers
   * map this through a static class table — see `PHASE_SIDEBAR_CHECKOUT_TONES`.
   */
  readonly toneIndex: number | null;
  /**
   * T3-CUSTOM(expbkt3): the thread's branch is not the one checked out.
   *
   * Only ever set for a local checkout, where the label shows the *actual*
   * refName. Without this the row reads as healthy while pointing somewhere
   * else entirely, which is the state upstream warns about in its tooltip.
   */
  readonly branchMismatch: string | null;
}

/**
 * T3-CUSTOM(expbkt3): Other threads sharing this thread's worktree. Two agents
 * editing one directory at the same time is a real hazard, and without this it
 * is invisible.
 */
export interface PhaseSidebarWorktreeSharing {
  /** Threads occupying the worktree. Always >= 2 when present. */
  readonly count: number;
  /**
   * Pre-joined thread titles for the tooltip. A string rather than an array so
   * it can cross the memo'd row boundary as a prop without defeating the memo.
   */
  readonly summary: string;
}

/**
 * T3-CUSTOM(expbkt3): Keep checkout semantics explicit in the experimental
 * sidebar. Current checkouts show their live branch; dedicated worktrees show
 * their codename — a short, memorable name derived from the worktree path, so
 * that two rows in the same worktree read identically and two rows in different
 * worktrees read differently at a glance. The ref the worktree was created from
 * moves into the tooltip, which is where it was actually being read anyway.
 */
export function resolvePhaseSidebarCheckoutMetadata(
  thread: Pick<ThreadShell, "branch" | "worktreePath">,
  vcsStatus: Pick<VcsStatusResult, "refName" | "baseRef" | "pr"> | null | undefined,
  options?: {
    /** Label from `disambiguateWorktreeCodenames`, when the view resolved one. */
    readonly codename?: string | null;
    readonly sharing?: PhaseSidebarWorktreeSharing | null;
  },
): PhaseSidebarCheckoutMetadata {
  if (thread.worktreePath) {
    const baseRef = vcsStatus?.pr?.baseRef ?? vcsStatus?.baseRef ?? null;
    const codename = options?.codename ?? resolveWorktreeCodename(thread.worktreePath);
    const sharing = options?.sharing ?? null;

    // T3-CUSTOM(expbkt3): the codename replaces the branch in the label, so the
    // branch has to survive in the tooltip — otherwise a worktree row is the one
    // place in the app that never tells you which branch it is on.
    const tooltipParts = [`Worktree ${codename}`];
    if (thread.branch) tooltipParts.push(thread.branch);
    if (baseRef) tooltipParts.push(`from ${baseRef}`);
    tooltipParts.push(thread.worktreePath);
    if (sharing) {
      tooltipParts.push(`Shared by ${sharing.count} threads: ${sharing.summary}`);
    }

    return {
      kind: "worktree",
      label: sharing ? `${codename} ×${sharing.count}` : codename,
      tooltip: tooltipParts.join(" · "),
      toneIndex: worktreeCodenameToneIndex(codename),
      branchMismatch: null,
    };
  }

  const branch = vcsStatus?.refName ?? thread.branch;
  // T3-CUSTOM(expbkt3): the label is the branch actually checked out, so when
  // that is not the thread's branch the row needs to say so rather than quietly
  // showing someone else's work as this thread's.
  const branchMismatch =
    thread.branch !== null && vcsStatus?.refName != null && vcsStatus.refName !== thread.branch
      ? thread.branch
      : null;
  return {
    kind: "current",
    label: branch ?? "Current checkout",
    tooltip:
      branchMismatch !== null
        ? `Current checkout on ${branch} — this thread is on ${branchMismatch}`
        : branch
          ? `Current checkout on ${branch}`
          : "Current checkout",
    toneIndex: null,
    branchMismatch,
  };
}

/**
 * T3-CUSTOM(expbkt3): Codename label and shared-worktree state for every thread
 * on screen, resolved together because both answers depend on the whole visible
 * set: codenames disambiguate against each other, and sharing is a count across
 * rows. Archived threads do not participate — the rest of the UI hides them, so
 * they must not inflate a worktree's occupancy.
 */
export interface PhaseSidebarWorktreeView {
  readonly codenameByPath: ReadonlyMap<string, string>;
  readonly sharingByPath: ReadonlyMap<string, PhaseSidebarWorktreeSharing>;
}

export function resolvePhaseSidebarWorktreeView(
  threads: ReadonlyArray<
    Pick<ThreadShell, "title" | "worktreePath" | "archivedAt"> & {
      readonly lineage?: ThreadShell["lineage"];
    }
  >,
): PhaseSidebarWorktreeView {
  const titlesByPath = new Map<string, string[]>();
  for (const thread of threads) {
    const worktreePath = thread.worktreePath?.trim();
    if (!worktreePath || thread.archivedAt != null) continue;
    // Subagent threads run in their parent's worktree and never get a row, so
    // they must not make one session's worktree read as shared (XFN-59: a
    // session with 11 subagents showed "×12").
    if (thread.lineage?.relationshipToParent === "subagent") continue;
    titlesByPath.set(worktreePath, [...(titlesByPath.get(worktreePath) ?? []), thread.title]);
  }

  const sharingByPath = new Map<string, PhaseSidebarWorktreeSharing>();
  for (const [worktreePath, titles] of titlesByPath) {
    if (titles.length < 2) continue;
    sharingByPath.set(worktreePath, { count: titles.length, summary: titles.join(", ") });
  }

  return {
    codenameByPath: disambiguateWorktreeCodenames([...titlesByPath.keys()]),
    sharingByPath,
  };
}

/**
 * T3-CUSTOM(expbkt3): Flatten one thread's worktree state into primitives. The
 * row is memo'd and the sidebar re-renders on every shell event, so the props
 * crossing that boundary have to compare by value.
 */
export interface PhaseSidebarWorktreeRowProps {
  readonly worktreeCodename: string | null;
  /** 0 when the worktree is not shared. */
  readonly worktreeSharedCount: number;
  readonly worktreeSharedSummary: string | null;
}

export function phaseSidebarWorktreeRowProps(
  view: PhaseSidebarWorktreeView,
  worktreePath: string | null,
): PhaseSidebarWorktreeRowProps {
  const path = worktreePath?.trim();
  if (!path) {
    return { worktreeCodename: null, worktreeSharedCount: 0, worktreeSharedSummary: null };
  }
  const sharing = view.sharingByPath.get(path) ?? null;
  return {
    // An archived thread is absent from the view but still renders on the
    // shelf, so fall back to deriving its codename directly.
    worktreeCodename: view.codenameByPath.get(path) ?? resolveWorktreeCodename(path),
    worktreeSharedCount: sharing?.count ?? 0,
    worktreeSharedSummary: sharing?.summary ?? null,
  };
}

export interface PhaseSidebarPhaseDefinition {
  readonly id: PhaseSidebarPhaseId;
  readonly label: string;
  readonly helperText: string;
}

export const PHASE_SIDEBAR_PHASES: ReadonlyArray<PhaseSidebarPhaseDefinition> = [
  {
    id: "needs_input",
    label: "Needs Input",
    helperText: "Agent is waiting for your answer",
  },
  // T3-CUSTOM(expbkt3): a question asked mid-run. The agent did not park, so
  // nothing else in the row says a human is holding it up.
  { id: "ask", label: "Ask", helperText: "Agent asked a question while working" },
  // T3-CUSTOM(expbkt3): the group means a plan is waiting, not "plan mode, idle".
  { id: "plan_ready", label: "Plan Ready", helperText: "A plan is waiting for your decision" },
  { id: "ready", label: "Ready", helperText: "No active agent work" },
  { id: "planning", label: "Planning", helperText: "Agent is preparing a plan" },
  { id: "implementing", label: "Implementing", helperText: "Agent is changing code" },
];

export interface PhaseSidebarWorkBadge {
  readonly label: string;
  readonly monitoring: boolean;
}

/**
 * Mirror Sidebar V2's execution precedence in the experimental sidebar.
 * Foreground execution keeps its provider label (for example, Running),
 * background agent fleets read as Working, and only watch loops read as
 * Monitoring. Monitoring is steady and therefore does not trigger row
 * shimmer. T3-CUSTOM(expbkt3): background liveness outranks a held plan, so a
 * row whose subagents or monitor still run never reads as stopped.
 */
export function resolvePhaseSidebarWorkBadge(input: {
  readonly phaseId: PhaseSidebarPhaseId;
  readonly backgroundLiveness?: "working" | "monitoring" | null;
  readonly executionPresentation: {
    readonly active: boolean;
    readonly label: string | null;
  };
}): PhaseSidebarWorkBadge | null {
  if (input.executionPresentation.active && input.executionPresentation.label !== null) {
    return { label: input.executionPresentation.label, monitoring: false };
  }

  if (input.backgroundLiveness === "working") {
    return { label: "Working", monitoring: false };
  }

  if (input.backgroundLiveness === "monitoring") {
    return { label: "Monitoring", monitoring: true };
  }

  return null;
}

const PHASE_ID_SET = new Set<string>(PHASE_SIDEBAR_PHASE_IDS);
export type PhaseSidebarLinearIssue = LinearIssueRef;

/** A manual tag wins; otherwise the `linear/ABC-123` branch names the issue. */
export function resolvePhaseSidebarLinearIssue(
  branch: string | null,
  manualUrl?: string | null,
): PhaseSidebarLinearIssue | null {
  return parseLinearIssueUrl(manualUrl) ?? linearIssueFromBranch(branch);
}

/**
 * T3-CUSTOM(expbkt3): the Mattermost conversation a session is bound to.
 *
 * Mattermost is self-hosted, so there is no canonical domain to validate
 * against — anything that parses as an http(s) URL is accepted, and the label
 * is derived only as far as the path reliably allows. Mattermost permalinks
 * are `/<team>/pl/<postId>`, channels `/<team>/channels/<name>`, and DMs
 * `/<team>/messages/@user`; anything else degrades to the host, which is still
 * more useful in a tooltip than the raw URL.
 */
export interface PhaseSidebarMattermostLink {
  /** Tooltip text, e.g. "Mattermost · #co-x-tech". */
  readonly label: string;
  readonly url: string;
}

export function resolvePhaseSidebarMattermostLink(
  manualUrl?: string | null,
): PhaseSidebarMattermostLink | null {
  const trimmed = manualUrl?.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  const kind = segments[1];
  const name = segments[2];
  const detail =
    kind === "channels" && name
      ? `#${decodeURIComponent(name)}`
      : kind === "messages" && name
        ? decodeURIComponent(name)
        : parsed.host;
  return { label: `Mattermost · ${detail}`, url: parsed.toString() };
}

/**
 * T3-CUSTOM(expbkt3): The row's change request, rendered beside the Linear tag
 * so the two trackers a session answers to read as one line: ticket, then PR.
 *
 * The number is the whole label. State is carried by COLOR ALONE — the row's
 * metadata lane is already the densest text in the app, and "#1234 (merged)"
 * spends a third of the lane restating what the hue says. Hues match
 * `prStatusIndicator` so a PR never reads one colour here and another in the
 * thread header: green open, violet merged, red closed. Draft, checks, and
 * review state stay in the tooltip — they are modifiers on "open", not states,
 * and giving each its own hue would make the lane unreadable.
 */
export interface PhaseSidebarChangeRequestEntry {
  /** "#1234" — the number stays visible for every entry. */
  readonly label: string;
  readonly url: string;
  readonly state: ChangeRequestStateLike;
  readonly colorClassName: string;
  /** Full state in words: "open · draft · checks failing". */
  readonly statusText: string;
  readonly title: string | null;
  readonly tooltip: string;
}

export interface PhaseSidebarChangeRequestBadge {
  /** "#1234", or "#1234 +2" when the thread carries more than one. */
  readonly label: string;
  /** The review a single click opens: the current one. */
  readonly url: string;
  readonly state: ChangeRequestStateLike;
  /** Static Tailwind classes; Tailwind cannot scan interpolated hues. */
  readonly colorClassName: string;
  /** Full state in words, for the tooltip and the accessible name. */
  readonly statusText: string;
  readonly tooltip: string;
  /**
   * `stack` when the links form one chain, so the row can wear the layers
   * glyph instead of the pull-request one; `multiple` when they are unrelated.
   */
  readonly kind: "single" | "stack" | "multiple";
  /** Every review tagged to the thread, bottom of the stack first. */
  readonly entries: ReadonlyArray<PhaseSidebarChangeRequestEntry>;
}

const PHASE_SIDEBAR_CHANGE_REQUEST_TONES = {
  open: "text-emerald-600 dark:text-emerald-300/90",
  merged: "text-violet-600 dark:text-violet-300/90",
  closed: "text-red-600 dark:text-red-300/90",
} satisfies Record<ChangeRequestStateLike, string>;

/**
 * T3-CUSTOM(expbkt3): a review we know exists but have no state for yet.
 *
 * The thread's own `branchPullRequest` carries a number and a URL and nothing
 * else, so colouring it green would assert an "open" the row has not confirmed.
 * Muted says "there is a review here, status still loading" — the same shape
 * upstream uses for an unhydrated PR.
 */
const PHASE_SIDEBAR_CHANGE_REQUEST_PENDING_TONE = "text-muted-foreground";

/** Modifiers are qualifiers on "open", never states — they stay out of the hue. */
function changeRequestStatusText(input: {
  readonly state: ChangeRequestStateLike;
  readonly isDraft?: boolean | null | undefined;
  readonly mergeability?: string | null | undefined;
  readonly reviewDecision?: string | null | undefined;
  readonly checksStatus?: string | null | undefined;
}): string {
  const modifiers: string[] = [];
  if (input.state === "open") {
    if (input.isDraft === true) modifiers.push("draft");
    if (input.mergeability === "conflicting") modifiers.push("conflicting");
    if (input.reviewDecision === "approved") modifiers.push("approved");
    if (input.reviewDecision === "changes-requested") modifiers.push("changes requested");
    if (input.checksStatus === "fail" || input.checksStatus === "failing") {
      modifiers.push("checks failing");
    }
    if (input.checksStatus === "pending") modifiers.push("checks running");
  }
  return modifiers.length === 0 ? input.state : `${input.state} · ${modifiers.join(" · ")}`;
}

function entryFromLink(
  link: ThreadPullRequestLink,
  shortName: string,
): PhaseSidebarChangeRequestEntry {
  const snapshot = link.snapshot;
  const state: ChangeRequestStateLike = snapshot?.state ?? "open";
  const statusText = snapshot
    ? changeRequestStatusText({
        state,
        isDraft: snapshot.isDraft,
        mergeability: snapshot.mergeability ?? null,
        reviewDecision: snapshot.reviewDecision ?? null,
        checksStatus: snapshot.checksState ?? null,
      })
    : "not synced yet";
  const title = snapshot?.title ?? null;
  return {
    label: `#${link.number}`,
    url: link.url,
    state,
    colorClassName: PHASE_SIDEBAR_CHANGE_REQUEST_TONES[state],
    statusText,
    title,
    tooltip: `${shortName} #${link.number} — ${statusText}${title === null ? "" : ` · ${title}`}`,
  };
}

/**
 * T3-CUSTOM(expbkt3): The row's change requests, rendered beside the Linear tag
 * so the two trackers a session answers to read as one line: ticket, then PR.
 *
 * Tagged links win over the branch-detected review. Branch detection only ever
 * finds the PR for the checked-out branch, so a review an agent registered with
 * `link_pull_request` — a second repository, a stack layer, a PR opened before
 * the branch existed — was invisible here until it was also the branch's.
 *
 * The number stays the whole label. State is carried by COLOR ALONE — the row's
 * metadata lane is already the densest text in the app, and "#1234 (merged)"
 * spends a third of the lane restating what the hue says. Hues match
 * `prStatusIndicator` so a PR never reads one colour here and another in the
 * thread header: green open, violet merged, red closed. Draft, checks, and
 * review state stay in the tooltip — they are modifiers on "open", not states,
 * and giving each its own hue would make the lane unreadable.
 */
export function resolvePhaseSidebarChangeRequestBadge(
  vcsStatus: Pick<VcsStatusResult, "pr" | "sourceControlProvider"> | null | undefined,
  pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined,
  /**
   * T3-CUSTOM(expbkt3): the thread's own detected review — `branchPullRequest`,
   * falling back to the legacy `linkedPullRequest`.
   *
   * This is the field the server writes when it auto-detects the PR for a
   * thread's branch, and it is the reason a detected PR used to show in the chat
   * header but never on the row: the row only ever looked at explicit links and
   * at a working-directory probe, neither of which sees it.
   */
  detectedPullRequest?: ThreadLinkedPullRequest | null | undefined,
): PhaseSidebarChangeRequestBadge | null {
  const shortName = resolveChangeRequestPresentation(vcsStatus?.sourceControlProvider).shortName;
  const chains = resolveThreadPullRequestChains(pullRequests ?? []);
  const linked = chains.flatMap((chain) => chain.layers);

  if (linked.length > 0) {
    const current = resolveThreadCurrentPullRequestLink(linked) ?? linked[0]!;
    const entries = linked.map((link) => entryFromLink(link, shortName));
    const currentEntry = entries.find((entry) => entry.url === current.url) ?? entries[0]!;
    const aggregate = resolveThreadPullRequestBadge(linked);
    // "draft" is an open review wearing a modifier; the lane keeps three hues.
    const state: ChangeRequestStateLike =
      aggregate === null || aggregate.state === "draft" ? "open" : aggregate.state;
    const isStack = chains.length === 1 && linked.length > 1;
    const others = linked.length - 1;
    return {
      label: others === 0 ? currentEntry.label : `${currentEntry.label} +${others}`,
      url: currentEntry.url,
      state,
      colorClassName: PHASE_SIDEBAR_CHANGE_REQUEST_TONES[state],
      statusText: currentEntry.statusText,
      tooltip:
        others === 0
          ? currentEntry.tooltip
          : `${isStack ? "Stack of" : ""} ${linked.length} ${isStack ? "layers" : "linked reviews"}`.trim(),
      kind: others === 0 ? "single" : isStack ? "stack" : "multiple",
      entries,
    };
  }

  // T3-CUSTOM(expbkt3): BEGIN — the detected review decides WHICH review this
  // row is about; the probe only fills in its state.
  //
  // `vcsStatus` is keyed by working directory, not by thread, so on a shared
  // local checkout it reports whatever branch happens to be checked out right
  // now. Trusting it alone put another thread's PR on this row. When the two
  // disagree, the thread's own field wins and the row waits for state rather
  // than showing a confident wrong number.
  const detected = detectedPullRequest ?? null;
  const probe = vcsStatus?.pr ?? null;
  const pr =
    probe !== null && (detected === null || probe.number === detected.number) ? probe : null;

  if (pr === null) {
    if (detected === null) return null;
    const pendingEntry: PhaseSidebarChangeRequestEntry = {
      label: `#${detected.number}`,
      url: detected.url,
      state: "open",
      colorClassName: PHASE_SIDEBAR_CHANGE_REQUEST_PENDING_TONE,
      statusText: "status pending",
      title: null,
      tooltip: `${shortName} #${detected.number} — status pending`,
    };
    return {
      label: pendingEntry.label,
      url: pendingEntry.url,
      state: pendingEntry.state,
      colorClassName: pendingEntry.colorClassName,
      statusText: pendingEntry.statusText,
      tooltip: pendingEntry.tooltip,
      kind: "single",
      entries: [pendingEntry],
    };
  }
  // T3-CUSTOM(expbkt3): END
  const statusText = changeRequestStatusText({
    state: pr.state,
    isDraft: pr.isDraft,
    mergeability: pr.mergeability ?? null,
    reviewDecision: pr.reviewDecision ?? null,
    checksStatus: pr.checksStatus ?? null,
  });
  const entry: PhaseSidebarChangeRequestEntry = {
    label: `#${pr.number}`,
    url: pr.url,
    state: pr.state,
    colorClassName: PHASE_SIDEBAR_CHANGE_REQUEST_TONES[pr.state],
    statusText,
    title: pr.title,
    tooltip: `${shortName} #${pr.number} — ${statusText} · ${pr.title}`,
  };
  return {
    label: entry.label,
    url: entry.url,
    state: entry.state,
    colorClassName: entry.colorClassName,
    statusText,
    tooltip: entry.tooltip,
    kind: "single",
    entries: [entry],
  };
}

/** T3-CUSTOM(expbkt3): compact sidebar timestamps, including zero minutes. */
export function compactPhaseSidebarTimeLabel(label: string): string {
  return label === "just now" ? "0m" : label.replace(" ago", "");
}

export interface PhaseSidebarFilters {
  readonly repositoryKeys: ReadonlyArray<string>;
  readonly phaseIds: ReadonlyArray<PhaseSidebarPhaseId>;
  readonly providerKinds: ReadonlyArray<string>;
  /**
   * T3-CUSTOM(expbkt3): sessions this operator started.
   *
   * NOT "owner or tagged": that is the server's own visibility rule, so every
   * thread you can see already satisfies it and the filter selected everything.
   * Ownership is the distinction that means something — my sessions versus the
   * ones I was pulled into.
   */
  readonly ownedByMe: boolean;
  /**
   * T3-CUSTOM(expbkt3): show only sessions ALL of these people are on. Anyone
   * listed here is a co-participant on threads you can already see, since
   * visibility never widens — the filter narrows to shared work.
   */
  readonly participantUserIds: ReadonlyArray<string>;
  /**
   * T3-CUSTOM(expbkt3): custom group ids (see `phaseSidebarCustomGroupIdForRow`),
   * or `PHASE_SIDEBAR_UNGROUPED_ID` for sessions in no group. Works in every
   * grouping mode: it is the "custom filter" half of custom groups.
   */
  readonly customGroups: ReadonlyArray<string>;
}

export const EMPTY_PHASE_SIDEBAR_FILTERS: PhaseSidebarFilters = {
  repositoryKeys: [],
  phaseIds: [],
  providerKinds: [],
  ownedByMe: false,
  participantUserIds: [],
  customGroups: [],
};

/** T3-CUSTOM(expbkt3): the custom-mode catch-all, and the filter value for "no group". */
export const PHASE_SIDEBAR_UNGROUPED_ID = "ungrouped";

/**
 * T3-CUSTOM(expbkt3): the comparison id of a row's custom group, or null when
 * it has none. Labels keep their case for display; grouping and filtering use
 * this key so "Sprint 42" and "sprint 42" are one group.
 */
export function phaseSidebarCustomGroupIdForRow(
  row: Pick<PhaseSidebarRow, "customGroup">,
): string | null {
  const label = row.customGroup ?? null;
  return label === null ? null : normalizeThreadCustomGroup(label);
}

/** T3-CUSTOM(expbkt3): everyone on a thread, owner included. */
export function phaseSidebarThreadParticipantIds(
  thread: Pick<ThreadShell, "ownerUserId" | "memberUserIds">,
): ReadonlyArray<string> {
  return thread.ownerUserId === null
    ? thread.memberUserIds
    : [thread.ownerUserId, ...thread.memberUserIds.filter((id) => id !== thread.ownerUserId)];
}

/**
 * "Assigned to me" = owned by, or directly tagged on, the thread. A thread made
 * visible only by a project tag is not "assigned" (matches the server rule).
 */
export function isThreadAssignedToUser(
  thread: Pick<ThreadShell, "ownerUserId" | "memberUserIds">,
  userId: UserId,
): boolean {
  return thread.ownerUserId === userId || thread.memberUserIds.includes(userId);
}

/**
 * T3-CUSTOM(expbkt3): whose face, if anyone's, belongs on a sidebar row.
 *
 * A row only earns an owner avatar when the thread was started by *somebody
 * else*: my own sessions are the default case and a wall of my own face would
 * carry no information. Returns the owner to show, or `null` to show nothing.
 *
 * `null` when the thread is unowned (single-user mode, or awaiting backfill),
 * when we cannot identify the operator (no team identity — every row would
 * light up), or when the operator *is* the owner.
 */
export function phaseSidebarRowOwnerAvatarUserId(input: {
  readonly ownerUserId: UserId | null;
  readonly currentUserId: UserId | null;
}): UserId | null {
  if (input.ownerUserId === null || input.currentUserId === null) return null;
  return input.ownerUserId === input.currentUserId ? null : input.ownerUserId;
}

export interface PhaseSidebarRow {
  readonly thread: ThreadShell;
  readonly phaseId: PhaseSidebarPhaseId;
  readonly repositoryKey: string;
  readonly repositoryLabel: string;
  readonly providerKind: string;
  readonly providerName: string;
  readonly isAssignedToMe: boolean;
  // T3-CUSTOM(expbkt3): BEGIN — ownership and co-participant facets.
  readonly isOwnedByMe: boolean;
  readonly participantUserIds: ReadonlyArray<string>;
  // T3-CUSTOM(expbkt3): END
  readonly attentionPriority: number;
  readonly isUnreadCompletion: boolean;
  /** False on environments whose server predates thread.settle/unsettle:
      the row can never be classified settled (the user could not undo it)
      and its lifecycle affordances stay hidden. */
  readonly settlementSupported: boolean;
  /** Same version-skew contract for thread.snooze/unsnooze. */
  readonly snoozeSupported: boolean;
  /** Same version-skew contract for priority on thread.meta.update. */
  readonly prioritySupported: boolean;
  // T3-CUSTOM(expbkt3): BEGIN — custom sidebar group. The label the row is
  // filed under: the thread's own shared label, else the device-local group it
  // was placed in before labels lived on the server (see
  // `localCustomGroupForKey`). Null means ungrouped.
  readonly customGroup?: string | null;
  /** Same version-skew contract for customGroup on thread.meta.update. */
  readonly customGroupSupported?: boolean;
  // T3-CUSTOM(expbkt3): END
  /** Same version-skew contract for manual Linear tags on thread.meta.update. */
  readonly linearIssueSupported?: boolean;
  /** T3-CUSTOM(expbkt3): the server adds and removes single Linear tags
      (`linearLinksAdd` / `linearLinksRemove`); older servers ignore them. */
  readonly linearLinksSupported?: boolean;
  /** Same version-skew contract for the Mattermost link on thread.meta.update. */
  readonly mattermostLinkSupported?: boolean;
  /** Same version-skew contract for regenerateTitle on thread.meta.update,
      which backs "Regenerate title" on the row's context menu. */
  readonly titleRegenerationSupported?: boolean;
  /** Same version-skew contract for thread.bootstrap.request, which backs
      "Create new thread" on the row's context menu. */
  /** The row's pull-request state, when its VCS probe has reported one: a
      closed (abandoned) change request auto-settles the thread, an open one
      holds it active, and a merge settles only when the user allows it. */
  readonly changeRequestState: ChangeRequestStateLike | null;
  /** When the change request last changed, so a merge older than the thread's
      own activity does not settle a thread the user has since worked on. */
  readonly changeRequestUpdatedAt?: string | null;
}

/**
 * T3-CUSTOM(expbkt3): Where a row renders in the experimental sidebar —
 * inside its lifecycle group, or parked on one of the two shelves below
 * them.
 */
export type PhaseSidebarSection = "active" | "snoozed" | "settled";

export interface PhaseSidebarPartition {
  readonly activeRows: ReadonlyArray<PhaseSidebarRow>;
  readonly snoozedRows: ReadonlyArray<PhaseSidebarRow>;
  readonly settledRows: ReadonlyArray<PhaseSidebarRow>;
}

function snoozeWakeMs(row: PhaseSidebarRow): number {
  const parsed = Date.parse(row.thread.snoozedUntil ?? "");
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/** Soonest wake first: the shelf reads as a queue of what comes back next. */
export function sortSnoozedPhaseSidebarRows(
  rows: ReadonlyArray<PhaseSidebarRow>,
): ReadonlyArray<PhaseSidebarRow> {
  return rows
    .slice()
    .sort(
      (left, right) =>
        snoozeWakeMs(left) - snoozeWakeMs(right) ||
        String(left.thread.id).localeCompare(String(right.thread.id)),
    );
}

/**
 * Settled rows are history, so they order by when the work ENDED — the same
 * timestamp their label reads, so order and label can never disagree.
 */
export function sortSettledPhaseSidebarRows(
  rows: ReadonlyArray<PhaseSidebarRow>,
): ReadonlyArray<PhaseSidebarRow> {
  const timestampMs = (row: PhaseSidebarRow) => {
    const timestamp = resolveSettledTimestamp(row.thread);
    return timestamp === null ? 0 : Date.parse(timestamp);
  };
  return rows
    .slice()
    .sort(
      (left, right) =>
        timestampMs(right) - timestampMs(left) ||
        String(left.thread.id).localeCompare(String(right.thread.id)),
    );
}

/**
 * T3-CUSTOM(expbkt3): Split visible rows into the lifecycle inbox and the
 * two parked shelves. Snooze deliberately outranks settled classification:
 * an explicitly snoozed thread belongs on the snoozed shelf even when it
 * would also auto-settle, because the shelf carries its wake time.
 *
 * Both classifications are capability-gated per row — auto-settling a
 * thread on a server that cannot un-settle it would strand the row.
 *
 * `preciseNow` classifies snooze (wake times are second-precise) while
 * `now` may be quantized for the day-granular auto-settle window.
 */
export function partitionPhaseSidebarRows(
  rows: ReadonlyArray<PhaseSidebarRow>,
  options: {
    readonly now: string;
    readonly preciseNow: string;
    readonly autoSettleAfterDays: number | null;
    readonly autoSettleOnMerge?: boolean;
  },
): PhaseSidebarPartition {
  const activeRows: PhaseSidebarRow[] = [];
  const snoozedRows: PhaseSidebarRow[] = [];
  const settledRows: PhaseSidebarRow[] = [];

  for (const row of rows) {
    if (row.snoozeSupported && effectiveSnoozed(row.thread, { now: options.preciseNow })) {
      snoozedRows.push(row);
      continue;
    }
    if (
      row.settlementSupported &&
      effectiveSettled(row.thread, {
        now: options.now,
        autoSettleAfterDays: options.autoSettleAfterDays,
        ...(options.autoSettleOnMerge !== undefined
          ? { autoSettleOnMerge: options.autoSettleOnMerge }
          : {}),
        changeRequest:
          row.changeRequestState === null
            ? null
            : {
                state: row.changeRequestState,
                ...(row.changeRequestUpdatedAt !== undefined
                  ? { updatedAt: row.changeRequestUpdatedAt }
                  : {}),
              },
      })
    ) {
      settledRows.push(row);
      continue;
    }
    activeRows.push(row);
  }

  return {
    activeRows,
    snoozedRows: sortSnoozedPhaseSidebarRows(snoozedRows),
    settledRows: sortSettledPhaseSidebarRows(settledRows),
  };
}

/** A stopped projection can still hide a live provider, so any recorded session remains stoppable. */
export function phaseSidebarCanForceStopAgent(session: ThreadShell["runtime"]): boolean {
  return session !== null;
}

export interface PhaseSidebarRepositoryOption {
  readonly key: string;
  readonly label: string;
  readonly searchText: string;
  readonly project: Project;
}

export interface PhaseSidebarGroup extends PhaseSidebarPhaseDefinition {
  readonly rows: ReadonlyArray<PhaseSidebarRow>;
}

export interface PhaseSidebarFilterChip {
  // T3-CUSTOM(expbkt3): "person" is the co-participant facet; "group" the custom group.
  readonly facet: "repository" | "phase" | "provider" | "assignment" | "person" | "group";
  readonly value: string;
  readonly label: string;
}

export function isStrictlyMergeReady(status: VcsStatusResult | null | undefined): boolean {
  const pr = status?.pr;
  if (!pr || pr.state !== "open" || status?.sourceControlProvider?.kind !== "github") return false;
  if (pr.isDraft !== false || pr.mergeability !== "mergeable") return false;
  if (pr.mergeStateStatus?.toUpperCase() !== "CLEAN") return false;
  if (pr.reviewDecision === "changes-requested" || pr.reviewDecision === "review-required") {
    return false;
  }
  return pr.checksStatus === "pass";
}

export function resolvePhaseSidebarAttentionPriority(
  thread: ThreadShell,
  status?: VcsStatusResult | null,
): number {
  if (phaseSidebarNeedsUserInput(thread)) return 0;
  if (thread.hasPendingApprovals) return 1;
  if (thread.runtime?.status === "failed") return 2;
  if (
    status?.pr?.state === "open" &&
    (status.pr.mergeability === "conflicting" ||
      status.pr.checksStatus === "fail" ||
      status.pr.reviewDecision === "changes-requested")
  ) {
    return 3;
  }
  if (thread.runtime === null) return 4;
  return 5;
}

/**
 * T3-CUSTOM(expbkt3): Treat both the durable pending-input bit and the live
 * execution state as authority. This keeps urgent questions promoted even
 * during short execution-snapshot reconnects.
 */
export function phaseSidebarNeedsUserInput(
  thread: Pick<ThreadShell, "hasPendingUserInput">,
): boolean {
  return thread.hasPendingUserInput;
}

/**
 * T3-CUSTOM(expbkt3): an async question — asked mid-turn, answerable without
 * parking the agent. It never touches execution state, so unlike a blocking
 * question nothing else on the row says a human is being waited on.
 */
export function phaseSidebarHasAsyncQuestion(
  thread: Pick<ThreadShell, "hasPendingAsyncUserInput">,
): boolean {
  return thread.hasPendingAsyncUserInput === true;
}

/**
 * T3-CUSTOM(expbkt3): is an agent actually working on this thread right now?
 *
 * Extracted from `resolvePhaseSidebarPhase` because the badge layer needs the
 * same answer: a plan is "ready to decide" only once the turn it came from has
 * settled, and the Ask phase now outranks Plan Ready in the grouping, so the
 * phase id alone can no longer carry that distinction.
 */
export function phaseSidebarIsExecutionActive(thread: Pick<ThreadShell, "runtime">): boolean {
  return (
    thread.runtime?.status === "preparing" ||
    thread.runtime?.status === "starting" ||
    thread.runtime?.status === "running"
  );
}

/**
 * T3-CUSTOM(expbkt3): is the agent alive in any form — a foreground turn, or
 * subagents and watch loops a settled turn left behind? A plan is only "ready
 * to decide" once all of it has stopped; before that the row must read as
 * working, not as parked.
 */
export function phaseSidebarIsAgentLive(
  thread: Pick<ThreadShell, "runtime" | "backgroundLiveness">,
): boolean {
  return (
    phaseSidebarIsExecutionActive(thread) ||
    thread.backgroundLiveness === "working" ||
    thread.backgroundLiveness === "monitoring"
  );
}

// T3-CUSTOM(expbkt3): "ask" and "plan" are attention too — both wait on a human.
export type PhaseSidebarAttentionKind = "input" | "approval" | "error" | "ask" | "plan";

export function resolvePhaseSidebarAttentionKind(
  thread: Pick<
    ThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "hasActionableProposedPlan"
    // T3-CUSTOM(expbkt3): an async question is attention that leaves the agent running.
    | "hasPendingAsyncUserInput"
    // T3-CUSTOM(expbkt3): a session error is a failure the badge has to show.
    | "runtime"
  >,
): PhaseSidebarAttentionKind | null {
  if (phaseSidebarNeedsUserInput(thread)) return "input";
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  // T3-CUSTOM(expbkt3): a session error counts as a failure here too.
  // `resolvePhaseSidebarPhase` already treats `session.status === "failed"` as a
  // failure for grouping, so badging only on execution activity meant a row
  // could be grouped as failed while flying no badge at all.
  if (thread.runtime?.status === "failed") {
    return "error";
  }
  // T3-CUSTOM(expbkt3): ranked below the blocking kinds but above a plan. An
  // async question is answered at leisure too, but it is a question someone
  // actually asked, so it outranks a plan sitting there waiting to be read.
  //
  // It deliberately loses to `plan` in the row badges rather than replacing it:
  // callers render ASK from `phaseSidebarHasAsyncQuestion` alongside whatever
  // this returns, so a thread holding both flies both badges.
  if (thread.hasActionableProposedPlan) return "plan";
  if (phaseSidebarHasAsyncQuestion(thread)) return "ask";
  return null;
}

export function resolvePhaseSidebarPhase(
  thread: ThreadShell,
  _status?: VcsStatusResult | null,
): PhaseSidebarPhaseId {
  if (phaseSidebarNeedsUserInput(thread)) return "needs_input";
  // T3-CUSTOM(expbkt3): a pending approval blocks the agent the same way a
  // question does. It used to leave the row under Implementing, while the same
  // approval on a child turned the parent red.
  if (thread.hasPendingApprovals) return "needs_input";

  // T3-CUSTOM(expbkt3): an async question outranks liveness, because it does
  // not change liveness at all — the agent asked and carried on working, so
  // grouping by execution state would file the question under Implementing and
  // nobody would ever see it. Checked below Needs Input: a parked session is
  // the more urgent of the two.
  if (phaseSidebarHasAsyncQuestion(thread)) return "ask";

  // A failed provider is actionable even if a stale durable intent or
  // background-liveness projection has not cleared yet.
  const hasFailure = thread.runtime?.status === "failed";

  // T3-CUSTOM(expbkt3): group from the same durable intent as the badge.
  const isActive = phaseSidebarIsExecutionActive(thread);
  if (!hasFailure && isActive) {
    return thread.interactionMode === "plan" ? "planning" : "implementing";
  }

  // Sidebar V2's reliability ordering: a failure must not be hidden by
  // liveness that can linger while background work winds down.
  if (hasFailure) {
    // T3-CUSTOM(expbkt3): a failure still files a held plan under Plan Ready.
    return thread.hasActionableProposedPlan ? "plan_ready" : "ready";
  }

  // A settled foreground turn can still own native subagents, workflows, or
  // watch scripts. Keep it among agent-work rows until the authoritative
  // server projection clears instead of prematurely dropping it into Ready.
  //
  // T3-CUSTOM(expbkt3): checked before Plan Ready. A session whose subagents or
  // monitor are still running is not stopped, so filing it under Plan Ready
  // made it look parked while it was still working.
  if (thread.backgroundLiveness === "working" || thread.backgroundLiveness === "monitoring") {
    return thread.interactionMode === "plan" ? "planning" : "implementing";
  }

  // T3-CUSTOM(expbkt3): Plan Ready means a plan is waiting for a human, in any
  // interaction mode. `t3_submit_plan` never changes interactionMode, so gating
  // this on plan mode hid every plan submitted from a default-mode turn. A
  // settled turn holding an actionable plan outranks a failure: the row's whole
  // job is the decision, and the failure still flies its own badge.
  if (thread.hasActionableProposedPlan) return "plan_ready";

  // T3-CUSTOM(expbkt3): an idle plan-mode thread with nothing to decide is just
  // idle. It used to land in Plan Ready, which made the group unscannable — the
  // rows that needed a human were mixed in with the ones that did not.
  return "ready";
}

/**
 * Keep a thread in its last rendered lifecycle group while live execution
 * authority is temporarily unavailable. The underlying execution snapshot is
 * still cleared on disconnect; this only stabilizes sidebar presentation until
 * a fresh execution frame arrives.
 */
export function resolvePhaseSidebarDisplayPhase(
  currentPhase: PhaseSidebarPhaseId,
  _previousPhase: PhaseSidebarPhaseId | null,
): PhaseSidebarPhaseId {
  return currentPhase;
}

export function derivePhaseSidebarRepositoryKey(project: Project): string {
  return deriveLogicalProjectKey(project, { groupingMode: "repository" });
}

export function buildPhaseSidebarRepositoryOptions(
  projects: ReadonlyArray<Project>,
): ReadonlyArray<PhaseSidebarRepositoryOption> {
  const grouped = new Map<string, Project[]>();
  for (const project of projects) {
    const key = derivePhaseSidebarRepositoryKey(project);
    const members = grouped.get(key);
    if (members) members.push(project);
    else grouped.set(key, [project]);
  }

  return [...grouped.entries()]
    .map(([key, members]) => {
      const sortedMembers = members
        .slice()
        .sort((left, right) =>
          `${left.environmentId}:${left.id}`.localeCompare(`${right.environmentId}:${right.id}`),
        );
      const nicknames = [...new Set(sortedMembers.map((project) => project.title))].sort(
        (left, right) => left.localeCompare(right),
      );
      const canonicalLabels = [
        ...new Set(
          sortedMembers.flatMap((project) => {
            const identity = project.repositoryIdentity;
            if (!identity) return [];
            return [identity.displayName, identity.name].filter(
              (value): value is string => typeof value === "string" && value.length > 0,
            );
          }),
        ),
      ].sort((left, right) => left.localeCompare(right));
      const label =
        nicknames.length === 1
          ? nicknames[0]!
          : (canonicalLabels[0] ?? nicknames[0] ?? "Unknown repository");
      const searchText = [
        ...nicknames,
        ...canonicalLabels,
        ...sortedMembers.flatMap((project) => {
          const identity = project.repositoryIdentity;
          return identity ? [identity.canonicalKey, identity.owner ?? ""] : [];
        }),
      ].join(" ");
      return { key, label, searchText, project: sortedMembers[0]! };
    })
    .sort(
      (left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key),
    );
}

const KNOWN_PROVIDER_CODES: Readonly<Record<string, string>> = {
  claudeAgent: "cc",
  codex: "cx",
  cursor: "cu",
  grok: "gr",
  opencode: "oc",
};

export function resolvePhaseSidebarProviderCode(providerKind: string): string {
  const known = KNOWN_PROVIDER_CODES[providerKind];
  if (known) return known;

  const normalized = providerKind
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
  if (!normalized) return "uk";
  const words = normalized.split(/\s+/);
  if (words.length > 1) {
    return `${words[0]?.[0] ?? "?"}${words[1]?.[0] ?? "?"}`;
  }
  return normalized.length === 1 ? normalized.repeat(2) : normalized.slice(0, 2);
}

export function matchesPhaseSidebarFilters(
  row: PhaseSidebarRow,
  filters: PhaseSidebarFilters,
): boolean {
  return (
    (filters.repositoryKeys.length === 0 || filters.repositoryKeys.includes(row.repositoryKey)) &&
    (filters.phaseIds.length === 0 || filters.phaseIds.includes(row.phaseId)) &&
    (filters.providerKinds.length === 0 || filters.providerKinds.includes(row.providerKind)) &&
    // T3-CUSTOM(expbkt3): BEGIN — ownership and co-participant facets.
    (!filters.ownedByMe || row.isOwnedByMe) &&
    // Every selected person must be on the thread: selecting two people asks
    // for their shared sessions, not the union of their work.
    (filters.participantUserIds.length === 0 ||
      filters.participantUserIds.every((userId) => row.participantUserIds.includes(userId))) &&
    // Custom group: any selected group, or "Ungrouped" for rows with none.
    (filters.customGroups.length === 0 ||
      filters.customGroups.includes(
        phaseSidebarCustomGroupIdForRow(row) ?? PHASE_SIDEBAR_UNGROUPED_ID,
      ))
    // T3-CUSTOM(expbkt3): END
  );
}

/**
 * The rows this sidebar may render at all. Shared by the lifecycle groups and
 * the parked shelves so a filter chip means the same thing everywhere.
 */
export function filterVisiblePhaseSidebarRows(
  rows: ReadonlyArray<PhaseSidebarRow>,
  filters: PhaseSidebarFilters,
): ReadonlyArray<PhaseSidebarRow> {
  return rows.filter(
    (row) => row.thread.archivedAt === null && matchesPhaseSidebarFilters(row, filters),
  );
}

/**
 * T3-CUSTOM(expbkt3): sort rank for a thread's priority. Unprioritised rows
 * rank after P4 so an explicit P4 still outranks "no opinion".
 */
export function phaseSidebarPriorityRank(thread: ThreadShell): number {
  return thread.priority ?? PHASE_SIDEBAR_UNPRIORITISED_RANK;
}

export const PHASE_SIDEBAR_UNPRIORITISED_RANK = 5;

/** T3-CUSTOM(expbkt3): render label for a priority value ("P0".."P4"). */
export function formatThreadPriority(priority: number): string {
  return `P${priority}`;
}

/** T3-CUSTOM(expbkt3): the priority values offered in the row context menu. */
export const PHASE_SIDEBAR_PRIORITY_CHOICES = [
  { value: 0, label: "P0 — Urgent" },
  { value: 1, label: "P1 — High" },
  { value: 2, label: "P2 — Medium" },
  { value: 3, label: "P3 — Low" },
  { value: 4, label: "P4 — Lowest" },
] as const satisfies ReadonlyArray<{ readonly value: 0 | 1 | 2 | 3 | 4; readonly label: string }>;

/** T3-CUSTOM(expbkt3): Which end of the time axis leads inside a lifecycle group. */
export type PhaseSidebarSortDirection = "newest_first" | "oldest_first";

export interface PhaseSidebarSortPreferences {
  readonly direction: PhaseSidebarSortDirection;
  /** When true, P0 outranks every lower priority; ties fall through to time. */
  readonly priorityFirst: boolean;
}

export const DEFAULT_PHASE_SIDEBAR_SORT: PhaseSidebarSortPreferences = {
  direction: "newest_first",
  priorityFirst: true,
};

export const PHASE_SIDEBAR_SORT_DIRECTION_LABELS: Record<PhaseSidebarSortDirection, string> = {
  newest_first: "Most recent on top",
  oldest_first: "Oldest on top",
};

export function sanitizePhaseSidebarSort(value: unknown): PhaseSidebarSortPreferences {
  if (!value || typeof value !== "object") return DEFAULT_PHASE_SIDEBAR_SORT;
  const candidate = value as Partial<Record<keyof PhaseSidebarSortPreferences, unknown>>;
  return {
    direction:
      candidate.direction === "oldest_first" || candidate.direction === "newest_first"
        ? candidate.direction
        : DEFAULT_PHASE_SIDEBAR_SORT.direction,
    priorityFirst:
      typeof candidate.priorityFirst === "boolean"
        ? candidate.priorityFirst
        : DEFAULT_PHASE_SIDEBAR_SORT.priorityFirst,
  };
}

/**
 * T3-CUSTOM(expbkt3): Ordering inside a lifecycle group is deliberately STRICT —
 * it reads only the thread's priority, its sort timestamp, and stable tiebreaks.
 *
 * It used to also fold in `attentionPriority` and `isUnreadCompletion`. Both flip
 * the moment you open a row, so simply reading a thread reordered the group under
 * the pointer. Those states are already visible on the row (glint, unread dot) and
 * hoisted into their own groups upstream, so ordering does not need to repeat them
 * at the cost of a list that moves while you use it.
 */
export function comparePhaseSidebarRows(
  left: PhaseSidebarRow,
  right: PhaseSidebarRow,
  sortOrder: SidebarThreadSortOrder,
  sort: PhaseSidebarSortPreferences,
): number {
  // T3-CUSTOM(expbkt3): a pinned thread sorts to the top of its group.
  //
  // Pin and unpin already existed in the row context menu but changed nothing
  // observable: this comparator ignored `pinnedAt` and no row rendered it, so
  // pinning was a no-op the UI still offered. Pinning inside the group rather
  // than lifting rows into a section of their own keeps the lifecycle grouping
  // intact — the whole premise of this sidebar.
  const pinDelta = (right.thread.pinnedAt ? 1 : 0) - (left.thread.pinnedAt ? 1 : 0);
  const priorityDelta = sort.priorityFirst
    ? phaseSidebarPriorityRank(left.thread) - phaseSidebarPriorityRank(right.thread)
    : 0;
  const leftTime = getThreadSortTimestamp(left.thread, sortOrder);
  const rightTime = getThreadSortTimestamp(right.thread, sortOrder);
  const timeDelta = sort.direction === "oldest_first" ? leftTime - rightTime : rightTime - leftTime;
  return (
    pinDelta ||
    priorityDelta ||
    timeDelta ||
    left.thread.title.localeCompare(right.thread.title) ||
    String(left.thread.id).localeCompare(String(right.thread.id))
  );
}

export function buildPhaseSidebarGroups(
  rows: ReadonlyArray<PhaseSidebarRow>,
  filters: PhaseSidebarFilters,
  sortOrder: SidebarThreadSortOrder,
  sort: PhaseSidebarSortPreferences = DEFAULT_PHASE_SIDEBAR_SORT,
): ReadonlyArray<PhaseSidebarGroup> {
  const visibleRows = filterVisiblePhaseSidebarRows(rows, filters);

  return PHASE_SIDEBAR_PHASES.flatMap((phase) => {
    const phaseRows = visibleRows
      .filter((row) => row.phaseId === phase.id)
      .sort((left, right) => comparePhaseSidebarRows(left, right, sortOrder, sort));
    return phaseRows.length > 0 ? [{ ...phase, rows: phaseRows }] : [];
  });
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      ),
    ),
  ];
}

export function sanitizePhaseSidebarFilters(value: unknown): PhaseSidebarFilters {
  if (!value || typeof value !== "object") return EMPTY_PHASE_SIDEBAR_FILTERS;
  const candidate = value as Partial<Record<keyof PhaseSidebarFilters, unknown>>;
  return {
    repositoryKeys: sanitizeStringArray(candidate.repositoryKeys),
    phaseIds: sanitizeStringArray(candidate.phaseIds).filter(
      (phaseId): phaseId is PhaseSidebarPhaseId => PHASE_ID_SET.has(phaseId),
    ),
    providerKinds: sanitizeStringArray(candidate.providerKinds),
    // T3-CUSTOM(expbkt3): missing on blobs written before these facets existed,
    // so both default off; storage stays v1.
    ownedByMe: candidate.ownedByMe === true,
    participantUserIds: sanitizeStringArray(candidate.participantUserIds),
    customGroups: sanitizeStringArray(candidate.customGroups),
  };
}

export function reconcilePhaseSidebarFilters(
  filters: PhaseSidebarFilters,
  options: {
    readonly repositoryKeys: ReadonlySet<string>;
    readonly providerKinds: ReadonlySet<string>;
    // False on single-user builds (no operator identity): a persisted
    // ownership filter would otherwise hide every thread.
    readonly assignmentAvailable: boolean;
    // T3-CUSTOM(expbkt3): people still present in the directory. A teammate who
    // leaves must not keep an invisible filter pinned over the sidebar.
    readonly participantUserIds?: ReadonlySet<string>;
  },
): PhaseSidebarFilters {
  const knownParticipants = options.participantUserIds;
  return {
    repositoryKeys: filters.repositoryKeys.filter((key) => options.repositoryKeys.has(key)),
    phaseIds: filters.phaseIds.filter((phaseId) => PHASE_ID_SET.has(phaseId)),
    providerKinds: filters.providerKinds.filter((kind) => options.providerKinds.has(kind)),
    ownedByMe: options.assignmentAvailable ? filters.ownedByMe : false,
    participantUserIds: !options.assignmentAvailable
      ? []
      : knownParticipants === undefined
        ? filters.participantUserIds
        : filters.participantUserIds.filter((userId) => knownParticipants.has(userId)),
    // T3-CUSTOM(expbkt3): never reconciled — a group may live only on an
    // environment that is offline right now, and a stale selection is visible
    // as a chip the user can remove.
    customGroups: filters.customGroups,
  };
}

export function buildPhaseSidebarFilterChips(
  filters: PhaseSidebarFilters,
  labels: {
    readonly repositories: ReadonlyMap<string, string>;
    readonly providers: ReadonlyMap<string, string>;
    // T3-CUSTOM(expbkt3): display names for the co-participant facet.
    readonly people?: ReadonlyMap<string, string>;
    // T3-CUSTOM(expbkt3): display labels for custom group ids.
    readonly customGroups?: ReadonlyMap<string, string>;
  },
): ReadonlyArray<PhaseSidebarFilterChip> {
  const phaseLabels = new Map(PHASE_SIDEBAR_PHASES.map((phase) => [phase.id, phase.label]));
  return [
    ...filters.repositoryKeys.map((value) => ({
      facet: "repository" as const,
      value,
      label: labels.repositories.get(value) ?? value,
    })),
    ...filters.phaseIds.map((value) => ({
      facet: "phase" as const,
      value,
      label: phaseLabels.get(value) ?? value,
    })),
    ...filters.providerKinds.map((value) => ({
      facet: "provider" as const,
      value,
      label: labels.providers.get(value) ?? value,
    })),
    // T3-CUSTOM(expbkt3): BEGIN — ownership and co-participant chips.
    ...(filters.ownedByMe
      ? [{ facet: "assignment" as const, value: "owned-by-me", label: "Started by me" }]
      : []),
    ...filters.participantUserIds.map((value) => ({
      facet: "person" as const,
      value,
      label: labels.people?.get(value) ?? "Teammate",
    })),
    ...filters.customGroups.map((value) => ({
      facet: "group" as const,
      value,
      label:
        value === PHASE_SIDEBAR_UNGROUPED_ID
          ? "Ungrouped"
          : (labels.customGroups?.get(value) ?? value),
    })),
    // T3-CUSTOM(expbkt3): END
  ];
}

export function flattenPhaseSidebarGroups(
  groups: ReadonlyArray<PhaseSidebarGroup>,
): ReadonlyArray<PhaseSidebarRow> {
  return groups.flatMap((group) => group.rows);
}

export function resolvePhaseSidebarTraversalTarget(input: {
  readonly visibleThreadKeys: ReadonlyArray<string>;
  readonly currentThreadKey: string | null;
  readonly direction: "previous" | "next";
}): string | null {
  if (input.visibleThreadKeys.length === 0) return null;
  const currentIndex = input.currentThreadKey
    ? input.visibleThreadKeys.indexOf(input.currentThreadKey)
    : -1;
  if (currentIndex === -1) {
    return input.direction === "previous"
      ? (input.visibleThreadKeys.at(-1) ?? null)
      : (input.visibleThreadKeys[0] ?? null);
  }
  if (input.direction === "previous") {
    return currentIndex > 0 ? (input.visibleThreadKeys[currentIndex - 1] ?? null) : null;
  }
  return currentIndex < input.visibleThreadKeys.length - 1
    ? (input.visibleThreadKeys[currentIndex + 1] ?? null)
    : null;
}

// ---------------------------------------------------------------------------
// T3-CUSTOM(expbkt3): Lifecycle counters.
//
// Moved here from apps/web/src/components/sidebar/sidebarSessionCounters.ts so
// the mobile home list can show the same running/idle summary the web sidebar
// chrome does.
// ---------------------------------------------------------------------------

export interface SidebarSessionCounts {
  /** Unsettled sessions with no agent working: the ones waiting on a human. */
  readonly nonRunning: number;
  readonly running: number;
  /**
   * Sessions whose last turn finished after the viewer last opened them.
   * Counted across running and idle sessions alike — "have I read this" is
   * independent of whether the agent has since started again.
   */
  readonly unread: number;
  readonly nextSnoozeWakeAt: string | null;
}

export interface SidebarSessionCountOptions {
  readonly now: string;
  readonly snoozeSupported: (thread: ThreadShell) => boolean;
  /**
   * When the viewer last opened a session, keyed by scoped thread key. Absent
   * callers get an unread count of zero rather than a guess.
   */
  readonly lastVisitedAtByThreadKey?: Readonly<Record<string, string | undefined>>;
}

export function threadNeedsHumanAttention(thread: ThreadShell): boolean {
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    // T3-CUSTOM(expbkt3): an async question is a human step too, even though it
    // leaves the agent running.
    phaseSidebarHasAsyncQuestion(thread) ||
    thread.hasActionableProposedPlan ||
    thread.runtime?.status === "failed"
  );
}

export function threadIsRunning(thread: ThreadShell): boolean {
  return (
    thread.runtime?.status === "preparing" ||
    thread.runtime?.status === "starting" ||
    thread.runtime?.status === "running" ||
    thread.backgroundLiveness === "working" ||
    thread.backgroundLiveness === "monitoring"
  );
}

/**
 * T3-CUSTOM(expbkt3): whether a thread is a session the user works with
 * directly. Subagent threads (provider subagents and `delegate_task` children)
 * are driven by their parent agent and cannot take a user's message, so the
 * session list neither nests nor counts them; they stay visible in the parent
 * chat's Lineage panel. Child sessions created with `t3_create_session` link
 * through `parentThreadId` alone and keep nesting.
 */
export function isPhaseSidebarSessionThread(thread: Pick<ThreadShell, "lineage">): boolean {
  // Optional read: partial shells from older clients' fixtures carry no lineage.
  return thread.lineage?.relationshipToParent !== "subagent";
}

export function summarizeSidebarSessions(
  threads: ReadonlyArray<ThreadShell>,
  options: SidebarSessionCountOptions,
): SidebarSessionCounts {
  let nonRunning = 0;
  let running = 0;
  let unread = 0;
  let nextSnoozeWakeAt: string | null = null;
  let nextSnoozeWakeAtMs = Number.POSITIVE_INFINITY;

  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.settledAt !== null) continue;
    if (!isPhaseSidebarSessionThread(thread)) continue;
    if (
      options.lastVisitedAtByThreadKey !== undefined &&
      hasUnseenCompletion({
        latestRun: thread.latestRun,
        lastVisitedAt:
          thread.lastVisitedAt === undefined
            ? options.lastVisitedAtByThreadKey[
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
              ]
            : thread.lastVisitedAt,
      })
    ) {
      unread += 1;
    }
    if (threadIsRunning(thread)) {
      running += 1;
      continue;
    }
    if (options.snoozeSupported(thread) && effectiveSnoozed(thread, { now: options.now })) {
      const wakeAtMs = Date.parse(thread.snoozedUntil ?? "");
      if (wakeAtMs < nextSnoozeWakeAtMs) {
        nextSnoozeWakeAt = thread.snoozedUntil ?? null;
        nextSnoozeWakeAtMs = wakeAtMs;
      }
      continue;
    }
    nonRunning += 1;
  }

  return { nonRunning, running, unread, nextSnoozeWakeAt };
}

// ---------------------------------------------------------------------------
// T3-CUSTOM(expbkt3): Running-session emphasis.
//
// Moved from apps/web/src/components/sidebar/RunningSessionGlint.logic.ts. Web
// renders the emphasis as an animated glint; mobile renders it statically, so
// only the decision is shared, never the presentation.
// ---------------------------------------------------------------------------

export function isRunningSessionPhase(phaseId: PhaseSidebarPhaseId): boolean {
  return phaseId === "planning" || phaseId === "implementing";
}

/** Running emphasis belongs only to live lifecycle rows, never parked history. */
export function shouldShowRunningSessionGlint(
  phaseId: PhaseSidebarPhaseId,
  section: PhaseSidebarSection,
): boolean {
  return section === "active" && isRunningSessionPhase(phaseId);
}

/** Place one quiet boundary before running work when idle groups are also visible. */
export function runningSessionDividerPhase(
  phaseIds: ReadonlyArray<PhaseSidebarPhaseId>,
): PhaseSidebarPhaseId | null {
  if (!phaseIds.some((phaseId) => !isRunningSessionPhase(phaseId))) return null;
  return phaseIds.find(isRunningSessionPhase) ?? null;
}

// ---------------------------------------------------------------------------
// T3-CUSTOM(expbkt3): "Move under session" candidates.
//
// Moved from apps/web/src/components/sidebar/MoveUnderSessionDialog.logic.ts.
// This is the client-side mirror of the server's cycle guard, and the two must
// not drift — so both clients run the same copy.
// ---------------------------------------------------------------------------

export interface MoveUnderCandidate {
  readonly thread: ThreadShell;
  readonly label: string;
  readonly repositoryLabel: string;
}

/**
 * T3-CUSTOM(expbkt3): the key lineage is matched on.
 *
 * Exported because a lineage can now cross environments, so every consumer of
 * `collectDescendantThreadIds` has to speak the same (environment, thread) pair
 * rather than a bare id.
 */
export function scopedThreadLineageKey(environmentId: string, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

const scopedKey = scopedThreadLineageKey;

/**
 * The scoped key of a thread's parent, or null for a root.
 *
 * T3-CUSTOM(expbkt3): a parent may live on another environment, so lineage is
 * matched on the (environment, thread) pair. An absent parent environment means
 * the thread's own, which is what every same-server link means.
 */
function parentScopedKey(thread: ThreadShell): string | null {
  const parentThreadId = thread.parentThreadId ?? null;
  if (parentThreadId === null) return null;
  return scopedKey(thread.parentEnvironmentId ?? thread.environmentId, parentThreadId);
}

/**
 * Every thread reachable downwards from `threadId`, excluding itself. Bounded
 * by the thread count: each id is enqueued at most once, so a corrupt cycle in
 * the projection cannot make this loop forever.
 *
 * T3-CUSTOM(expbkt3): walks (environment, thread) pairs, because a lineage can
 * now cross environments and a bare id is ambiguous across them.
 */
export function collectDescendantThreadIds(
  threads: ReadonlyArray<ThreadShell>,
  threadId: string,
  environmentId?: string,
): ReadonlySet<string> {
  const rootEnvironmentId =
    environmentId ?? threads.find((thread) => thread.id === threadId)?.environmentId ?? "";
  const rootKey = scopedKey(rootEnvironmentId, threadId);
  const descendants = new Set<string>();
  const queue: string[] = [rootKey];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const thread of threads) {
      const key = scopedKey(thread.environmentId, thread.id);
      if (parentScopedKey(thread) !== current) continue;
      if (key === rootKey || descendants.has(key)) continue;
      descendants.add(key);
      queue.push(key);
    }
  }
  return descendants;
}

/**
 * Candidate parents for `subject`, newest first, filtered by `query`.
 *
 * Excluded: the thread itself, its descendants (the server would reject those
 * as cycles, so offering them would only produce a confusing failure toast),
 * archived threads, and its current parent (already there).
 *
 * T3-CUSTOM(expbkt3): threads on other environments are now offered. A session
 * spread across machines — a child started locally under work on a remote host
 * — is the case this exists for, so the picker no longer hides the other half
 * of it. Descendants are excluded across environments too, so the offer cannot
 * propose a loop.
 */
export function resolveMoveUnderCandidates(input: {
  readonly threads: ReadonlyArray<ThreadShell>;
  readonly subject: ThreadShell;
  readonly query: string;
  readonly repositoryLabelFor: (thread: ThreadShell) => string;
  readonly limit?: number;
}): ReadonlyArray<MoveUnderCandidate> {
  const blocked = collectDescendantThreadIds(
    input.threads,
    input.subject.id,
    input.subject.environmentId,
  );
  const needle = input.query.trim().toLowerCase();
  const subjectKey = scopedKey(input.subject.environmentId, input.subject.id);
  const currentParentKey = parentScopedKey(input.subject);

  return input.threads
    .filter((thread) => {
      const key = scopedKey(thread.environmentId, thread.id);
      return (
        key !== subjectKey &&
        !blocked.has(key) &&
        thread.archivedAt === null &&
        key !== currentParentKey &&
        (needle.length === 0 || thread.title.toLowerCase().includes(needle))
      );
    })
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        String(left.id).localeCompare(String(right.id)),
    )
    .slice(0, input.limit ?? 50)
    .map((thread) => ({
      thread,
      label: thread.title,
      repositoryLabel: input.repositoryLabelFor(thread),
    }));
}

// ---------------------------------------------------------------------------
// T3-CUSTOM(expbkt3): Unread tracking.
//
// Moved from apps/web/src/threadVisitTimestamp.ts. Both clients compare a
// thread's newest activity against the last time this device opened it; where
// that "last visited" map is stored is platform-specific, but the rule that
// decides what counts as newer is not.
// ---------------------------------------------------------------------------

export interface ThreadVisitTimestampInput {
  readonly threadUpdatedAt: string;
  readonly latestTurnCompletedAt: string | null | undefined;
}

export function resolveThreadVisitTimestamp(input: ThreadVisitTimestampInput): string {
  const threadUpdatedAtMs = Date.parse(input.threadUpdatedAt);
  const latestTurnCompletedAt = input.latestTurnCompletedAt;
  const latestTurnCompletedAtMs = latestTurnCompletedAt
    ? Date.parse(latestTurnCompletedAt)
    : Number.NaN;
  if (
    latestTurnCompletedAt != null &&
    Number.isFinite(latestTurnCompletedAtMs) &&
    (!Number.isFinite(threadUpdatedAtMs) || latestTurnCompletedAtMs > threadUpdatedAtMs)
  ) {
    return latestTurnCompletedAt;
  }
  return input.threadUpdatedAt;
}

/**
 * Whether a row should show the unread dot: the thread has newer activity than
 * the last visit this device recorded. An unvisited thread is NOT unread —
 * otherwise a fresh install marks the entire list.
 */
/**
 * T3-CUSTOM(expbkt3): Whether a finished turn has not been looked at yet.
 *
 * Moved here from apps/web/src/components/Sidebar.logic.ts (which re-exports it)
 * so `buildPhaseSidebarRows` can run on both clients. Deliberately NOT unified
 * with `isThreadUnread` below: this one treats an unparseable visit timestamp as
 * unread, and that difference is load-bearing for the row's dot.
 */
export function hasUnseenCompletion(
  thread: Pick<ThreadShell, "latestRun"> & {
    readonly lastVisitedAt?: string | null | undefined;
    /** Callers pass whole thread shells; extra facts are simply unread here. */
    readonly [extra: string]: unknown;
  },
): boolean {
  if (!thread.latestRun?.completedAt) return false;
  const completedAt = Date.parse(thread.latestRun.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function isThreadUnread(input: {
  readonly threadUpdatedAt: string;
  readonly latestTurnCompletedAt: string | null | undefined;
  readonly lastVisitedAt: string | null | undefined;
}): boolean {
  if (input.lastVisitedAt == null) return false;
  const lastVisitedAtMs = Date.parse(input.lastVisitedAt);
  if (Number.isNaN(lastVisitedAtMs)) return false;
  const activityAtMs = Date.parse(resolveThreadVisitTimestamp(input));
  if (Number.isNaN(activityAtMs)) return false;
  return activityAtMs > lastVisitedAtMs;
}

/**
 * T3-CUSTOM(expbkt3): Everything needed to turn raw thread shells into rows.
 *
 * `projects` and `serverConfigs` are the caller's own maps rather than derived
 * state, because both clients already hold them; the repository key and label
 * tables are derived here so neither client has to reproduce that stitching.
 */
export interface BuildPhaseSidebarRowsInput {
  readonly threads: ReadonlyArray<ThreadShell>;
  readonly projects: ReadonlyArray<Project>;
  readonly serverConfigs: ReadonlyMap<string, ServerConfig>;
  /** Keyed by `scopedThreadKey`. Absent entries simply have no VCS facts yet. */
  readonly vcsStatusByThreadKey: ReadonlyMap<string, VcsStatusResult | null>;
  /** Keyed by `scopedThreadKey`. */
  readonly lastVisitedAtByThreadKey: Readonly<Record<string, string | undefined>>;
  readonly currentUserId: UserId | null;
  /**
   * When false, a row falls back to its last known phase rather than flapping
   * to a wrong one while an environment's shells are still arriving.
   */
  readonly allEnvironmentShellsLive: boolean;
  /** Keyed by `scopedThreadKey`. Null when the caller keeps no history. */
  readonly lastKnownPhaseByThreadKey: ReadonlyMap<string, PhaseSidebarPhaseId> | null;
  /**
   * T3-CUSTOM(expbkt3): the device-local custom group a thread was placed in
   * before group labels lived on the thread. Consulted only when the thread
   * has no `customGroup` of its own, so nobody loses their layout on upgrade;
   * a label set on the server always wins.
   */
  readonly localCustomGroupForKey?: (threadKey: string) => string | null;
}

/**
 * Builds the sidebar's row model. Pure, so both the web sidebar and the mobile
 * phase sidebar render the same lifecycle, badges and ownership facts.
 */
export function buildPhaseSidebarRows(
  input: BuildPhaseSidebarRowsInput,
): ReadonlyArray<PhaseSidebarRow> {
  const projectByKey = new Map(
    input.projects.map((project) => [
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      project,
    ]),
  );
  const repositoryLabels = new Map(
    buildPhaseSidebarRepositoryOptions(input.projects).map((option) => [option.key, option.label]),
  );

  // T3-CUSTOM(expbkt3): subagents are not sessions; see isPhaseSidebarSessionThread.
  return input.threads.filter(isPhaseSidebarSessionThread).map((thread) => {
    const project = projectByKey.get(
      scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
    );
    const repositoryKey = project
      ? derivePhaseSidebarRepositoryKey(project)
      : scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
    const serverConfig = input.serverConfigs.get(thread.environmentId);
    const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
    const provider = serverConfig?.providers.find(
      (candidate) => candidate.instanceId === instanceId,
    );
    const providerKind = String(provider?.driver ?? instanceId);
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const vcsStatus = input.vcsStatusByThreadKey.get(threadKey);
    const currentPhase = resolvePhaseSidebarPhase(thread, vcsStatus);
    const capabilities = serverConfig?.environment.capabilities;

    return {
      thread,
      phaseId: resolvePhaseSidebarDisplayPhase(
        currentPhase,
        input.allEnvironmentShellsLive
          ? null
          : (input.lastKnownPhaseByThreadKey?.get(threadKey) ?? null),
      ),
      repositoryKey,
      repositoryLabel:
        project?.title ?? repositoryLabels.get(repositoryKey) ?? "Unknown repository",
      providerKind,
      providerName: provider?.displayName ?? thread.runtime?.providerName ?? String(instanceId),
      isAssignedToMe:
        input.currentUserId !== null && isThreadAssignedToUser(thread, input.currentUserId),
      isOwnedByMe: input.currentUserId !== null && thread.ownerUserId === input.currentUserId,
      participantUserIds: phaseSidebarThreadParticipantIds(thread),
      attentionPriority: resolvePhaseSidebarAttentionPriority(thread, vcsStatus),
      isUnreadCompletion: hasUnseenCompletion({
        ...thread,
        lastVisitedAt:
          thread.lastVisitedAt === undefined
            ? input.lastVisitedAtByThreadKey[threadKey]
            : thread.lastVisitedAt,
      }),
      settlementSupported: capabilities?.threadSettlement === true,
      snoozeSupported: capabilities?.threadSnooze === true,
      prioritySupported: capabilities?.threadPriority === true,
      // T3-CUSTOM(expbkt3): custom sidebar group, server label first.
      customGroup: thread.customGroup ?? input.localCustomGroupForKey?.(threadKey) ?? null,
      customGroupSupported: capabilities?.threadCustomGroup === true,
      linearIssueSupported: capabilities?.threadLinearIssue === true,
      linearLinksSupported: capabilities?.threadLinearLinks === true,
      mattermostLinkSupported: capabilities?.threadMattermostLink === true,
      titleRegenerationSupported: capabilities?.threadTitleRegeneration === true,
      changeRequestState: vcsStatus?.pr?.state ?? null,
      changeRequestUpdatedAt: vcsStatus?.pr?.updatedAt ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// T3-CUSTOM(expbkt3): row status — elapsed working time and running subagents.
// ---------------------------------------------------------------------------

/**
 * Upstream's "working" rule, copied from `resolveSidebarThreadStatus` in
 * apps/web/src/components/Sidebar.logic.ts (upstream-owned, and web-only, so
 * mobile cannot import it): the runtime is preparing, queued, starting,
 * running or waiting, and nothing waits on the user. A web test compares the
 * two over every runtime status, so a change upstream fails CI here.
 */
export function phaseSidebarIsWorking(
  thread: Pick<ThreadShell, "hasPendingApprovals" | "hasPendingUserInput" | "runtime">,
): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  const status = thread.runtime?.status;
  return (
    status === "preparing" ||
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
  );
}

export interface PhaseSidebarWorkingStatus {
  /** "Goal" while a native /goal keeps the agent going across turns, as upstream. */
  readonly label: "Working" | "Goal";
  /** When the current work started; null when the server cannot say. */
  readonly startedAt: string | null;
}

/** The row's "Working 4m" status, or null when the row is not working. */
export function resolvePhaseSidebarWorkingStatus(
  thread: Pick<
    ThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "runtime" | "latestRun" | "goal"
  >,
): PhaseSidebarWorkingStatus | null {
  if (!phaseSidebarIsWorking(thread)) return null;
  return {
    label: thread.goal?.status === "active" ? "Goal" : "Working",
    startedAt: resolveThreadWorkingStartedAt(thread),
  };
}

/**
 * Upstream's `formatWorkingDurationLabel`, copied for the same reason as
 * `phaseSidebarIsWorking`: "42s", "4m", "1h 5m".
 */
export function formatPhaseSidebarWorkingDuration(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The work badge to show beside the working status. While "Working 4m" shows,
 * RUNNING and WORKING only repeat it; STARTING (a turn still booting) and
 * MONITORING (a watch loop, not a turn) still add something.
 */
export function resolvePhaseSidebarVisibleWorkBadge(
  badge: PhaseSidebarWorkBadge | null,
  workingStatusShown: boolean,
): PhaseSidebarWorkBadge | null {
  if (badge === null || !workingStatusShown) return badge;
  return badge.monitoring || badge.label === "Starting" ? badge : null;
}

/**
 * Provider-native subagents running under the thread right now. Reads the
 * shell's `activeSubagentCount` through a structural type, so a server that
 * does not send it (or a shell type without it) reads as none.
 */
export function phaseSidebarActiveSubagentCount(thread: {
  readonly id: unknown;
  readonly activeSubagentCount?: number | null | undefined;
}): number {
  const count = thread.activeSubagentCount ?? 0;
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/** "1 subagent running", "3 subagents running"; null when there are none. */
export function phaseSidebarSubagentCountLabel(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  const whole = Math.floor(count);
  return `${whole} subagent${whole === 1 ? "" : "s"} running`;
}
