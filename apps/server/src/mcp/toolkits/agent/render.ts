/**
 * T3-CUSTOM(expbkt3): the Markdown the agent tools return.
 *
 * Each result leads with a one-line answer, then numbered items, then the
 * exact next call. Excerpts are cut to a few hundred characters so a default
 * result stays near 4,000 tokens; the call that reads more is named instead.
 */
import type { ProviderApprovalDecision } from "@t3tools/contracts";

import type { QuestionView } from "./answers.ts";
import {
  requestRef,
  type PendingApproval,
  type PendingPlan,
  type PendingQuestion,
  type PendingSecret,
} from "./pending.ts";
import {
  attentionOf,
  callHint,
  cutText,
  duration,
  INBOX_KIND_LABEL,
  isAgentActive,
  isUrgent,
  linearKeysOf,
  oneLine,
  pullRequestsOf,
  sessionStateOf,
  shortRef,
  toMillis,
  type InboxKind,
  type SessionPullRequest,
  type SessionShell,
} from "./view.ts";

/** The decision names t3_answer takes, for each provider decision. */
export const DECISION_NAMES: Record<ProviderApprovalDecision, string> = {
  accept: "approve",
  acceptForSession: "approve_for_session",
  acceptAlways: "approve_always",
  decline: "deny",
  cancel: "cancel",
};

/** How much of a session's tags a result shows; compact is the default (TEC-1818). */
export type SessionDetail = "compact" | "full";

export interface SessionContext {
  readonly projectTitle: string | null;
  readonly link: string | null;
  readonly nowMs: number;
  /** compact (the default when omitted) counts tickets and pull requests; full lists each. */
  readonly detail?: SessionDetail | undefined;
}

/** `PR #297 (open, checks passing)`. */
const pullRequestTag = (pr: SessionPullRequest): string =>
  `PR #${pr.number}${pr.state === null ? "" : ` (${[pr.state, pr.checks === null ? null : `checks ${pr.checks}`].filter((part) => part !== null).join(", ")})`}`;

/** `TEC-1488 · PR #297 (open, checks passing)`, or empty. */
export const tagsOf = (shell: SessionShell): string =>
  [...linearKeysOf(shell), ...pullRequestsOf(shell).map(pullRequestTag)].join(" · ");

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The tags as counts: `3 PRs (1 open) · 2 tickets`. A single ticket or pull
 * request is shown as itself, since its name is as short as its count.
 */
