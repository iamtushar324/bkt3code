/**
 * T3-CUSTOM(expbkt3): Render an archived session as a digest another agent can read.
 *
 * The audience is a future Claude/Codex session that has been pointed at the
 * history directory and needs to answer "what happened here, and where did it
 * land?" without loading a whole transcript. So this leads with facts that are
 * expensive to reconstruct — branch, HEAD, what changed, whether it shipped —
 * and only then narrates. Every user prompt is included verbatim, because the
 * prompts are the cheapest complete record of intent; assistant output is left
 * to the `.jsonl` sidecar.
 *
 * Pure: takes plain data, returns a string.
 */

export interface HistoryTurnSummary {
  readonly summary: string | null;
  readonly createdAt: string;
}

export interface HistoryUserPrompt {
  readonly text: string;
  readonly createdAt: string;
}

// T3-CUSTOM(expbkt3): the git/fence helpers and their types moved to shared so the
// client can render an offline handoff digest with them; re-exported here because
// this module is the server's established import site for them.
import {
  fencedBlock,
  renderGitSection,
  type HistoryFileChange,
  type HistoryGitState,
} from "@t3tools/shared/sessionDigest";

export { fencedBlock, renderGitSection };
export type { HistoryFileChange, HistoryGitState };

export interface SessionHistoryDigestInput {
  readonly threadId: string;
  readonly title: string;
  readonly projectName: string;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly providerInstanceId: string | null;
  readonly model: string | null;
  readonly createdAt: string | null;
  readonly archivedAt: string | null;
  readonly rollingSummary: string | null;
  readonly turnSummaries: ReadonlyArray<HistoryTurnSummary>;
  readonly userPrompts: ReadonlyArray<HistoryUserPrompt>;
  readonly git: HistoryGitState | null;
  readonly messageCount: number;
  /** Basename of the sidecar, or null when sidecars are disabled. */
  readonly transcriptFileName: string | null;
  /** What the reclaim did, so the file explains its own existence. */
  readonly reclaimNote: string | null;
}

const EM_DASH_FALLBACK = "—";

function orDash(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : EM_DASH_FALLBACK;
}

/**
 * Build the digest.
 *
 * Section order is deliberate: metadata, then the summary, then git, then
 * prompts. An agent that reads only the first screen should already know what
 * the session was and whether its work landed.
 */
