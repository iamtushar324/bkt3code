/**
 * T3-CUSTOM(expbkt3): the Linear issue a session answers to.
 *
 * One canonical parser, shared by every writer: the sidebar's tag dialog, the
 * phase sidebar's branch-derived fallback, and the MCP control toolkit. A tag
 * set by an agent has to clear exactly the bar a tag typed by a human clears,
 * because both end up in the same `openExternal` call on the same row.
 */
import { THREAD_LINEAR_LINKS_MAX } from "@t3tools/contracts";

export interface LinearIssueRef {
  readonly identifier: string;
  readonly url: string;
}

const LINEAR_BRANCH_PATTERN = /^linear\/([a-z][a-z0-9]*-\d+)(?:-|$)/i;
const LINEAR_ISSUE_URL_PATTERN =
  /^https:\/\/linear\.app\/([^/]+)\/issue\/([a-z][a-z0-9]*-\d+)(?:\/[^?#]*)?(?:[?#].*)?$/i;

/**
 * The issue behind a Linear URL, canonicalised to `https://linear.app/{workspace}/issue/{KEY}`.
 * Null for anything that is not one — a slug, a team board, another host, a
 * scheme with nothing to open. Being strict here is what keeps an arbitrary
 * string out of the row's link.
 */
export function parseLinearIssueUrl(candidate: string | null | undefined): LinearIssueRef | null {
  const trimmed = candidate?.trim();
  if (!trimmed) return null;
  const match = LINEAR_ISSUE_URL_PATTERN.exec(trimmed);
  const workspace = match?.[1];
  const identifier = match?.[2]?.toUpperCase();
  if (!workspace || !identifier) return null;
  return { identifier, url: `https://linear.app/${workspace}/issue/${identifier}` };
}

/** The issue a `linear/ABC-123-slug` branch names, for threads with no manual tag. */
export function linearIssueFromBranch(
  branch: string | null | undefined,
  workspace = "beknown",
): LinearIssueRef | null {
  if (!branch) return null;
  const identifier = LINEAR_BRANCH_PATTERN.exec(branch)?.[1]?.toUpperCase();
  if (!identifier) return null;
  return { identifier, url: `https://linear.app/${workspace}/issue/${identifier}` };
}

/**
 * T3-CUSTOM(expbkt3): a session can carry several Linear tags — the project it
 * belongs to, the main issue, and each sub-issue it touched. Projects are told
 * apart by URL; whether an issue is a sub-issue is Linear's to say (its parent),
 * so the stored kind is only ever `issue` or `project`.
 */
export type LinearLinkKind = "issue" | "project";

export interface LinearLinkRef {
  readonly kind: LinearLinkKind;
  /** Canonical URL, the identity of the tag. */
  readonly url: string;
  /** Issue key (`ENG-42`) or project slug id. */
  readonly identifier: string;
  /** Short display text: the issue key, or the project name read from its slug. */
  readonly label: string;
}

const LINEAR_PROJECT_URL_PATTERN =
  /^https:\/\/linear\.app\/([^/]+)\/project\/([a-z0-9][a-z0-9-]*)(?:\/[^?#]*)?(?:[?#].*)?$/i;

/** A Linear project URL, canonicalised to `https://linear.app/{workspace}/project/{slug}`. */
export function parseLinearProjectUrl(candidate: string | null | undefined): LinearLinkRef | null {
  const trimmed = candidate?.trim();
  if (!trimmed) return null;
  const match = LINEAR_PROJECT_URL_PATTERN.exec(trimmed);
  const workspace = match?.[1];
  const slug = match?.[2]?.toLowerCase();
  if (!workspace || !slug) return null;
  // Linear slugs end in a hex id; the words before it are the project's name.
  const name = slug
    .replace(/-?[0-9a-f]{8,}$/, "")
    .replace(/-+/g, " ")
    .trim();
  return {
    kind: "project",
    url: `https://linear.app/${workspace}/project/${slug}`,
    identifier: slug,
    label: name.length > 0 ? name : slug,
  };
}

/** An issue or project URL as a tag; null for anything else. */
export function parseLinearLinkUrl(candidate: string | null | undefined): LinearLinkRef | null {
  const issue = parseLinearIssueUrl(candidate);
  if (issue)
    return {
      kind: "issue",
      url: issue.url,
      identifier: issue.identifier,
      label: issue.identifier,
    };
  return parseLinearProjectUrl(candidate);
}

export interface StoredLinearLink {
  readonly url: string;
  readonly kind: LinearLinkKind;
}

/**
 * A thread's Linear tags. Threads tagged before multi-tagging carry only
 * `linearIssueUrl`; that single tag reads as a one-item list until the first
 * change writes `linearLinks`.
 */
export function threadLinearLinks(thread: {
  readonly linearLinks?: ReadonlyArray<StoredLinearLink> | null | undefined;
  readonly linearIssueUrl?: string | null | undefined;
}): ReadonlyArray<StoredLinearLink> {
  if (thread.linearLinks) return thread.linearLinks;
  const legacy = parseLinearIssueUrl(thread.linearIssueUrl);
  return legacy ? [{ url: legacy.url, kind: "issue" }] : [];
}

/**
 * Apply tag changes in decider order: `linearIssueUrl` (the single-tag field)
 * clears everything on null; a URL moves that issue to the front, adding it if
 * missing, so the mirror follows it and an older client's "change tag" still
 * shows. Then removals, then additions. Adding a tag that is already there
 * keeps its place, and additions past THREAD_LINEAR_LINKS_MAX are ignored.
 * Returns the new list and the `linearIssueUrl` mirror (first issue tag) that
 * older readers still use.
 */
export function applyLinearLinkChanges(
  current: ReadonlyArray<StoredLinearLink>,
  changes: {
    readonly linearIssueUrl?: string | null | undefined;
    readonly linearLinksAdd?: ReadonlyArray<StoredLinearLink> | undefined;
    readonly linearLinksRemove?: ReadonlyArray<string> | undefined;
  },
): {
  readonly linearLinks: ReadonlyArray<StoredLinearLink>;
  readonly linearIssueUrl: string | null;
} {
  let links: ReadonlyArray<StoredLinearLink> = current;
  if (changes.linearIssueUrl === null) links = [];
  else if (changes.linearIssueUrl !== undefined) {
    const issue = parseLinearIssueUrl(changes.linearIssueUrl);
    // The single-tag field is a replace in older clients' eyes, so it is never
    // refused for a full list: the oldest tag gives way instead.
    if (issue)
      links = [
        { url: issue.url, kind: "issue" as const },
        ...links.filter((entry) => entry.url !== issue.url),
      ].slice(0, THREAD_LINEAR_LINKS_MAX);
  }
  if (changes.linearLinksRemove && changes.linearLinksRemove.length > 0) {
    const removed = new Set(
      changes.linearLinksRemove.map((url) => parseLinearLinkUrl(url)?.url ?? url),
    );
    links = links.filter((entry) => !removed.has(entry.url));
  }
  for (const link of changes.linearLinksAdd ?? []) {
    const parsed = parseLinearLinkUrl(link.url);
    if (
      parsed &&
      links.length < THREAD_LINEAR_LINKS_MAX &&
      !links.some((entry) => entry.url === parsed.url)
    )
      links = [...links, { url: parsed.url, kind: parsed.kind }];
  }
  return {
    linearLinks: links,
    linearIssueUrl: links.find((entry) => entry.kind === "issue")?.url ?? null,
  };
}
