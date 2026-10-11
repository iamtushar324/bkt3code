/**
 * T3-CUSTOM(expbkt3): the agent toolkit's handlers (see tools.ts).
 *
 * Every handler reads through the V2 services: one shell snapshot at most,
 * then filtered records for the few sessions it shows; none loads a whole
 * session history. Writes go through the same commands the app sends, record
 * the person the caller acts for, and accept a clientRequestId so a retry
 * does not act twice.
 */
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationUser,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { Tool } from "effect/ai";

import { ClerkDirectory } from "../../../auth/ClerkDirectory.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import type { OrchestratorV2Error } from "../../../orchestration-v2/Orchestrator.ts";
import { PlanReviewService } from "../../../planreview/PlanReviewService.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertTargetWithinLimits, dispatchFailure, type Caller } from "../../threadAccess.ts";
import { createSession } from "../control/handlers.ts";
import { buildAnswers } from "./answers.ts";
import {
  fail,
  loadAgentCaller,
  loadProjects,
  loadVisibleSessions,
  resolveProject,
  resolveSession,
  usableProjects,
  type ProjectSummary,
  type VisibleSessions,
} from "./context.ts";
import { modelSelectionFor, resolveModel } from "./models.ts";
import { EMPTY_PENDING, loadPendingDetail, planIsCurrent, type PendingDetail } from "./pending.ts";
import {
  DECISION_NAMES,
  messageExcerpt,
  planTitle,
  renderApproval,
  renderInboxEntry,
  renderPlan,
  renderQuestion,
  renderSessionLine,
  sessionActivity,
  sessionHeading,
  tagsOf,
  type InboxEntry,
  type SessionContext,
} from "./render.ts";
import {
  AgentToolkit,
  type AnswerTool,
  type FindSessionsTool,
  type InboxTool,
  type SendMessageTool,
  type SessionBriefTool,
  type StartSessionTool,
  type WaitTool,
  type WhoamiTool,
} from "./tools.ts";
import {
  attentionOf,
  callHint,
  cutText,
  inboxCandidates,
  INBOX_KIND_LABEL,
  isoFromMillis,
  isSubagent,
  linearKeysOf,
  matchSessionRef,
  oneLine,
  pullRequestsOf,
  sessionLink,
  sessionStateOf,
  shortRef,
  toIso,
  type InboxKind,
  type SessionShell,
  type SessionState,
} from "./view.ts";
import { WAIT_CHANGES, waitForChange, type WaitChange } from "./wait.ts";

const result = (markdown: string, data: unknown) => ({ markdown, data });

/** 64-bit FNV-1a of `text`, seeded, as 16 hex digits. */
const fnv64 = (text: string, seed: bigint) => {
  let hash = 0xcbf29ce484222325n ^ seed;
  for (const unit of new TextEncoder().encode(text)) {
    hash ^= BigInt(unit);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  // FNV-1a mixes the last characters weakly into the high bits; finish with
  // MurmurHash3's fmix64 so ids of similar texts differ from the first digit.
  hash ^= hash >> 33n;
  hash = (hash * 0xff51afd7ed558ccdn) & 0xffffffffffffffffn;
  hash ^= hash >> 33n;
  hash = (hash * 0xc4ceb9fe1a85ec53n) & 0xffffffffffffffffn;
  hash ^= hash >> 33n;
  return hash.toString(16).padStart(16, "0");
};

/**
 * A UUID-shaped id that is the same for the same text, so a session started
 * with a clientRequestId is found again on retry and still has a short id.
 */
const stableUuid = (text: string) => {
  const hex = `${fnv64(text, 0n)}${fnv64(text, 0x9e3779b97f4a7c15n)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const DEFAULT_WAIT_SECONDS = 50;

/**
 * The origin session links use: the one the request reached, else the
 * server's configured public MCP URL. An agent inside a session reaches the
 * server on loopback, which is no link for a person.
 */
const linkOrigin = Effect.fn("agentToolkit.linkOrigin")(function* (
  scope: McpInvocationContext.McpInvocationScope,
) {
  if (scope.requestOrigin !== undefined) return scope.requestOrigin;
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  if (Option.isNone(settings)) return undefined;
  const publicUrl = yield* settings.value.getSettings.pipe(
    Effect.map((current) => current.experimental.externalMcp.publicUrl),
    Effect.orElseSucceed(() => ""),
  );
  if (publicUrl.length === 0) return undefined;
  try {
    return new URL(publicUrl).origin;
  } catch {
    return undefined;
  }
});

/** The web link and project title a session renders with. */
const contextFor =
  (
    caller: Caller,
    projects: ReadonlyMap<string, ProjectSummary>,
    nowMs: number,
    origin: string | undefined,
  ) =>
  (shell: SessionShell): SessionContext => ({
    projectTitle: projects.get(shell.projectId)?.title ?? null,
    link: sessionLink(origin, caller.scope.environmentId, shell.id),
    nowMs,
  });

/** The facts of one session, for `format: "json"`. */
const sessionData = (shell: SessionShell, context: SessionContext) => ({
  sessionId: shell.id,
  ref: shortRef(shell.id),
  title: shell.title,
  state: sessionStateOf(shell, context.nowMs),
  waitsOn: attentionOf(shell),
  project: context.projectTitle,
  projectId: shell.projectId,
  branch: shell.branch,
  model: shell.modelSelection.model,
  mode: shell.interactionMode === "plan" ? "plan" : "build",
  linear: linearKeysOf(shell),
  pullRequests: pullRequestsOf(shell),
  updatedAt: toIso(shell.updatedAt),
  link: context.link,
});

const loadPeople = Effect.fn("agentToolkit.loadPeople")(function* () {
  const directory = yield* ClerkDirectory;
  const members = yield* directory
    .listOrgMembers()
    .pipe(Effect.orElseSucceed((): ReadonlyArray<OrchestrationUser> => []));
  return new Map(members.map((member): [string, OrchestrationUser] => [member.id, member]));
});

const personName = (people: ReadonlyMap<string, OrchestrationUser>, userId: string | null) => {
  if (userId === null) return null;
  const person = people.get(userId);
  return person?.name ?? person?.email ?? userId;
};

/** How the caller reached T3, in a few words. */
const callerKind = (scope: McpInvocationContext.McpInvocationScope) =>
  scope.thread !== undefined
    ? "an agent inside a T3 session"
    : scope.principal === "external-operator"
      ? `operator client "${scope.client?.label ?? "operator"}"`
      : `MCP client "${scope.client?.label ?? "external"}"`;

/** A command id for a write: stable for a clientRequestId, so a retry does nothing new. */
const commandIdFor = Effect.fn("agentToolkit.commandIdFor")(function* (
  scope: McpInvocationContext.McpInvocationScope,
  operation: string,
  clientRequestId: string | undefined,
) {
  if (clientRequestId !== undefined && clientRequestId.trim().length > 0) {
    return CommandId.make(
      `mcp:agent:${operation}:${encodeURIComponent(scope.requestNamespace)}:${encodeURIComponent(clientRequestId.trim())}`,
    );
  }
  const crypto = yield* Crypto.Crypto;
  return CommandId.make(`mcp:agent:${operation}:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
});

