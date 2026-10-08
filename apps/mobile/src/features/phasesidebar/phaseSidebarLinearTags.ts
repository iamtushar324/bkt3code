// T3-CUSTOM(expbkt3): a session's Linear tags as the BK sidebar row shows them.
//
// A session can carry several tags: its project, main issues and sub-issues.
// The stored tag only knows "issue" or "project"; whether an issue is a
// sub-issue is Linear's to say, so it comes from the batched status lookup
// (`parentIdentifier`). Until that lookup lands, an issue reads as a main issue.
//
// Pure on purpose: no React Native or Expo imports, so tests stay cheap.
import type { LinearIssueStatusSummary, ThreadLinearLink } from "@t3tools/contracts";
import {
  linearIssueFromBranch,
  parseLinearLinkUrl,
  type LinearLinkRef,
} from "@t3tools/shared/linearIssue";

export type PhaseSidebarLinearTagKind = "project" | "issue" | "sub-issue";

export interface PhaseSidebarLinearTag {
  readonly kind: PhaseSidebarLinearTagKind;
  readonly url: string;
  /** Issue key (`ENG-42`) or project name. */
  readonly label: string;
  /** The issue's title once Linear has answered; null for projects. */
  readonly title: string | null;
}

/** Statuses keyed by `environmentId:IDENTIFIER`, as the list collects them. */
export type PhaseSidebarLinearStatusMap = ReadonlyMap<string, LinearIssueStatusSummary>;

export const phaseSidebarLinearStatusKey = (environmentId: string, identifier: string) =>
  `${environmentId}:${identifier.toUpperCase()}`;

interface LinearTaggedThread<E extends string = string> {
  readonly environmentId: E;
  readonly branch: string | null;
  readonly linearLinks: ReadonlyArray<ThreadLinearLink>;
}

const KIND_ORDER: Record<PhaseSidebarLinearTagKind, number> = {
  project: 0,
  issue: 1,
  "sub-issue": 2,
};

/**
 * The thread's parsed tags, each canonical URL once, in tag order. A thread
 * with no tags falls back to the issue its `linear/ABC-1` branch names, as the
 * single-tag sidebar did.
 */
function phaseSidebarLinearTagRefs(
  thread: Pick<LinearTaggedThread, "branch" | "linearLinks">,
): ReadonlyArray<LinearLinkRef> {
  const refs: LinearLinkRef[] = [];
  for (const link of thread.linearLinks) {
    const parsed = parseLinearLinkUrl(link.url);
    if (parsed === null || refs.some((ref) => ref.url === parsed.url)) continue;
    refs.push(parsed);
  }
  if (refs.length > 0) return refs;
  const fromBranch = linearIssueFromBranch(thread.branch);
  return fromBranch === null
    ? []
    : [{ kind: "issue", ...fromBranch, label: fromBranch.identifier }];
}

/** The issue keys whose status this thread's tags need. */
export function phaseSidebarLinearIssueIdentifiers(
  thread: Pick<LinearTaggedThread, "branch" | "linearLinks">,
): ReadonlyArray<string> {
  return phaseSidebarLinearTagRefs(thread)
    .filter((ref) => ref.kind === "issue")
    .map((ref) => ref.identifier);
}

/**
 * The thread's tags, project first, then main issues, then sub-issues, each in
 * tag order. `statuses` are this thread's own issue summaries.
 */
export function resolvePhaseSidebarLinearTags(
  thread: Pick<LinearTaggedThread, "branch" | "linearLinks">,
  statuses: ReadonlyArray<LinearIssueStatusSummary>,
): ReadonlyArray<PhaseSidebarLinearTag> {
  const tags = phaseSidebarLinearTagRefs(thread).map((ref): PhaseSidebarLinearTag => {
    if (ref.kind === "project") {
      return { kind: "project", url: ref.url, label: ref.label, title: null };
    }
    const status = statuses.find(
      (candidate) => candidate.identifier.toUpperCase() === ref.identifier,
    );
    return {
      kind: status?.parentIdentifier ? "sub-issue" : "issue",
      url: ref.url,
      label: ref.label,
      title: status?.title ?? null,
    };
  });
  // Array#sort is stable, so tag order survives within a kind. Hermes has no toSorted.
  return [...tags].sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]);
}

/**
 * The issue keys to look up, grouped by environment and sorted, so one batched
 * request per environment covers every issue tag on screen.
 */
