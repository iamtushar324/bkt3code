/**
 * T3-CUSTOM(expbkt3): Where an archived session's history is written.
 *
 * The layout is part of the contract with agents, not an implementation
 * detail: the global CLI instruction files point at this directory, so a Claude
 * or Codex session finds past work by reading `INDEX.md` and then a dated file.
 * Names therefore have to be greppable by hand — date first so a directory
 * listing sorts chronologically, title in the middle so `ls | grep auth` works,
 * thread id last so two sessions on the same day never collide.
 *
 * Pure: joins with forward slashes and lets the caller resolve against a root.
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/** Directory under the server base dir when no override is configured. */
export const DEFAULT_SESSION_HISTORY_DIRNAME = "session-history";

/** Per-project entry point an agent reads first. */
export const SESSION_HISTORY_INDEX_FILENAME = "INDEX.md";

/** Orientation file at the history root, for an agent that lands there cold. */
export const SESSION_HISTORY_README_FILENAME = "README.md";

const MAX_SLUG_LENGTH = 60;

/**
 * Lowercase, hyphen-separated, filesystem-safe.
 *
 * Truncation happens at a hyphen where possible so a slug does not end
 * mid-word, which matters because these names are read by people.
 */
export function slugify(value: string, maxLength: number = MAX_SLUG_LENGTH): string {
  const base = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length === 0) {
    return "untitled";
  }
  if (base.length <= maxLength) {
    return base;
  }
  const clipped = base.slice(0, maxLength);
  const lastHyphen = clipped.lastIndexOf("-");
  return (lastHyphen > maxLength / 2 ? clipped.slice(0, lastHyphen) : clipped).replace(/-+$/, "");
}

/**
 * `YYYY-MM-DD`, in UTC, from an ISO timestamp.
 *
 * Goes through `DateTime` rather than a bare `Date` both because the repo bans
 * global `Date` construction and because a timestamp carrying an offset has to
 * be normalized before slicing — otherwise a session archived at 23:00-05:00
 * files itself under the wrong day.
 *
 * Falls back to `undated` rather than throwing: a session with a corrupt
 * timestamp still deserves its history written somewhere findable.
 */
export function archiveDateSegment(isoTimestamp: string | null): string {
  if (isoTimestamp === null) {
    return "undated";
  }
  return Option.match(DateTime.make(isoTimestamp), {
    onNone: () => "undated",
    onSome: (value) => DateTime.formatIso(value).slice(0, 10),
  });
}

export interface SessionHistoryPathsInput {
  readonly historyDir: string;
  readonly projectName: string;
  readonly threadId: string;
  readonly title: string;
  /** Preferred stamp; falls back to `createdAt` at the call site. */
  readonly archivedAt: string | null;
}

export interface SessionHistoryPaths {
  readonly projectDir: string;
  readonly digestPath: string;
  readonly transcriptPath: string;
  /** Tool-call activity sidecar. */
  readonly activitiesPath: string;
  /** Machine-readable metadata record. */
  readonly manifestPath: string;
  /** Directory holding gzipped copies of the provider's own transcripts. */
  readonly rawDir: string;
  readonly indexPath: string;
  readonly baseName: string;
}

/**
 * Build every path for one session's export.
 *
 * The thread id is truncated to its first 8 characters: full ids make the
 * names unreadable, and 8 hex characters inside one project-day are not going
 * to collide in a workspace this size.
 */
export function sessionHistoryPaths(input: SessionHistoryPathsInput): SessionHistoryPaths {
  const projectDir = `${input.historyDir}/${slugify(input.projectName)}`;
  const date = archiveDateSegment(input.archivedAt);
  const baseName = `${date}-${slugify(input.title)}-${input.threadId.slice(0, 8)}`;
  return {
    projectDir,
    baseName,
    digestPath: `${projectDir}/${baseName}.md`,
    transcriptPath: `${projectDir}/${baseName}.jsonl`,
    activitiesPath: `${projectDir}/${baseName}.activities.jsonl`,
    manifestPath: `${projectDir}/${baseName}.manifest.json`,
    rawDir: `${projectDir}/${baseName}-raw`,
    indexPath: `${projectDir}/${SESSION_HISTORY_INDEX_FILENAME}`,
  };
}
