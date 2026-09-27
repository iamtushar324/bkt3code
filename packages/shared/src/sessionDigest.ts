/**
 * T3-CUSTOM(expbkt3): Render a thread as a handoff digest another session can continue from.
 *
 * The audience is a brand-new agent session — possibly on a different provider —
 * that receives this digest as its very first prompt and has to pick the work
 * up mid-flight. So unlike the archive digest, which points at a transcript
 * sidecar, this one carries the conversation itself: every message inline,
 * role-labelled, newest kept when the size cap forces elision. The preamble
 * tells the receiving agent what it is looking at and to trust the worktree
 * over the digest wherever they disagree.
 *
 * This lives in shared rather than the server because a handoff has to work
 * when the host that owns the thread is unreachable. The client then renders
 * the same digest from its local cache, and rendering it *identically* is the
 * point: a handoff that silently changed shape depending on who built it would
 * be impossible to reason about. Everything here is pure — plain data in, a
 * string plus a truncation flag out — so both callers share one renderer.
 *
 * @module sessionDigest
 */

export interface HistoryFileChange {
  readonly path: string;
  /** e.g. "M", "A", "D" — whatever the diff source reports. */
  readonly status: string;
}

export interface HistoryGitState {
  readonly branch: string | null;
  readonly baseRef: string | null;
  readonly headSha: string | null;
  readonly hasUncommittedChanges: boolean;
  readonly hasUntrackedFiles: boolean;
  readonly hasUnpushedCommits: boolean;
  readonly changedFiles: ReadonlyArray<HistoryFileChange>;
}

const EM_DASH = "\u2014";

function orDash(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : EM_DASH;
}

/**
 * Fence a prompt without letting its own backticks break out.
 *
 * Prompts routinely contain fenced code, so a fixed three-backtick fence would
 * terminate early and corrupt every following section of the digest.
 */