export function renderSessionHistoryDigest(input: SessionHistoryDigestInput): string {
  const lines: Array<string> = [];

  lines.push(`# ${input.title.trim() || "Untitled session"}`, "");

  if (input.reclaimNote !== null) {
    lines.push(`> ${input.reclaimNote}`, "");
  }

  lines.push(
    "## Session",
    "",
    `- **Project:** ${orDash(input.projectName)}`,
    `- **Workspace:** ${orDash(input.workspaceRoot)}`,
    `- **Worktree:** ${orDash(input.worktreePath)}`,
    `- **Thread id:** \`${input.threadId}\``,
    `- **Provider:** ${orDash(input.providerInstanceId)}${input.model ? ` (${input.model})` : ""}`,
    `- **Created:** ${orDash(input.createdAt)}`,
    `- **Archived:** ${orDash(input.archivedAt)}`,
    `- **Messages:** ${input.messageCount}`,
    "",
  );

  if (input.transcriptFileName !== null) {
    lines.push(
      `Full transcript: \`${input.transcriptFileName}\` — one JSON object per line.`,
      "Grep it rather than reading it whole.",
      "",
    );
  }

  const rolling = input.rollingSummary?.trim();
  if (rolling) {
    lines.push("## Summary", "", rolling, "");
  }

  lines.push(...renderGitSection(input.git));

  const readySummaries = input.turnSummaries.filter(
    (entry): entry is HistoryTurnSummary & { summary: string } => Boolean(entry.summary?.trim()),
  );
  if (readySummaries.length > 0) {
    lines.push("## Turn by turn", "");
    for (const entry of readySummaries) {
      lines.push(`- **${entry.createdAt}** — ${entry.summary.trim()}`);
    }
    lines.push("");
  }

  if (input.userPrompts.length > 0) {
    lines.push(`## Prompts (${input.userPrompts.length})`, "");
    for (const [index, prompt] of input.userPrompts.entries()) {
      lines.push(`### ${index + 1}. ${prompt.createdAt}`, "", fencedBlock(prompt.text), "");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export interface SessionHistoryIndexEntry {
  readonly fileName: string;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly branch: string | null;
  readonly oneLineSummary: string | null;
}

/** First sentence, or first line, capped — enough to recognize a session by. */
export function toOneLineSummary(summary: string | null, maxLength = 160): string | null {
  const collapsed = summary?.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return null;
  }
  const firstSentence = /^(.+?[.!?])(\s|$)/.exec(collapsed)?.[1] ?? collapsed;
  return firstSentence.length <= maxLength
    ? firstSentence
    : `${firstSentence.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Render the per-project index.
 *
 * Rewritten whole from the caller's merged entry list rather than appended to:
 * re-exporting a session has to update its row in place, and a table that
 * accumulated duplicates would stop being a usable entry point.
 */
export function renderSessionHistoryIndex(
  projectName: string,
  entries: ReadonlyArray<SessionHistoryIndexEntry>,
): string {
  const sorted = [...entries].sort((left, right) => {
    const leftKey = left.archivedAt ?? "";
    const rightKey = right.archivedAt ?? "";
    return rightKey.localeCompare(leftKey) || left.fileName.localeCompare(right.fileName);
  });

  const lines = [
    `# Session history — ${projectName}`,
    "",
    "Archived T3 Code sessions for this project, newest first. Each row links to a",
    "digest; a matching `.jsonl` beside it holds the full transcript.",
    "",
    "| Archived | Session | Branch | Summary |",
    "| --- | --- | --- | --- |",
  ];

  for (const entry of sorted) {
    const cells = [
      entry.archivedAt?.slice(0, 10) ?? EM_DASH_FALLBACK,
      `[${escapeCell(entry.title)}](${encodeURI(entry.fileName)})`,
      entry.branch ? `\`${escapeCell(entry.branch)}\`` : EM_DASH_FALLBACK,
      entry.oneLineSummary ? escapeCell(entry.oneLineSummary) : EM_DASH_FALLBACK,
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }

  lines.push("");
  return lines.join("\n");
}

/** Pipes and newlines would break the row; nothing else needs escaping here. */
function escapeCell(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

/**
 * Orientation file at the history root.
 *
 * Written once so an agent that is pointed here by a global instruction file,
 * with no other context, can work out the layout from the directory itself.
 */
export function renderSessionHistoryReadme(): string {
  return `# T3 Code session history

Durable records of archived T3 Code sessions. Each session's worktree may have
been reclaimed to free disk; these files are what remains, and they are meant to
be read as context by a later agent session.

## Layout

    <project>/INDEX.md                                    entry point — every session, newest first
    <project>/YYYY-MM-DD-<title>-<id>.md                  digest for one session
    <project>/YYYY-MM-DD-<title>-<id>.jsonl               conversation transcript (user + assistant text)
    <project>/YYYY-MM-DD-<title>-<id>.activities.jsonl    tool calls and commands, one per line
    <project>/YYYY-MM-DD-<title>-<id>.manifest.json       metadata: who did what, provider, git, file inventory
    <project>/YYYY-MM-DD-<title>-<id>-raw/                gzipped provider transcripts (read with zgrep/zcat)

## How to use this

1. Start at the \`INDEX.md\` of the project you care about. One row per session,
   with a one-line summary and the branch it worked on.
2. Read the \`.md\` digest for the session that looks relevant. It carries the
   metadata, summary, git state, changed files, and every user prompt verbatim.
3. Only open the \`.jsonl\` if the digest is not enough. It is one JSON object per
   line and can be large — grep it for the term you need rather than reading it
   whole. The \`.activities.jsonl\` beside it lists every tool call.
4. The \`-raw/\` directory holds the provider CLI's own transcript files,
   gzipped. They are the most complete record (tool outputs included); search
   them with \`zgrep <term> <file>.gz\` rather than decompressing.
5. \`.manifest.json\` is the machine-readable summary — owner, per-sender
   message counts, provider session ids, and byte sizes of every file here.

## What is not here

Reclaimed worktrees are gone; the branch named in the digest is the place to
look for the code itself. Sessions exported before raw-transcript capture
existed have only the digest and \`.jsonl\`.
`;
}
