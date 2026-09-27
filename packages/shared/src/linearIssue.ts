/**
 * T3-CUSTOM(expbkt3): the Linear issue a session answers to.
 *
 * One canonical parser, shared by every writer: the sidebar's tag dialog, the
 * phase sidebar's branch-derived fallback, and the MCP control toolkit. A tag
 * set by an agent has to clear exactly the bar a tag typed by a human clears,
 * because both end up in the same `openExternal` call on the same row.
 */
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