const STALE_REQUEST =
  /is (resolved|expired|cancelled)|was not found|already been answered|no longer pending|already (approved|changes-requested|discarded)/i;

const dispatchError = (error: OrchestratorV2Error) => {
  const { message } = dispatchFailure(error);
  return STALE_REQUEST.test(message)
    ? fail("request_stale", `${message} Read what waits now with t3_inbox.`)
    : fail("dispatch_failed", message);
};

/** The person the caller acts for, as the plan review and audit trail label them. */
const actorLabel = (
  scope: McpInvocationContext.McpInvocationScope,
  people: ReadonlyMap<string, OrchestrationUser>,
) => {
  const name = personName(people, scope.actorUserId);
  const via = scope.thread !== undefined ? "an agent" : (scope.client?.label ?? "an MCP client");
  return name === null ? `via ${via}` : `${name} (via ${via})`;
};

// -- t3_whoami ---------------------------------------------------------------

const whoami = Effect.fn("agentToolkit.whoami")(function* (
  _input: Tool.Parameters<typeof WhoamiTool>,
) {
  const caller = yield* loadAgentCaller("t3.read");
  const { scope } = caller;
  const nowMs = yield* Clock.currentTimeMillis;
  const origin = yield* linkOrigin(caller.scope);
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  const people = yield* loadPeople();
  const projects = yield* loadProjects();
  const sessions = yield* loadVisibleSessions(caller, { archived: false });
  const context = contextFor(caller, projects, nowMs, origin);
  const inbox = inboxCandidates(sessions.active, nowMs, { includeSnoozed: false });
  const waiting = new Map<InboxKind, number>();
  for (const entry of inbox.entries) {
    waiting.set(entry.kind, (waiting.get(entry.kind) ?? 0) + 1);
  }
  const running = sessions.active.filter(
    (shell) => !isSubagent(shell) && sessionStateOf(shell, nowMs) === "running",
  ).length;
  const me = scope.actorUserId === null ? undefined : people.get(scope.actorUserId);
  const own = caller.caller;
  const sender =
    own === undefined
      ? null
      : yield* caller.threads
          .getTimelinePage(own.id, {
            afterPosition: Math.max(-1, own.visibleItemCount - 41),
            limit: 40,
            view: "messages",
          })
          .pipe(
            Effect.map((page) => {
              const last = page.items
                .map((row) => row.item)
                .filter((item) => item.type === "user_message")
                .at(-1);
              return last?.type === "user_message" ? (last.sentByUserId ?? null) : null;
            }),
            Effect.orElseSucceed(() => null),
          );

  const lines = [
    `## You act as ${me?.name ?? me?.email ?? (scope.actorUserId === null ? "this server's operator" : scope.actorUserId)}${me?.email !== null && me?.email !== undefined && me.name !== null ? ` (${me.email})` : ""}`,
    `- Server: ${descriptor.label}${scope.requestOrigin === undefined ? "" : ` (${scope.requestOrigin})`}, T3 Code ${descriptor.serverVersion}`,
    `- You call as ${callerKind(scope)}${scope.client === undefined ? "" : `, access ${scope.client.access}`}`,
  ];
  if (own !== undefined) {
    const ownContext = context(own);
    lines.push(
      `- Your session: ${sessionHeading(own, ownContext)} — ${sessionActivity(own, nowMs)}`,
      `  Branch ${own.branch ?? "none"} · mode ${own.interactionMode === "plan" ? "plan" : "build"} · model ${own.modelSelection.model}${ownContext.link === null ? "" : ` · ${ownContext.link}`}`,
      `  Id ${own.id}. Omit session in the t3_ tools to act on it.`,
    );
    if (sender !== null)
      lines.push(`  The current message came from ${personName(people, sender)}.`);
  }
  const waitingText = [...waiting.entries()]
    .map(([kind, count]) => `${count} ${INBOX_KIND_LABEL[kind].toLowerCase()}`)
    .join(", ");
  lines.push(
    `- Waiting on a person: ${inbox.entries.length}${waitingText.length === 0 ? "" : ` (${waitingText})`} · running now: ${running}`,
    "",
    "### Start here",
    "1. `t3_inbox` — everything that waits on a person, each with a ready t3_answer call.",
    '2. `t3_find_sessions {"query":"…"}` — a session by title, ticket, pull request or branch.',
    '3. `t3_start_session {"project":"…","prompt":"…"}` — start new work in one call.',
    "4. `t3_wait` — wait for the next question, approval, finish or failure; do not poll.",
  );
  return result(lines.join("\n"), {
    user:
      scope.actorUserId === null
        ? null
        : { id: scope.actorUserId, name: me?.name ?? null, email: me?.email ?? null },
    server: {
      label: descriptor.label,
      url: scope.requestOrigin ?? null,
      environmentId: scope.environmentId,
      version: descriptor.serverVersion,
    },
    caller: {
      kind: scope.thread !== undefined ? "in-session" : scope.principal,
      client:
        scope.client === undefined
          ? null
          : { label: scope.client.label, access: scope.client.access },
      capabilities: [...scope.capabilities],
    },
    session:
      own === undefined
        ? null
        : { ...sessionData(own, context(own)), currentMessageFrom: personName(people, sender) },
    counts: { waiting: Object.fromEntries(waiting), waitingTotal: inbox.entries.length, running },
    cursor: String(sessions.sequence),
  });
});

// -- t3_inbox ------------------------------------------------------------------

