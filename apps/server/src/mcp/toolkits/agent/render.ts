/**
 * T3-CUSTOM(expbkt3): the Markdown the agent tools return.
 *
 * Each result leads with a one-line answer, then numbered items, then the
 * exact next call. Excerpts are cut to a few hundred characters so a default
 * result stays near 4,000 tokens; the call that reads more is named instead.
 */
import type { ProviderApprovalDecision } from "@t3tools/contracts";

import type { QuestionView } from "./answers.ts";
import type { PendingApproval, PendingPlan, PendingQuestion } from "./pending.ts";
import {
  callHint,
  cutText,
  duration,
  INBOX_KIND_LABEL,
  isUrgent,
  linearKeysOf,
  oneLine,
  pullRequestsOf,
  sessionStateOf,
  shortRef,
  toMillis,
  type InboxKind,
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

export interface SessionContext {
  readonly projectTitle: string | null;
  readonly link: string | null;
  readonly nowMs: number;
}

/** `TEC-1488 · PR #297 (open, checks passing)`, or empty. */
export const tagsOf = (shell: SessionShell): string =>
  [
    ...linearKeysOf(shell),
    ...pullRequestsOf(shell).map(
      (pr) =>
        `PR #${pr.number}${pr.state === null ? "" : ` (${[pr.state, pr.checks === null ? null : `checks ${pr.checks}`].filter((part) => part !== null).join(", ")})`}`,
    ),
  ].join(" · ");

/** The bold header of one session: short id, title, project, tags, link. */
export const sessionHeading = (shell: SessionShell, context: SessionContext): string =>
  [
    `\`${shortRef(shell.id)}\` **${oneLine(shell.title, 90)}**`,
    context.projectTitle === null ? null : `project ${context.projectTitle}`,
    tagsOf(shell) || null,
    isUrgent(shell) ? "URGENT" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

/** What a session is doing, for a list line: state, for how long, and its current step. */
export const sessionActivity = (shell: SessionShell, nowMs: number): string => {
  const state = sessionStateOf(shell, nowMs);
  const started = toMillis(shell.activityRunStartedAt ?? shell.latestRunStartedAt ?? null);
  const updated = toMillis(shell.updatedAt) ?? nowMs;
  switch (state) {
    case "running":
      return started === null ? "running" : `running for ${duration(started, nowMs)}`;
    case "waiting": {
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
  const latest = shell.latestVisibleMessage;
  if (latest !== null && latest.text.trim().length > 0) {
    lines.push(
      `   Latest ${latest.role === "user" ? "message" : "reply"}: ${oneLine(latest.text, 160)}`,
    );
  }
  if (context.link !== null) lines.push(`   Link: ${context.link}`);
  return lines.join("\n");
};

const renderOptions = (question: QuestionView, indent: string): ReadonlyArray<string> => [
  ...question.options.map(
    (option, index) =>
      `${indent}${index + 1}. ${option.label} — ${oneLine(option.description, 140)}`,
  ),
  ...(question.allowCustomAnswer === false ? [] : [`${indent}(or your own answer as text)`]),
];

/** A question request: each question with its numbered options, and the call that answers it. */
export const renderQuestion = (
  pending: PendingQuestion,
  sessionRef: string,
): ReadonlyArray<string> => {
  const several = pending.questions.length > 1;
  const lines: Array<string> = [];
  pending.questions.forEach((question, index) => {
    lines.push(
      `   ${several ? `Q${index + 1}. ` : ""}**${question.header}**: ${oneLine(question.question, 400)}${question.multiSelect === true ? " (pick one or more)" : ""}`,
    );
    lines.push(...renderOptions(question, several ? "      " : "     "));
  });
  const base = { session: sessionRef, requestId: pending.requestId };
  const first = pending.questions[0];
  const example = several
    ? callHint("t3_answer", {
        ...base,
        answers: pending.questions.map((_question, index) => ({ question: index + 1, choice: 1 })),
      })
    : first !== undefined && first.options.length > 0
      ? callHint("t3_answer", { ...base, choice: 1 })
      : callHint("t3_answer", { ...base, text: "…" });
  lines.push(`   → ${example}`);
  return lines;
};

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
  if (approval.prompt !== null) lines.push(`   \`${oneLine(approval.prompt, 400)}\``);
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
    `   → ${callHint("t3_answer", { session: sessionRef, requestId: approval.requestId, decision: "approve" })}`,
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
  readonly plan: PendingPlan | null;
}

export const renderInboxEntry = (index: number, entry: InboxEntry): string => {
  const { shell, context } = entry;
  const ref = shortRef(shell.id);
  const lines = [
    `${index}. **${INBOX_KIND_LABEL[entry.kind]}** · ${sessionHeading(shell, context)} · waiting ${duration(entry.waitingSinceMs, context.nowMs)}`,
  ];
  switch (entry.kind) {
    case "question":
    case "async-question":
      if (entry.question === null) {
        lines.push(`   → read it with ${callHint("t3_session_brief", { session: ref })}`);
      } else {
        lines.push(...renderQuestion(entry.question, ref));
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
      const latest = shell.latestVisibleMessage;
      if (latest !== null) lines.push(`   Last reply: ${oneLine(latest.text, 300)}`);
      lines.push(`   → read more with ${callHint("t3_session_brief", { session: ref })}`);
      break;
    }
  }
  if (context.link !== null) lines.push(`   Link: ${context.link}`);
  return lines.join("\n");
};

/** A message excerpt for a brief, keeping its line breaks. */
export const messageExcerpt = (role: string, text: string, max: number): string =>
  `**${role}:** ${cutText(text.trim(), max)}`;