export const compactTagsOf = (shell: SessionShell): string => {
  const keys = linearKeysOf(shell);
  const pullRequests = pullRequestsOf(shell);
  const open = pullRequests.filter((pr) => pr.state === "open").length;
  const [onlyKey] = keys;
  const [onlyPullRequest] = pullRequests;
  return [
    keys.length === 1 && onlyKey !== undefined
      ? onlyKey
      : keys.length > 1
        ? plural(keys.length, "ticket", "tickets")
        : null,
    pullRequests.length === 1 && onlyPullRequest !== undefined
      ? pullRequestTag(onlyPullRequest)
      : pullRequests.length > 1
        ? `${plural(pullRequests.length, "PR", "PRs")} (${open} open)`
        : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
};

/** The tags a heading shows at this detail. */
export const headingTagsOf = (shell: SessionShell, detail: SessionDetail | undefined): string =>
  detail === "full" ? tagsOf(shell) : compactTagsOf(shell);

/**
 * A session's tickets and pull requests as data: the lists at detail "full",
 * counts at "compact" (the default; TEC-1818).
 */
export const sessionTagsData = (shell: SessionShell, detail: SessionDetail | undefined) => {
  const linear = linearKeysOf(shell);
  const pullRequests = pullRequestsOf(shell);
  return detail === "full"
    ? { linear, pullRequests }
    : {
        linearCount: linear.length,
        pullRequestCount: pullRequests.length,
        openPullRequestCount: pullRequests.filter((pr) => pr.state === "open").length,
      };
};

/** The bold header of one session: short id, title, project, tags, link. */
export const sessionHeading = (shell: SessionShell, context: SessionContext): string =>
  [
    `\`${shortRef(shell.id)}\` **${oneLine(shell.title, 90)}**`,
    context.projectTitle === null ? null : `project ${context.projectTitle}`,
    headingTagsOf(shell, context.detail) || null,
    isUrgent(shell) ? "URGENT" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

/** What a session is doing, for a list line: state, for how long, and its current step. */
export const sessionActivity = (shell: SessionShell, nowMs: number): string => {
  const state = sessionStateOf(shell, nowMs);
  const started = toMillis(shell.activityRunStartedAt ?? shell.latestRunStartedAt ?? null);
  const updated = toMillis(shell.updatedAt) ?? nowMs;
  const running = started === null ? "running" : `running for ${duration(started, nowMs)}`;
  switch (state) {
    case "running":
      return running;
    case "waiting": {
      // A non-blocking question waits on a person, but the agent did not stop for it.
      if (attentionOf(shell) === "async-question") {
        return `${isAgentActive(shell) ? running : "idle"} · asked a non-blocking question`;
      }
      const since = toMillis(shell.pendingRuntimeRequest?.createdAt ?? null) ?? updated;
      return `waits on a person for ${duration(since, nowMs)}`;
    }
    default:
      return `${state}, last change ${duration(updated, nowMs)} ago`;
  }
};

export const renderSessionLine = (
  index: number,
  shell: SessionShell,
  context: SessionContext,
): string => {
  const lines = [
    `${index}. ${sessionHeading(shell, context)} — ${sessionActivity(shell, context.nowMs)}`,
  ];
  const goal = shell.goal?.objective;
  if (goal !== undefined) lines.push(`   Goal: ${oneLine(goal, 160)}`);
  if (context.link !== null) lines.push(`   Link: ${context.link}`);
  return lines.join("\n");
};

const renderOptions = (question: QuestionView, indent: string): ReadonlyArray<string> => [
  ...question.options.map((option, index) => {
    // Codex sends options without descriptions; T3 copies the label into them.
    const description = option.description.trim();
    return description.length === 0 || description === option.label.trim()
      ? `${indent}${index + 1}. ${option.label}`
      : `${indent}${index + 1}. ${option.label} — ${oneLine(description, 140)}`;
  }),
  ...(question.allowCustomAnswer === false ? [] : [`${indent}(or your own answer as text)`]),
];

/** What answering does, for a blocking and a non-blocking question. */
export const QUESTION_KIND_TEXT = {
  blocking: "Blocking: the agent is paused until you answer.",
  nonBlocking:
    "Non-blocking: the agent asked and did not stop. Your answer reaches it as a new message (into its running turn, or as a new turn). The options are suggestions; text works too. Dismiss it if no answer is needed.",
} as const;

/** A question request: whether it blocks, each question with its numbered options, and the calls that answer it. */
export const renderQuestion = (
  pending: PendingQuestion,
  sessionRef: string,
): ReadonlyArray<string> => {
  const several = pending.questions.length > 1;
  const lines: Array<string> = [
    `   ${pending.async ? QUESTION_KIND_TEXT.nonBlocking : QUESTION_KIND_TEXT.blocking}`,
  ];
  pending.questions.forEach((question, index) => {
    lines.push(
      `   ${several ? `Q${index + 1}. ` : ""}**${question.header}**: ${oneLine(question.question, 400)}${question.multiSelect === true ? " (pick one or more)" : ""}`,
    );
    lines.push(...renderOptions(question, several ? "      " : "     "));
  });
  // The request id, in the short form, keeps a retried answer on this question
  // when the session has others open.
  const base = { session: sessionRef, requestId: requestRef(pending.requestId) };
  const first = pending.questions[0];
  const example = several
    ? callHint("t3_answer", {
        ...base,
        answers: pending.questions.map((_question, index) => ({ question: index + 1, choice: 1 })),
      })
    : first !== undefined && first.options.length > 0
      ? callHint("t3_answer", { ...base, choice: 1 })
      : callHint("t3_answer", { ...base, text: "…" });
  lines.push(
    pending.async
      ? `   → ${example} · or ${callHint("t3_answer", { ...base, dismiss: true })}`
      : `   → ${example}`,
  );
  return lines;
};

/** A secret request: no tool answers it; a person enters it in the app. */
export const renderSecret = (secret: PendingSecret): ReadonlyArray<string> => [
  `   Asks for a secret: **${oneLine(secret.label, 120)}**${secret.reason.trim().length === 0 ? "" : ` — ${oneLine(secret.reason, 300)}`}`,
  "   A person must enter it in the app (open the session's link); no tool can answer it.",
];

export const renderApproval = (
  approval: PendingApproval,
  sessionRef: string,
): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  const what = [approval.title, approval.appName === null ? null : `app ${approval.appName}`]
    .filter((part) => part !== null)
    .join(" · ");
  lines.push(
    `   Asks to approve a ${approval.requestKind}${what.length === 0 ? "" : `: ${oneLine(what, 200)}`}`,
  );
  if (approval.command !== null) lines.push(`   Command: \`${oneLine(approval.command, 600)}\``);
  if (approval.file !== null) lines.push(`   File: \`${approval.file}\``);
  if (approval.prompt !== null) lines.push(`   Why: ${oneLine(approval.prompt, 400)}`);
  lines.push(
    `   Decisions: ${approval.options
      .map((option) => `${DECISION_NAMES[option.decision]} (${option.label})`)
      .join(" · ")}`,
  );
  for (const option of approval.options) {
    if (option.warning !== undefined)
      lines.push(`   Warning on ${DECISION_NAMES[option.decision]}: ${option.warning}`);
  }
  lines.push(
    `   → ${callHint("t3_answer", { session: sessionRef, requestId: requestRef(approval.requestId), decision: "approve" })}`,
  );
  return lines;
};

/** The first heading or line of a plan, as its title. */
export const planTitle = (markdown: string): string =>
  oneLine(
    markdown
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line.length > 0) ?? "Plan",
    120,
  );