const inbox = Effect.fn("agentToolkit.inbox")(function* (input: Tool.Parameters<typeof InboxTool>) {
  const caller = yield* loadAgentCaller("t3.read");
  const nowMs = yield* Clock.currentTimeMillis;
  const origin = yield* linkOrigin(caller.scope);
  const projects = yield* loadProjects();
  const sessions = yield* loadVisibleSessions(caller, { archived: false });
  let pool = sessions.active;
  if (input.project !== undefined) {
    const project = yield* resolveProject(
      input.project,
      usableProjects(caller.scope, projects, sessions.active),
    );
    pool = pool.filter((shell) => shell.projectId === project.id);
  }
  const wanted =
    input.kinds === undefined
      ? null
      : new Set<string>(
          input.kinds.flatMap((kind) =>
            kind === "question" ? ["question", "async-question"] : [kind],
          ),
        );
  const candidates = inboxCandidates(pool, nowMs, {
    includeSnoozed: input.includeSnoozed === true,
  });
  let matching =
    wanted === null
      ? candidates.entries
      : candidates.entries.filter((entry) => wanted.has(entry.kind));
  const limit = input.limit ?? 20;
  const context = contextFor(caller, projects, nowMs, origin);
  const loaded = yield* Effect.forEach(matching.slice(0, limit), (candidate) =>
    Effect.gen(function* () {
      const detail: PendingDetail =
        candidate.kind === "failed" || candidate.kind === "unread"
          ? EMPTY_PENDING
          : yield* loadPendingDetail(caller, candidate.shell, {
              includePlan: candidate.kind === "plan",
            });
      // The shell keeps a plan flagged after a newer run answered it.
      if (candidate.kind === "plan" && !planIsCurrent(candidate.shell, detail.plan)) return null;
      return {
        kind: candidate.kind,
        shell: candidate.shell,
        context: context(candidate.shell),
        waitingSinceMs: candidate.waitingSinceMs,
        question:
          candidate.kind === "question"
            ? detail.question
            : candidate.kind === "async-question"
              ? (detail.asyncQuestions[0] ?? null)
              : null,
        approval: candidate.kind === "approval" ? detail.approval : null,
        plan: candidate.kind === "plan" ? detail.plan : null,
        lastReply: candidate.kind === "unread" ? yield* lastReply(caller, candidate.shell) : null,
      } satisfies InboxEntry;
    }),
  );
  const entries = loaded.filter((entry) => entry !== null);
  const stale = new Set(
    matching
      .slice(0, limit)
      .filter((_candidate, index) => loaded[index] === null)
      .map((candidate) => candidate.shell.id),
  );
  matching = matching.filter((candidate) => !stale.has(candidate.shell.id));
  const urgent = matching.filter((entry) => entry.urgent).length;
  const cursor = String(sessions.sequence);
  const lines = [
    matching.length === 0
      ? "## Nothing waits on you"
      : `## ${matching.length} ${matching.length === 1 ? "session waits" : "sessions wait"} on you${urgent === 0 ? "" : ` (${urgent} urgent)`}`,
    ...entries.map((entry, index) => `\n${renderInboxEntry(index + 1, entry)}`),
    "",
    ...(matching.length > entries.length
      ? [`${matching.length - entries.length} more not shown; raise limit to see them.`]
      : []),
    ...(candidates.hidden > 0 && input.includeSnoozed !== true
      ? [
          `${candidates.hidden} snoozed or settled ${candidates.hidden === 1 ? "session is" : "sessions are"} hidden; pass includeSnoozed: true to see them.`,
        ]
      : []),
    `To be told about the next item, call ${callHint("t3_wait", { cursor })} instead of calling t3_inbox again.`,
  ];
  return result(lines.join("\n"), {
    total: matching.length,
    urgent,
    hidden: candidates.hidden,
    cursor,
    items: entries.map((entry) => ({
      kind: entry.kind,
      session: sessionData(entry.shell, entry.context),
      urgent: matching.find((candidate) => candidate.shell.id === entry.shell.id)?.urgent ?? false,
      waitingSince: isoFromMillis(entry.waitingSinceMs),
      question: entry.question,
      approval: entry.approval,
      plan:
        entry.plan === null
          ? null
          : { title: planTitle(entry.plan.markdown), excerpt: oneLine(entry.plan.markdown, 600) },
      error: entry.kind === "failed" ? (entry.shell.lastError ?? null) : null,
      lastReply: entry.kind === "unread" ? (entry.lastReply?.slice(0, 600) ?? null) : null,
    })),
  });
});

// -- t3_answer -----------------------------------------------------------------

const DECISIONS: Record<string, ProviderApprovalDecision> = {
  approve: "accept",
  approve_for_session: "acceptForSession",
  approve_always: "acceptAlways",
  deny: "decline",
  cancel: "cancel",
};

/** What waits in a session, for a refusal that names the right parameter. */
const describeWaiting = (shell: SessionShell, detail: PendingDetail) => {
  const ref = shortRef(shell.id);
  if (detail.approval !== null)
    return `It waits on an approval: pass decision (${callHint("t3_answer", { session: ref, decision: "approve" })}).`;
  if (detail.question !== null || detail.asyncQuestions.length > 0)
    return `It waits on a question: pass choice, text or answers (see ${callHint("t3_session_brief", { session: ref })}).`;
  if (shell.hasActionableProposedPlan && attentionOf(shell) === "plan")
    return `It waits on a plan review: pass plan (${callHint("t3_answer", { session: ref, plan: "approve" })}).`;
  return `Nothing waits in it. To tell the agent something, use ${callHint("t3_send_message", { session: ref, message: "…" })}. If you sent this answer before, it was delivered.`;
};