export function fencedBlock(text: string): string {
  const longestRun = [...text.matchAll(/`+/g)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text.trimEnd()}\n${fence}`;
}

export function renderGitSection(git: HistoryGitState | null): ReadonlyArray<string> {
  if (git === null) {
    return ["## Git state", "", "No git information was captured for this session.", ""];
  }

  const flags: Array<string> = [];
  if (git.hasUncommittedChanges) flags.push("uncommitted changes");
  if (git.hasUntrackedFiles) flags.push("untracked files");
  if (git.hasUnpushedCommits) flags.push("unpushed commits");

  const lines = [
    "## Git state",
    "",
    `- **Branch:** ${orDash(git.branch)}`,
    `- **Base ref:** ${orDash(git.baseRef)}`,
    `- **HEAD:** ${orDash(git.headSha)}`,
    `- **At archive time:** ${flags.length > 0 ? flags.join(", ") : "clean and pushed"}`,
    "",
  ];

  if (git.changedFiles.length > 0) {
    lines.push(`### Files changed (${git.changedFiles.length})`, "");
    for (const file of git.changedFiles) {
      lines.push(`- \`${file.status}\` ${file.path}`);
    }
    lines.push("");
  }

  return lines;
}

export interface ContextTranscriptMessage {
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
}

export interface ThreadContextDigestInput {
  readonly threadId: string;
  readonly title: string;
  readonly projectName: string;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly providerInstanceId: string | null;
  readonly model: string | null;
  readonly createdAt: string | null;
  readonly git: HistoryGitState | null;
  readonly messages: ReadonlyArray<ContextTranscriptMessage>;
  /**
   * Where this digest came from, when that changes how much to trust it.
   *
   * A digest built on the host is authoritative. One built from a client's
   * cache while the host is unreachable can be missing the newest messages and
   * carries no git state, and the receiving agent has to know that before it
   * acts on what it reads.
   */
  readonly provenanceNote?: string | null;
  /**
   * True when history older than `messages` exists but was not available to the
   * renderer — a windowed client cache rather than the full thread.
   */
  readonly historyIncomplete?: boolean;
}

export interface ThreadContextDigest {
  readonly markdown: string;
  /** True when the transcript was elided to fit the cap. */
  readonly truncated: boolean;
}

/**
 * Total character budget for the transcript section.
 *
 * The digest's primary destination is a composer textarea and a first prompt,
 * so it has to stay well under provider prompt limits while keeping enough of
 * the tail for the receiving agent to continue mid-thought.
 */
const TRANSCRIPT_CHAR_BUDGET = 48_000;

/**
 * Cap for a single message so one pasted log dump cannot consume the whole
 * budget. Middle-elided: the head states intent, the tail states outcome.
 */
const MESSAGE_CHAR_CAP = 12_000;

function clampMessageText(text: string): string {
  if (text.length <= MESSAGE_CHAR_CAP) {
    return text;
  }
  const half = Math.floor(MESSAGE_CHAR_CAP / 2);
  const omitted = text.length - MESSAGE_CHAR_CAP;
  return `${text.slice(0, half)}\n\n[… ${omitted} characters elided from the middle of this message …]\n\n${text.slice(text.length - half)}`;
}

function roleLabel(role: string): string {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    default:
      return role.charAt(0).toUpperCase() + role.slice(1);
  }
}

/**
 * Pick the messages that fit the budget.
 *
 * Selection walks backwards from the newest message because the tail is what
 * the next session continues from. The first user message is pinned even when
 * the walk cannot reach it: it is the cheapest complete record of the original
 * goal, and a digest that loses the goal invites confident drift.
 */
export function selectTranscriptMessages(messages: ReadonlyArray<ContextTranscriptMessage>): {
  readonly kept: ReadonlyArray<ContextTranscriptMessage & { readonly clampedText: string }>;
  readonly omittedCount: number;
  readonly pinnedFirstPrompt: boolean;
} {
  const clamped = messages
    .filter((message) => message.text.trim().length > 0)
    .map((message) => ({ ...message, clampedText: clampMessageText(message.text) }));

  let budget = TRANSCRIPT_CHAR_BUDGET;
  const keptFromTail: Array<(typeof clamped)[number]> = [];
  for (let index = clamped.length - 1; index >= 0; index -= 1) {
    const entry = clamped[index]!;
    if (entry.clampedText.length > budget && keptFromTail.length > 0) {
      break;
    }
    keptFromTail.unshift(entry);
    budget -= entry.clampedText.length;
    if (budget <= 0) {
      break;
    }
  }

  const firstPrompt = clamped.find((message) => message.role === "user") ?? null;
  const tailStart = clamped.length - keptFromTail.length;
  const pinnedFirstPrompt =
    firstPrompt !== null && clamped.indexOf(firstPrompt) < tailStart ? true : false;

  const kept =
    pinnedFirstPrompt && firstPrompt !== null ? [firstPrompt, ...keptFromTail] : keptFromTail;
  return {
    kept,
    omittedCount: clamped.length - kept.length,
    pinnedFirstPrompt,
  };
}

export function renderThreadContextDigest(input: ThreadContextDigestInput): ThreadContextDigest {
  const { kept, omittedCount, pinnedFirstPrompt } = selectTranscriptMessages(input.messages);
  const truncated = omittedCount > 0;

  const lines: Array<string> = [
    "# Session handoff — continue this work",
    "",
    "You are taking over an in-progress T3 Code session. Everything below was",
    "extracted mechanically from that session's record. Read it, then continue",
    "the work. Where this digest and the actual repository state disagree, trust",
    "the repository: verify the git state before acting on it.",
    "",
  ];

  const provenance = input.provenanceNote?.trim();
  if (provenance) {
    lines.push(`> ${provenance}`, "");
  }

  lines.push(
    "## Session",
    "",
    `- **Title:** ${input.title.trim() || "Untitled session"}`,
    `- **Project:** ${orDash(input.projectName)}`,
    `- **Workspace:** ${orDash(input.workspaceRoot)}`,
    `- **Worktree:** ${orDash(input.worktreePath)}`,
    `- **Branch:** ${orDash(input.branch)}`,
    `- **Source thread id:** \`${input.threadId}\``,
    `- **Provider:** ${orDash(input.providerInstanceId)}${input.model ? ` (${input.model})` : ""}`,
    `- **Created:** ${orDash(input.createdAt)}`,
    `- **Messages:** ${input.messages.length}`,
    "",
  );

  lines.push(...renderGitSection(input.git));

  lines.push(`## Transcript (${kept.length} of ${input.messages.length} messages)`, "");
  if (input.historyIncomplete === true) {
    lines.push(
      "> Older messages of this session were not available to this digest. Treat the",
      "> transcript below as the most recent part of a longer conversation.",
      "",
    );
  }
  if (kept.length === 0) {
    lines.push("This session had no messages yet.", "");
  }
  for (const [index, message] of kept.entries()) {
    lines.push(
      `### ${roleLabel(message.role)} — ${message.createdAt}`,
      "",
      fencedBlock(message.clampedText),
      "",
    );
    if (pinnedFirstPrompt && index === 0 && omittedCount > 0) {
      lines.push(
        `> … ${omittedCount} intermediate message${omittedCount === 1 ? "" : "s"} omitted to fit the size cap; the transcript resumes near the end of the session …`,
        "",
      );
    }
  }
  if (!pinnedFirstPrompt && omittedCount > 0) {
    lines.splice(
      lines.findIndex((line) => line.startsWith("## Transcript")) + 2,
      0,
      `> … ${omittedCount} earlier message${omittedCount === 1 ? "" : "s"} omitted to fit the size cap …`,
      "",
    );
  }

  return { markdown: `${lines.join("\n").trimEnd()}\n`, truncated };
}