export const renderPlan = (
  plan: PendingPlan | null,
  sessionRef: string,
  excerptChars: number,
): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  if (plan !== null) {
    lines.push(`   Plan: **${planTitle(plan.markdown)}**`);
    if (excerptChars > 0) lines.push(`   ${oneLine(plan.markdown, excerptChars)}`);
  }
  lines.push(
    `   → ${callHint("t3_answer", { session: sessionRef, plan: "approve" })} or ${callHint("t3_answer", { session: sessionRef, plan: "revise", feedback: "…" })}`,
  );
  return lines;
};

export interface InboxEntry {
  readonly kind: InboxKind;
  readonly shell: SessionShell;
  readonly context: SessionContext;
  readonly waitingSinceMs: number;
  readonly question: PendingQuestion | null;
  readonly approval: PendingApproval | null;
  readonly secret: PendingSecret | null;
  /** Open non-blocking questions this entry does not show. */
  readonly moreQuestions: number;
  readonly plan: PendingPlan | null;
  /** The agent's newest reply, read for unread results only. */
  readonly lastReply: string | null;
}

export const renderInboxEntry = (index: number, entry: InboxEntry): string => {
  const { shell, context } = entry;
  // Next-call hints name the full id: a short ref can match several sessions (TEC-1818).
  const ref = shell.id;
  const lines = [
    `${index}. **${INBOX_KIND_LABEL[entry.kind]}** · ${sessionHeading(shell, context)} · waiting ${duration(entry.waitingSinceMs, context.nowMs)}`,
  ];
  switch (entry.kind) {
    case "question":
    case "async-question":
      if (entry.question !== null) {
        lines.push(...renderQuestion(entry.question, ref));
      } else if (entry.secret !== null) {
        lines.push(...renderSecret(entry.secret));
      } else {
        lines.push(`   → read it with ${callHint("t3_session_brief", { session: ref })}`);
      }
      break;
    case "approval":
      if (entry.approval !== null) lines.push(...renderApproval(entry.approval, ref));
      break;
    case "plan":
      lines.push(...renderPlan(entry.plan, ref, 600));
      break;
    case "failed":
      lines.push(
        `   Error: ${oneLine(shell.lastError ?? "The run failed without an error message.", 400)}`,
      );
      lines.push(
        `   → retry with ${callHint("t3_send_message", { session: ref, message: "Please retry." })}`,
      );
      break;
    case "unread": {
      if (entry.lastReply !== null) lines.push(`   Last reply: ${oneLine(entry.lastReply, 300)}`);
      lines.push(`   → read more with ${callHint("t3_session_brief", { session: ref })}`);
      break;
    }
  }
  if (entry.moreQuestions > 0) {
    lines.push(
      `   +${entry.moreQuestions} more non-blocking ${entry.moreQuestions === 1 ? "question" : "questions"}: see ${callHint("t3_session_brief", { session: ref })}`,
    );
  }
  if (context.link !== null) lines.push(`   Link: ${context.link}`);
  return lines.join("\n");
};

/** A message excerpt for a brief, keeping its line breaks. */
export const messageExcerpt = (role: string, text: string, max: number): string =>
  `**${role}:** ${cutText(text.trim(), max)}`;