const answer = Effect.fn("agentToolkit.answer")(function* (
  input: Tool.Parameters<typeof AnswerTool>,
) {
  const caller = yield* loadAgentCaller("t3.control");
  const { scope } = caller;
  const nowMs = yield* Clock.currentTimeMillis;
  const origin = yield* linkOrigin(caller.scope);
  const shell = yield* resolveSession({ caller, ref: input.session, nowMs });
  const ref = shortRef(shell.id);
  if (scope.thread?.threadId === shell.id) {
    return yield* fail(
      "own_session",
      "You are the agent in this session. A person answers its questions, approvals and plans; ask them in your chat instead.",
    );
  }
  yield* assertTargetWithinLimits(caller.limits, shell);
  const asked = [
    input.plan !== undefined ? "plan" : null,
    input.decision !== undefined ? "decision" : null,
    input.choice !== undefined || input.text !== undefined || input.answers !== undefined
      ? "question"
      : null,
  ].filter((part) => part !== null);
  if (asked.length !== 1) {
    return yield* fail(
      "answer_required",
      asked.length === 0
        ? "Pass one answer: choice, text or answers for a question; decision for an approval; or plan for a plan review."
        : `Pass one kind of answer per call; you passed ${asked.join(" and ")}.`,
    );
  }
  const detail = yield* loadPendingDetail(caller, shell, { includePlan: false });
  const people = yield* loadPeople();
  let answered: string;

  if (input.plan !== undefined) {
    if (!shell.hasActionableProposedPlan) {
      return yield* fail(
        "nothing_waiting",
        `No plan waits for review in ${ref}. ${describeWaiting(shell, detail)}`,
      );
    }
    const feedback = input.feedback?.trim() ?? "";
    if (input.plan === "revise" && feedback.length === 0) {
      return yield* fail(
        "feedback_required",
        "Pass feedback: what the agent must change in the plan.",
      );
    }
    // Approving starts implementation in build mode, which a plan-mode caller may not start.
    if (input.plan === "approve") {
      yield* assertTargetWithinLimits(caller.limits, { ...shell, interactionMode: "default" });
    }
    const planReview = yield* PlanReviewService;
    const documents = yield* planReview
      .listForThread(shell.id)
      .pipe(
        Effect.mapError(() =>
          fail("unavailable", "T3 Code could not read the plan review. Try again."),
        ),
      );
    const newestFirst = documents.toSorted((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    const open = newestFirst.find((document) => document.status === "open");
    const awaitingRevision = newestFirst.find(
      (document) => document.status === "changes-requested",
    );
    if (open === undefined && awaitingRevision !== undefined) {
      return yield* fail(
        "plan_revision_pending",
        `The review of "${awaitingRevision.title}" waits for the agent's revised plan, and the agent has not posted one for review (it may have answered in chat). Ask it to post the revised plan with ${callHint("t3_send_message", { session: ref, message: "Post your revised plan for review." })}, then approve it.`,
      );
    }
    if (open === undefined) {
      return yield* fail(
        "nothing_waiting",
        `No open plan review in ${ref}; it was already decided, or the plan is still being written. Check with ${callHint("t3_session_brief", { session: ref, include: ["plan"] })}.`,
      );
    }
    const submitted = yield* planReview
      .submit({
        documentId: open.documentId,
        decision:
          input.plan === "approve"
            ? "approved"
            : input.plan === "revise"
              ? "changes-requested"
              : "discarded",
        globalComment: feedback,
        editedMarkdown: null,
        actorUserId: scope.actorUserId,
        actorLabel: actorLabel(scope, people),
      })
      .pipe(
        Effect.mapError((error) =>
          "detail" in error && typeof error.detail === "string" && STALE_REQUEST.test(error.detail)
            ? fail("request_stale", `${error.detail} Read what waits now with t3_inbox.`)
            : fail("dispatch_failed", "T3 Code could not record the plan review. Try again."),
        ),
      );
    answered = `${input.plan === "approve" ? "Approved" : input.plan === "revise" ? "Asked for changes to" : "Discarded"} the plan "${open.title}"${submitted.turnStarted ? "; the agent is working on it" : ""}.`;
  } else if (input.decision !== undefined) {
    const approval = detail.approval;
    if (
      approval === null ||
      (input.requestId !== undefined && input.requestId !== approval.requestId)
    ) {
      return yield* fail(
        "nothing_waiting",
        `No such approval waits in ${ref}. ${describeWaiting(shell, detail)}`,
      );
    }
    const decision = DECISIONS[input.decision];
    if (
      decision === undefined ||
      !approval.options.some((option) => option.decision === decision)
    ) {
      return yield* fail(
        "invalid_answer",
        `This approval offers: ${approval.options.map((option) => DECISION_NAMES[option.decision]).join(", ")}.`,
      );
    }
    yield* caller.threads
      .dispatch({
        type: "runtime-request.respond",
        commandId: yield* commandIdFor(scope, "answer", input.clientRequestId),
        threadId: shell.id,
        requestId: RuntimeRequestId.make(approval.requestId),
        decision,
      })
      .pipe(Effect.mapError(dispatchError));
    answered = `Sent ${input.decision} for the ${approval.requestKind} request${approval.prompt === null ? "" : ` \`${oneLine(approval.prompt, 120)}\``}.`;
  } else {
    const open = [...(detail.question === null ? [] : [detail.question]), ...detail.asyncQuestions];
    const target =
      input.requestId === undefined
        ? open[0]
        : open.find((candidate) => candidate.requestId === input.requestId);
    if (target === undefined) {
      return yield* fail(
        "nothing_waiting",
        `No such question waits in ${ref}. ${describeWaiting(shell, detail)}`,
      );
    }
    const answers = buildAnswers(target.questions, input, target.textOnly);
    if (Result.isFailure(answers)) return yield* fail("invalid_answer", answers.failure);
    yield* caller.threads
      .dispatch({
        type: "runtime-request.respond",
        commandId: yield* commandIdFor(scope, "answer", input.clientRequestId),
        threadId: shell.id,
        requestId: RuntimeRequestId.make(target.requestId),
        answers: answers.success,
      })
      .pipe(Effect.mapError(dispatchError));
    answered = `Answered ${target.questions.length === 1 ? `"${oneLine(target.questions[0]?.header ?? "the question", 80)}"` : `${target.questions.length} questions`}: ${Object.values(
      answers.success,
    )
      .map((value) => (typeof value === "string" ? oneLine(value, 80) : value.join(", ")))
      .join(" · ")}.`;
  }

  const after = yield* caller.threads
    .getThreadShell(shell.id)
    .pipe(Effect.orElseSucceed(() => null));
  const now = after ?? shell;
  const projects = yield* loadProjects();
  const context = contextFor(caller, projects, nowMs, origin)(now);
  return result(
    [
      `## ${answered}`,
      `${sessionHeading(now, context)} — ${sessionActivity(now, nowMs)}`,
      `Next: ${callHint("t3_wait", { sessions: [ref] })} to hear when it needs you again.`,
    ].join("\n"),
    { answered, session: sessionData(now, context) },
  );
});

// -- t3_find_sessions ------------------------------------------------------------

const ACTIVE_STATES: ReadonlySet<SessionState> = new Set([
  "waiting",
  "running",
  "failed",
  "unread",
  "idle",
]);