export function phaseSidebarLinearStatusRequests<E extends string>(
  threads: ReadonlyArray<LinearTaggedThread<E>>,
): ReadonlyArray<{ readonly environmentId: E; readonly identifiers: ReadonlyArray<string> }> {
  const byEnvironment = new Map<E, Set<string>>();
  for (const thread of threads) {
    const identifiers = phaseSidebarLinearIssueIdentifiers(thread);
    if (identifiers.length === 0) continue;
    const set = byEnvironment.get(thread.environmentId) ?? new Set<string>();
    for (const identifier of identifiers) set.add(identifier);
    byEnvironment.set(thread.environmentId, set);
  }
  return [...byEnvironment.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([environmentId, set]) => ({ environmentId, identifiers: [...set].sort() }));
}

function sameLinearStatus(left: LinearIssueStatusSummary, right: LinearIssueStatusSummary) {
  return (
    left.url === right.url &&
    left.status === right.status &&
    left.statusType === right.statusType &&
    left.error === right.error &&
    (left.title ?? null) === (right.title ?? null) &&
    (left.parentIdentifier ?? null) === (right.parentIdentifier ?? null)
  );
}

/**
 * Fold a status response into the map. Each refetch decodes fresh objects, so
 * an entry equal by value keeps its old object, and a response that changes
 * nothing returns `current` itself: nothing downstream re-renders.
 */
export function mergePhaseSidebarLinearStatuses(
  current: PhaseSidebarLinearStatusMap,
  environmentId: string,
  issues: ReadonlyArray<LinearIssueStatusSummary>,
): PhaseSidebarLinearStatusMap {
  let next: Map<string, LinearIssueStatusSummary> | null = null;
  for (const issue of issues) {
    const key = phaseSidebarLinearStatusKey(environmentId, issue.identifier);
    const previous = current.get(key);
    if (previous !== undefined && sameLinearStatus(previous, issue)) continue;
    next ??= new Map(current);
    next.set(key, issue);
  }
  return next ?? current;
}

const NO_STATUSES: ReadonlyArray<LinearIssueStatusSummary> = [];

/**
 * One row's own summaries. Returns `previous` when it holds the same objects,
 * so a memoised row re-renders only when its own statuses change.
 */
export function pickPhaseSidebarLinearStatuses(
  statuses: PhaseSidebarLinearStatusMap,
  thread: LinearTaggedThread,
  previous: ReadonlyArray<LinearIssueStatusSummary> | undefined,
): ReadonlyArray<LinearIssueStatusSummary> {
  const picked = phaseSidebarLinearIssueIdentifiers(thread).flatMap((identifier) => {
    const status = statuses.get(phaseSidebarLinearStatusKey(thread.environmentId, identifier));
    return status === undefined ? [] : [status];
  });
  if (picked.length === 0) return NO_STATUSES;
  if (
    previous !== undefined &&
    previous.length === picked.length &&
    previous.every((status, index) => status === picked[index])
  ) {
    return previous;
  }
  return picked;
}

/** What the chip reads: the lead tag's label, and "+N" for the rest. */
export function phaseSidebarLinearChipLabel(tags: ReadonlyArray<PhaseSidebarLinearTag>): string {
  const lead = tags.find((tag) => tag.kind !== "project") ?? tags[0];
  if (lead === undefined) return "";
  return tags.length > 1 ? `${lead.label} +${tags.length - 1}` : lead.label;
}

const KIND_TEXT: Record<PhaseSidebarLinearTagKind, string> = {
  project: "Project",
  issue: "Issue",
  "sub-issue": "Sub-issue",
};

/** One line per tag in the "open which tag?" menu, with its kind spelled out. */
export function phaseSidebarLinearTagMenuTitle(tag: PhaseSidebarLinearTag): string {
  const head = `${KIND_TEXT[tag.kind]} · ${tag.label}`;
  return tag.title === null ? head : `${head} · ${tag.title}`;
}

/** The distinct kinds present, in display order, for the chip's icons. */
export function phaseSidebarLinearTagKinds(
  tags: ReadonlyArray<PhaseSidebarLinearTag>,
): ReadonlyArray<PhaseSidebarLinearTagKind> {
  return (["project", "issue", "sub-issue"] as const).filter((kind) =>
    tags.some((tag) => tag.kind === kind),
  );
}