const findSessions = Effect.fn("agentToolkit.findSessions")(function* (
  input: Tool.Parameters<typeof FindSessionsTool>,
) {
  const caller = yield* loadAgentCaller("t3.read");
  const nowMs = yield* Clock.currentTimeMillis;
  const origin = yield* linkOrigin(caller.scope);
  const state = input.state ?? "active";
  const sessions = yield* loadVisibleSessions(caller, {
    archived: state === "archived" || state === "any",
  });
  const projects = yield* loadProjects();
  let pool: ReadonlyArray<SessionShell> =
    state === "archived"
      ? sessions.archived
      : state === "any"
        ? [...sessions.active, ...sessions.archived]
        : sessions.active;
  if (input.includeSubagents !== true) pool = pool.filter((shell) => !isSubagent(shell));
  if (input.project !== undefined) {
    const project = yield* resolveProject(
      input.project,
      usableProjects(caller.scope, projects, sessions.active),
    );
    pool = pool.filter((shell) => shell.projectId === project.id);
  }
  if (input.ticket !== undefined) {
    const key = /([a-z][a-z0-9]*-\d+)/i.exec(input.ticket)?.[1]?.toUpperCase();
    pool = key === undefined ? [] : pool.filter((shell) => linearKeysOf(shell).includes(key));
  }
  if (input.pr !== undefined) {
    const wanted = input.pr.trim();
    const number = /(?:^#?|\/pulls?\/)(\d+)\/?$/.exec(wanted)?.[1];
    pool = pool.filter((shell) =>
      pullRequestsOf(shell).some(
        (pr) => pr.url === wanted || (number !== undefined && pr.number === Number(number)),
      ),
    );
  }
  if (input.branch !== undefined) {
    const wanted = input.branch.toLowerCase();
    pool = pool.filter((shell) => shell.branch?.toLowerCase().includes(wanted) === true);
  }
  if (input.query !== undefined && input.query.trim().length > 0) {
    pool = matchSessionRef(input.query, pool);
  }
  pool = pool.filter((shell) => {
    const current = sessionStateOf(shell, nowMs);
    return state === "any" || (state === "active" ? ACTIVE_STATES.has(current) : current === state);
  });
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? 20;
  const page = pool.slice(cursor, cursor + limit);
  const nextCursor = cursor + page.length < pool.length ? cursor + page.length : null;
  const context = contextFor(caller, projects, nowMs, origin);
  const lines = [
    pool.length === 0
      ? "## No session matches"
      : `## ${pool.length} ${pool.length === 1 ? "session" : "sessions"}${pool.length > page.length ? `, showing ${cursor + 1}–${cursor + page.length}` : ""}`,
    ...page.map((shell, index) => renderSessionLine(cursor + index + 1, shell, context(shell))),
    ...(nextCursor === null
      ? []
      : [
          `More: ${callHint("t3_find_sessions", { ...input, cursor: nextCursor, format: undefined })}`,
        ]),
    ...(page.length > 0
      ? [`Read one with ${callHint("t3_session_brief", { session: shortRef(page[0]?.id ?? "") })}.`]
      : ['Try state: "any", a shorter query, or t3_inbox for what waits on you.']),
  ];
  return result(lines.join("\n"), {
    total: pool.length,
    nextCursor,
    sessions: page.map((shell) => sessionData(shell, context(shell))),
  });
});

// -- t3_session_brief ---------------------------------------------------------------

interface BriefMessage {
  readonly role: "User" | "Agent";
  readonly text: string;
  readonly sentByUserId: string | null;
}

/** The last `count` messages, read from the end of the timeline only. */
const recentMessages = Effect.fn("agentToolkit.recentMessages")(function* (
  caller: Caller,
  shell: SessionShell,
  count: number,
) {
  if (count === 0) return [] as ReadonlyArray<BriefMessage>;
  const window = Math.max(count * 8, 40);
  const page = yield* caller.threads
    .getTimelinePage(shell.id, {
      afterPosition: Math.max(-1, shell.visibleItemCount - window - 1),
      limit: window,
      view: "messages",
    })
    .pipe(Effect.option);
  if (Option.isNone(page)) return [] as ReadonlyArray<BriefMessage>;
  return page.value.items
    .flatMap((row): ReadonlyArray<BriefMessage> =>
      row.item.type === "user_message"
        ? [{ role: "User", text: row.item.text, sentByUserId: row.item.sentByUserId ?? null }]
        : row.item.type === "assistant_message"
          ? [{ role: "Agent", text: row.item.text, sentByUserId: null }]
          : [],
    )
    .slice(-count);
});

/** The agent's newest reply. The shell does not carry it, so it is read from the timeline. */
const lastReply = (caller: Caller, shell: SessionShell) =>
  recentMessages(caller, shell, 4).pipe(
    Effect.map(
      (messages) => messages.findLast((message) => message.role === "Agent")?.text ?? null,
    ),
  );

/** The session's goal: the provider's own, else the first message. */
const goalOf = Effect.fn("agentToolkit.goalOf")(function* (caller: Caller, shell: SessionShell) {
  if (shell.goal?.objective !== undefined) return shell.goal.objective;
  const page = yield* caller.threads
    .getTimelinePage(shell.id, { afterPosition: -1, limit: 1, view: "messages" })
    .pipe(Effect.option);
  const first = Option.isSome(page) ? page.value.items[0]?.item : undefined;
  return first?.type === "user_message" ? first.text : null;
});

const brief = Effect.fn("agentToolkit.brief")(function* (
  input: Tool.Parameters<typeof SessionBriefTool>,
) {
  const caller = yield* loadAgentCaller("t3.read");
  const nowMs = yield* Clock.currentTimeMillis;
  const origin = yield* linkOrigin(caller.scope);
  const shell = yield* resolveSession({ caller, ref: input.session, nowMs });
  const ref = shortRef(shell.id);
  const projects = yield* loadProjects();
  const people = yield* loadPeople();
  const context = contextFor(caller, projects, nowMs, origin)(shell);
  const include = new Set(input.include ?? []);
  const attention = attentionOf(shell);
  const detail = yield* loadPendingDetail(caller, shell, {
    includePlan: include.has("plan") || attention === "plan",
  });
  const goal = yield* goalOf(caller, shell);
  const messages = yield* recentMessages(caller, shell, input.messages ?? 3);
  const children = include.has("children")
    ? (yield* loadVisibleSessions(caller, { archived: false })).active.filter(
        (candidate) =>
          candidate.parentThreadId === shell.id || candidate.lineage.parentThreadId === shell.id,
      )
    : [];
  const members = (shell.memberUserIds ?? []).map((userId) => personName(people, userId));
  const lines = [
    `## ${sessionHeading(shell, context)}`,
    `- State: ${sessionActivity(shell, nowMs)}`,
    `- Owner: ${personName(people, shell.ownerUserId ?? null) ?? "none"}${members.length === 0 ? "" : ` · tagged: ${members.join(", ")}`}`,
    `- Branch ${shell.branch ?? "none"} · mode ${shell.interactionMode === "plan" ? "plan" : "build"} · model ${shell.modelSelection.model} · ${shell.runtimeMode}`,
    ...(context.link === null ? [] : [`- Link: ${context.link}`]),
    ...(shell.lastError !== null && shell.lastError !== undefined && attention === "failed"
      ? [`- Error: ${oneLine(shell.lastError, 400)}`]
      : []),
  ];
  if (detail.approval !== null)
    lines.push("", "### Waits on an approval", ...renderApproval(detail.approval, ref));
  if (detail.question !== null)
    lines.push("", "### Waits on a question", ...renderQuestion(detail.question, ref));
  for (const question of detail.asyncQuestions) {
    lines.push("", "### Asked while it keeps working", ...renderQuestion(question, ref));
  }
  if ((attention === "plan" && planIsCurrent(shell, detail.plan)) || include.has("plan")) {
    lines.push("", "### Plan", ...renderPlan(detail.plan, ref, 0));
    if (detail.plan !== null)
      lines.push("", cutText(detail.plan.markdown, include.has("plan") ? 8_000 : 1_500));
  }
  if (goal !== null) lines.push("", "### Goal", cutText(goal.trim(), 800));
  if (messages.length > 0) {
    lines.push(
      "",
      `### Last ${messages.length === 1 ? "message" : `${messages.length} messages`}`,
      ...messages.map((message) =>
        messageExcerpt(
          message.role === "User"
            ? `User${message.sentByUserId === null ? "" : ` (${personName(people, message.sentByUserId)})`}`
            : "Agent",
          message.text,
          1_500,
        ),
      ),
    );
  }
  if (children.length > 0) {
    lines.push(
      "",
      "### Sessions under this one",
      ...children
        .slice(0, 15)
        .map(
          (child) =>
            `- ${sessionHeading(child, contextFor(caller, projects, nowMs, origin)(child))} — ${sessionActivity(child, nowMs)}`,
        ),
    );
  }
  lines.push(
    "",
    `Full history: ${callHint("t3_thread_read", { threadId: shell.id })}. Watch it: ${callHint("t3_wait", { sessions: [ref] })}.`,
  );
  return result(lines.join("\n"), {
    session: sessionData(shell, context),
    owner: personName(people, shell.ownerUserId ?? null),
    tagged: members,
    waitsOn: {
      approval: detail.approval,
      question: detail.question,
      asyncQuestions: detail.asyncQuestions,
      plan:
        detail.plan === null
          ? null
          : {
              title: planTitle(detail.plan.markdown),
              markdown: cutText(detail.plan.markdown, 8_000),
            },
    },
    goal: goal === null ? null : cutText(goal, 800),
    messages: messages.map((message) => ({ ...message, text: cutText(message.text, 1_500) })),
    children: children.map((child) =>
      sessionData(child, contextFor(caller, projects, nowMs, origin)(child)),
    ),
    tags: tagsOf(shell),
  });
});

// -- t3_start_session -----------------------------------------------------------------

const workspaceFor = (workspace: string | undefined) => {
  const value = workspace?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (value === "new-worktree") return { mode: "new-worktree" as const };
  if (value === "project-root" || value === "local" || value === "root")
    return { mode: "local" as const };
  return { mode: "existing-worktree" as const, path: value };
};

export const interactionModeFor = (
  mode: "build" | "plan" | undefined,
): ProviderInteractionMode | undefined =>
  mode === "plan" ? "plan" : mode === "build" ? "default" : undefined;

/** What a session did first: its question, its approval, its reply or its failure. */
const firstOutcome = Effect.fn("agentToolkit.firstOutcome")(function* (
  caller: Caller,
  shell: SessionShell,
) {
  const ref = shortRef(shell.id);
  const attention = attentionOf(shell);
  if (attention === "question" || attention === "approval" || attention === "async-question") {
    const detail = yield* loadPendingDetail(caller, shell, { includePlan: false });
    const question = detail.question ?? detail.asyncQuestions[0] ?? null;
    return [
      "### It waits on you",
      ...(detail.approval !== null ? renderApproval(detail.approval, ref) : []),
      ...(question !== null ? renderQuestion(question, ref) : []),
    ];
  }
  if (attention === "failed") {
    return [
      "### It failed",
      oneLine(shell.lastError ?? "The run failed without an error message.", 600),
    ];
  }
  const reply = yield* lastReply(caller, shell);
  return reply === null
    ? []
    : [
        "### First reply",
        cutText(reply.trim(), 1_500),
        ...(attention === "plan" ? ["", ...renderPlan(null, ref, 0)] : []),
      ];
});

const startSession = Effect.fn("agentToolkit.startSession")(function* (
  input: Tool.Parameters<typeof StartSessionTool>,
  started: McpToolAccess.StartedModes,
) {
  const caller = yield* loadAgentCaller("t3.control");
  const { scope } = caller;
  // The same rule as t3_create_session: a user-bound credential, or an operator.
  if (!McpInvocationContext.canCreateMcpSessions(scope)) {
    return yield* fail(
      "capability_denied",
      "Starting sessions needs a user-bound credential or an operator client. Ask the person who approved this client for more access.",
    );
  }
  const nowMs = yield* Clock.currentTimeMillis;
  const origin = yield* linkOrigin(caller.scope);
  const projects = yield* loadProjects();
  const sessions = yield* loadVisibleSessions(caller, { archived: false });
  const project = yield* resolveProject(
    input.project,
    usableProjects(scope, projects, sessions.active),
  );
  const prompt = input.prompt.trim();
  if (prompt.length === 0) return yield* fail("prompt_required", "Pass prompt: the first message.");

  let modelSelection: ModelSelection | undefined;
  if (input.model !== undefined) {
    const providers = yield* (yield* ProviderRegistry).getProviders;
    const resolved = resolveModel(input.model, providers);
    if (Result.isFailure(resolved)) return yield* fail("model_not_found", resolved.failure);
    const selection = modelSelectionFor(resolved.success, input.effort);
    if (Result.isFailure(selection)) return yield* fail("invalid_effort", selection.failure);
    modelSelection = selection.success;
  } else if (input.effort !== undefined) {
    return yield* fail("model_required", 'Pass model with effort, for example model: "opus".');
  }

  const parent =
    input.parent === undefined
      ? undefined
      : yield* resolveSession({ caller, ref: input.parent, nowMs, sessions });
  const sessionId =
    input.clientRequestId === undefined || input.clientRequestId.trim().length === 0
      ? undefined
      : ThreadId.make(
          `mcp:${stableUuid(`${scope.requestNamespace}\u0000start\u0000${input.clientRequestId.trim()}`)}`,
        );
  const existing =
    sessionId === undefined
      ? null
      : yield* caller.threads.getThreadShell(sessionId).pipe(Effect.orElseSucceed(() => null));

  const interactionMode = interactionModeFor(input.mode);
  const workspace = workspaceFor(input.workspace);
  const created =
    existing !== null
      ? null
      : yield* createSession(
          {
            projectId: project.id,
            prompt,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(modelSelection === undefined ? {} : { modelSelection }),
            ...(interactionMode === undefined ? {} : { interactionMode }),
            ...(workspace === undefined ? {} : { workspace }),
            ...(input.group === undefined ? {} : { customGroup: input.group }),
            ...(input.tag === undefined ? {} : { tagUserIds: input.tag, inheritParentTags: true }),
            ...(parent === undefined ? {} : { parentSessionId: parent.id }),
          },
          started,
          { sessionId },
        ).pipe(
          Effect.mapError((error) =>
            error._tag === "OrchestratorMcpFailure"
              ? error
              : fail(
                  "start_failed",
                  `${error.message} Check the project and settings, then retry with the same clientRequestId.`,
                ),
          ),
        );
  const newId = existing?.id ?? created?.sessionId;
  if (newId === undefined)
    return yield* fail("start_failed", "T3 Code did not return the new session.");

  let waitNote: string | null = null;
  if (input.waitFor === "first-reply") {
    const outcome = yield* waitForChange({
      caller,
      afterSequence: 0,
      threadIds: new Set([newId]),
      until: new Set(WAIT_CHANGES),
      timeoutMs: (input.timeoutSeconds ?? DEFAULT_WAIT_SECONDS) * 1000,
      includeSubagents: true,
    });
    if (outcome.match === null) {
      waitNote = `No reply within ${input.timeoutSeconds ?? DEFAULT_WAIT_SECONDS}s; it is still working.`;
    }
  }
  const shell = yield* caller.threads.getThreadShell(newId).pipe(Effect.orElseSucceed(() => null));
  const ref = shortRef(newId);
  const context =
    shell === null
      ? null
      : contextFor(caller, projects, yield* Clock.currentTimeMillis, origin)(shell);
  const outcomeLines =
    shell === null || input.waitFor !== "first-reply" ? [] : yield* firstOutcome(caller, shell);
  const lines = [
    `## ${existing !== null ? "Already started" : "Started"}: \`${ref}\` ${shell?.title ?? input.title ?? oneLine(prompt, 80)}`,
    `- Project ${project.title} · ${created?.workspace === undefined ? (shell?.worktreePath ?? project.workspaceRoot) : `${created.workspace.mode}${"path" in created.workspace && created.workspace.path !== undefined ? ` at ${created.workspace.path}` : ""}`}`,
    ...(shell === null
      ? []
      : [
          `- Model ${shell.modelSelection.model} · mode ${shell.interactionMode === "plan" ? "plan" : "build"} · ${sessionActivity(shell, context?.nowMs ?? nowMs)}`,
        ]),
    ...(context?.link === null || context === null ? [] : [`- Link: ${context.link}`]),
    `- Id ${newId}`,
    ...(waitNote === null ? [] : ["", waitNote]),
    ...(outcomeLines.length === 0 ? [] : ["", ...outcomeLines]),
    "",
    `Next: ${callHint("t3_wait", { sessions: [ref] })} for its next question or finish, or ${callHint("t3_session_brief", { session: ref })}.`,
  ];
  return result(lines.join("\n"), {
    started: existing === null,
    session:
      shell === null || context === null ? { sessionId: newId, ref } : sessionData(shell, context),
    workspace: created?.workspace ?? null,
    owner: created?.ownerUserId ?? null,
    tagged: created?.taggedUserIds ?? [],
    waited: input.waitFor === "first-reply",
  });
});

// -- t3_send_message --------------------------------------------------------------------

const sendError = (error: { readonly _tag: string; readonly message: string }) => {
  switch (error._tag) {
    case "ThreadManagementThreadArchivedError":
      return fail("session_archived", `${error.message} Unarchive it in the app first.`);
    case "ThreadManagementNoSteerableRunError":
      return fail("no_active_turn", `${error.message} Send with ifBusy: "queue" instead.`);
    case "OrchestratorDispatchError":
    case "OrchestratorCommandRejectedError":
      return dispatchError(error as OrchestratorV2Error);
    default:
      return fail(
        "dispatch_failed",
        "T3 Code could not deliver the message. Try again with the same clientRequestId.",
      );
  }
};

const sendMessage = Effect.fn("agentToolkit.sendMessage")(function* (
  input: Tool.Parameters<typeof SendMessageTool>,
) {
  const caller = yield* loadAgentCaller("t3.control");
  const { scope } = caller;
  const nowMs = yield* Clock.currentTimeMillis;
  const shell = yield* resolveSession({ caller, ref: input.session, nowMs });
  const ref = shortRef(shell.id);
  const text = input.message.trim();
  if (text.length === 0) return yield* fail("message_required", "Pass message: the text to send.");
  const attention = attentionOf(shell);
  if (
    input.force !== true &&
    (attention === "question" || attention === "approval" || attention === "async-question")
  ) {
    return yield* fail(
      "question_open",
      `${ref} waits on ${attention === "approval" ? "an approval" : "a question"}. Answer it with t3_answer (see ${callHint("t3_session_brief", { session: ref })}), or pass force: true to send anyway; the agent may then drop the open ${attention === "approval" ? "approval" : "question"}.`,
    );
  }
  yield* assertTargetWithinLimits(caller.limits, shell);
  const busy = shell.activeRunId !== null;
  const ifBusy = input.ifBusy ?? "queue";
  const mode = !busy
    ? "queue"
    : ifBusy === "steer"
      ? "steer"
      : ifBusy === "interrupt"
        ? "restart"
        : "queue";
  const commandId = yield* commandIdFor(scope, "send", input.clientRequestId);
  const sent = yield* caller.threads
    .sendToThread({
      projectId: shell.projectId,
      commandId,
      threadId: shell.id,
      messageId: MessageId.make(`message:${commandId}`),
      ...(scope.thread === undefined ? {} : { senderThreadId: scope.thread.threadId }),
      text,
      attachments: [],
      mode,
      createdBy: scope.thread === undefined ? "user" : "agent",
      creationSource: "mcp",
    })
    .pipe(Effect.mapError(sendError));
  const delivery =
    sent.delivery === "queued"
      ? "queued after the current turn"
      : sent.delivery === "steered"
        ? "added to the current turn"
        : sent.delivery === "restarted"
          ? "sent; the current turn was stopped and restarted with it"
          : "sent; the agent started a turn";
  return result(
    [
      `## Message ${delivery}`,
      `\`${ref}\` ${shell.title} · run ${sent.run.id} (${sent.run.status})`,
      `Next: ${callHint("t3_wait", { sessions: [ref] })} to hear when it answers, asks or fails.`,
    ].join("\n"),
    {
      sessionId: shell.id,
      ref,
      delivery: sent.delivery,
      runId: sent.run.id,
      runStatus: sent.run.status,
      messageId: sent.message.id,
    },
  );
});

// -- t3_wait --------------------------------------------------------------------------

const wait = Effect.fn("agentToolkit.wait")(function* (input: Tool.Parameters<typeof WaitTool>) {
  const caller = yield* loadAgentCaller("t3.read");
  const nowMs = yield* Clock.currentTimeMillis;
  const origin = yield* linkOrigin(caller.scope);
  const until = new Set<WaitChange>(input.until ?? WAIT_CHANGES);
  const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_WAIT_SECONDS;
  let sessions: VisibleSessions | undefined;
  let threadIds: Set<string> | null = null;
  if (input.sessions !== undefined && input.sessions.length > 0) {
    const resolved: Array<SessionShell> = [];
    for (const ref of input.sessions) {
      resolved.push(yield* resolveSession({ caller, ref, nowMs, sessions }));
    }
    threadIds = new Set(resolved.map((shell) => shell.id));
  }
  let after: number;
  if (input.cursor !== undefined) {
    const parsed = Number(input.cursor);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return yield* fail(
        "invalid_cursor",
        "Pass the cursor a previous t3_wait or t3_inbox returned, or omit it.",
      );
    }
    after = parsed;
  } else if (threadIds !== null && threadIds.size === 1) {
    after = yield* caller.threads
      .getThreadEventSequence([...threadIds][0] as ThreadId)
      .pipe(
        Effect.mapError(() =>
          fail("unavailable", "T3 Code could not read the session. Try again."),
        ),
      );
  } else {
    sessions = yield* loadVisibleSessions(caller, { archived: false });
    after = sessions.sequence;
  }
  const outcome = yield* waitForChange({
    caller,
    afterSequence: after,
    threadIds,
    until,
    timeoutMs: timeoutSeconds * 1000,
  });
  const cursor = String(outcome.cursor);
  if (outcome.match === null) {
    return result(
      [
        `## No change in ${timeoutSeconds}s`,
        `Call ${callHint("t3_wait", { ...(input.sessions === undefined ? {} : { sessions: input.sessions }), cursor })} to keep waiting.`,
      ].join("\n"),
      { timedOut: true, cursor },
    );
  }
  const match = outcome.match;
  const shell = yield* caller.threads
    .getThreadShell(match.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  const ref = shortRef(match.threadId);
  if (shell === null) {
    return result(`## \`${ref}\` ${match.what}\nNext: ${callHint("t3_wait", { cursor })}`, {
      timedOut: false,
      cursor,
      change: { ...match },
    });
  }
  const projects = yield* loadProjects();
  const context = contextFor(caller, projects, yield* Clock.currentTimeMillis, origin)(shell);
  const flagged = attentionOf(shell);
  const detail =
    flagged === null || flagged === "failed"
      ? EMPTY_PENDING
      : yield* loadPendingDetail(caller, shell, { includePlan: flagged === "plan" });
  const attention = flagged === "plan" && !planIsCurrent(shell, detail.plan) ? null : flagged;
  const reply =
    match.change === "finished" && attention === null ? yield* lastReply(caller, shell) : null;
  const lines = [
    `## \`${ref}\` ${match.what}`,
    `${sessionHeading(shell, context)} — ${sessionActivity(shell, context.nowMs)}`,
    ...(detail.approval === null ? [] : renderApproval(detail.approval, ref)),
    ...(detail.question === null ? [] : renderQuestion(detail.question, ref)),
    ...detail.asyncQuestions.flatMap((question) => renderQuestion(question, ref)),
    ...(attention === "plan" ? renderPlan(detail.plan, ref, 600) : []),
    ...(attention === "failed"
      ? [`   Error: ${oneLine(shell.lastError ?? "no message", 400)}`]
      : []),
    ...(reply === null ? [] : [`   Last reply: ${oneLine(reply, 400)}`]),
    ...(context.link === null ? [] : [`   Link: ${context.link}`]),
    `Next: ${callHint("t3_wait", { ...(input.sessions === undefined ? {} : { sessions: input.sessions }), cursor })} to keep watching.`,
  ];
  return result(lines.join("\n"), {
    timedOut: false,
    cursor,
    change: {
      sessionId: match.threadId,
      ref,
      change: match.change,
      what: match.what,
      sequence: match.sequence,
    },
    session: sessionData(shell, context),
    waitsOn: detail,
  });
});

/** Who may call each agent tool (see McpToolAccess). */
export const AgentToolkitHandlers = McpToolAccess.toLayer(AgentToolkit, {
  t3_whoami: McpToolAccess.reads(whoami),
  t3_inbox: McpToolAccess.reads(inbox),
  t3_answer: McpToolAccess.writes(answer),
  t3_find_sessions: McpToolAccess.reads(findSessions),
  t3_session_brief: McpToolAccess.reads(brief),
  t3_start_session: McpToolAccess.startsThreads(
    (input) => ({ interactionMode: interactionModeFor(input.mode) }),
    startSession,
  ),
  t3_send_message: McpToolAccess.writes(sendMessage),
  t3_wait: McpToolAccess.reads(wait),
});

export const __testing = {
  whoami,
  inbox,
  answer,
  findSessions,
  brief,
  startSession,
  sendMessage,
  wait,
};
