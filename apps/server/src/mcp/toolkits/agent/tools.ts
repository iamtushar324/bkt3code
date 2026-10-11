/**
 * T3-CUSTOM(expbkt3): the agent toolkit — a small set of task-shaped tools for
 * agents that drive T3 Code from outside (OAuth clients, personal tokens) or
 * from inside a session.
 *
 * Each tool does one whole job an agent otherwise strings together from
 * several low-level calls: see what waits on a person and answer it, find a
 * session, read where it stands, start one, send to one, and wait for a
 * change. Results are short Markdown with the exact next call; pass
 * `format: "json"` for the same facts as JSON. Session references are
 * flexible (an id, its first 8 characters, a T3 link, a Linear key, a pull
 * request URL or a title), and an omitted session is the caller's own.
 *
 * Names avoid "create", "file", "agent" and "command": provider adapters
 * classify tool rows by those substrings (see t3_show_ui).
 */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { ClerkDirectory } from "../../../auth/ClerkDirectory.ts";
import { ServerConfig } from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { GitWorkflowService } from "../../../git/GitWorkflowService.ts";
import { TurnStartBootstrap } from "../../../orchestration-v2/turnStartBootstrap.expbkt3.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { OrchestrationAccessControl } from "../../../orchestration-v2/Services/AccessControl.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import { PlanReviewService } from "../../../planreview/PlanReviewService.ts";
import * as Project from "../../../project/ProjectService.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { JsonToolResult } from "../../jsonToolResult.expbkt3.ts";

/** A refusal or failure the agent can act on: a stable code and what to do next. */
export class AgentToolError extends Schema.TaggedError<AgentToolError>()("AgentToolError", {
  code: Schema.String,
  message: Schema.String,
}) {}

/** The Markdown an agent reads, and the same facts as data for `format: "json"`. */
export const AgentToolResult = Schema.Struct({
  markdown: Schema.String,
  data: JsonToolResult,
});

const AgentToolFailure = Schema.Union([AgentToolError, OrchestratorMcpFailure]);

const described = <S extends Schema.Top>(schema: S, description: string): S =>
  schema.annotate({ description }) as S;

const format = {
  format: Schema.optional(
    described(
      Schema.Literals(["markdown", "json"]),
      "markdown (the default) returns a short text with the next call to make; json returns the same facts as data.",
    ),
  ),
};

const sessionRef = (description: string) => described(Schema.String, description);

const SESSION_REF_HELP =
  "A session: its id, the first 8 characters of its id, a T3 session link, a Linear issue key or URL it is tagged with (TEC-1488), a linked pull request URL, or its title.";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  OrchestrationAccessControl,
  Project.ProjectService,
  ClerkDirectory,
  Crypto.Crypto,
];

const readOnly = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false) as T;

const changing = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, false) as T;

export const WhoamiTool = readOnly(
  Tool.make("t3_whoami", {
    description:
      "Start here. Who you act as (user, client type, access), which T3 server this is, and, for an agent inside a session, your own session: id, title, link, project, branch, mode, model, Linear tags, pull requests and who sent the current message. Also counts what waits on a person and what runs now, and lists the four calls that do most work.",
    parameters: Schema.Struct(format),
    success: AgentToolResult,
    failure: AgentToolFailure,
    dependencies: [...dependencies, ServerEnvironment.ServerEnvironment],
  }).annotate(Tool.Title, "Who am I on T3 Code"),
);

export const InboxTool = readOnly(
  Tool.make("t3_inbox", {
    description:
      "Everything that waits on a person, in one call: open questions with their options, approvals with the command or file and the allowed decisions, plans ready to review with an excerpt, failed runs with the error, and finished runs nobody has read. Each item has a ready t3_answer call. Approvals come first, then questions, plans, failures and unread results; urgent sessions (P0/P1, or 'urgent' in the title) lead. Snoozed, settled, archived and subagent sessions are left out unless asked for. To wait for new items, call t3_wait instead of calling this again.",
    parameters: Schema.Struct({
      project: Schema.optional(
        described(Schema.String, "Only sessions in this project: its name, path or id."),
      ),
      kinds: Schema.optional(
        described(
          Schema.Array(Schema.Literals(["approval", "question", "plan", "failed", "unread"])),
          "Only these kinds. 'question' includes questions the agent asked while it keeps working.",
        ),
      ),
      includeSnoozed: Schema.optional(
        described(Schema.Boolean, "Also show snoozed and settled sessions. Defaults to false."),
      ),
      limit: Schema.optional(
        described(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
          "Most items to show, 1 to 50. Defaults to 20.",
        ),
      ),
      ...format,
    }),
    success: AgentToolResult,
    failure: AgentToolFailure,
    dependencies,
  }).annotate(Tool.Title, "What waits on a person"),
);

const ChoiceValue = Schema.Union([Schema.Int, Schema.String]);

export const AnswerTool = changing(
  Tool.make("t3_answer", {
    description:
      "Answer what a session waits for, as the person you act for. Pass one of: choice (an option number or label, or a list for a multi-select question), text (your own answer), answers (one entry per question when a request asks several), decision (for an approval), or plan (approve, revise with feedback, or discard). Omit requestId to answer the oldest open item. The tool refuses when nothing of that kind waits, when the request was already answered, and when an agent tries to answer in its own session. Get the options from t3_inbox or t3_session_brief.",
    parameters: Schema.Struct({
      session: sessionRef(SESSION_REF_HELP),
      requestId: Schema.optional(
        described(
          Schema.String,
          "The open request to answer. Omit to answer the oldest open item of the kind your answer fits.",
        ),
      ),
      choice: Schema.optional(
        described(
          Schema.Union([ChoiceValue, Schema.Array(ChoiceValue)]),
          "For a question with one part: the option number (1 is the first option) or its label; a list of them for a multi-select question.",
        ),
      ),
      text: Schema.optional(
        described(
          Schema.String,
          "For a question with one part: your own answer, when the question accepts one.",
        ),
      ),
      answers: Schema.optional(
        described(
          Schema.Array(
            Schema.Struct({
              question: described(ChoiceValue, "The question's number (1 is the first) or its id."),
              choice: Schema.optional(Schema.Union([ChoiceValue, Schema.Array(ChoiceValue)])),
              text: Schema.optional(Schema.String),
            }),
          ),
          "For a request that asks several questions: one entry per question.",
        ),
      ),
      decision: Schema.optional(
        described(
          Schema.Literals(["approve", "approve_for_session", "approve_always", "deny", "cancel"]),
          "For an approval: approve once, approve for the rest of the session, approve always (when the request offers it), deny, or cancel the turn.",
        ),
      ),
      plan: Schema.optional(
        described(
          Schema.Literals(["approve", "revise", "discard"]),
          "For a plan to review: approve it (implementation starts), ask for a revision (pass feedback), or discard it.",
        ),
      ),
      feedback: Schema.optional(
        described(Schema.String, "What to change, for plan: revise. Optional comment for approve."),
      ),
      clientRequestId: Schema.optional(
        described(
          Schema.String,
          "Your own id for this answer, so a retry with the same id does not answer twice.",
        ),
      ),
      ...format,
    }),
    success: AgentToolResult,
    failure: AgentToolFailure,
    dependencies: [...dependencies, PlanReviewService],
  }).annotate(Tool.Title, "Answer a session"),
);

export const FindSessionsTool = readOnly(
  Tool.make("t3_find_sessions", {
    description:
      "Find sessions, one line each: short id, title, state, project, Linear tags, pull requests, last change and link. A running session also shows how long it has run and its goal; a waiting one shows what it waits on. Filter by text, ticket, pull request, branch, project and state. Use the short id with the other t3_ tools.",
    parameters: Schema.Struct({
      query: Schema.optional(
        described(Schema.String, "Text in the title, or an id, link, ticket or pull request URL."),
      ),
      ticket: Schema.optional(
        described(Schema.String, "A Linear issue key or URL the session is tagged with."),
      ),
      pr: Schema.optional(
        described(Schema.String, "A pull request URL, or its number, linked to the session."),
      ),
      branch: Schema.optional(described(Schema.String, "Text in the session's branch name.")),
      project: Schema.optional(described(Schema.String, "A project name, path or id.")),
      state: Schema.optional(
        described(
          Schema.Literals([
            "active",
            "running",
            "waiting",
            "idle",
            "failed",
            "unread",
            "snoozed",
            "settled",
            "archived",
            "any",
          ]),
          "active (the default) is every session not snoozed, settled or archived; any includes all of them.",
        ),
      ),
      includeSubagents: Schema.optional(
        described(Schema.Boolean, "Include subagent sessions. Defaults to false."),
      ),
      limit: Schema.optional(
        described(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
          "Most sessions to show, 1 to 100. Defaults to 20.",
        ),
      ),
      cursor: Schema.optional(
        described(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), "From a previous result."),
      ),
      ...format,
    }),
    success: AgentToolResult,
    failure: AgentToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Find sessions"),
);

export const SessionBriefTool = readOnly(
  Tool.make("t3_session_brief", {
    description:
      "Where one session stands, in a short read: status, project, branch, model, mode, owner, Linear tags, what it waits on (with the t3_answer call), its goal, the last few messages, and pull requests. Use it instead of reading the whole history. Omit session for your own.",
    parameters: Schema.Struct({
      session: Schema.optional(sessionRef(`${SESSION_REF_HELP} Omit for your own session.`)),
      messages: Schema.optional(
        described(
          Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 })),
          "How many recent messages to show, 0 to 20. Defaults to 3.",
        ),
      ),
      include: Schema.optional(
        described(
          Schema.Array(Schema.Literals(["plan", "children"])),
          "Also show the newest plan's text, or the sessions filed under this one.",
        ),
      ),
      ...format,
    }),
    success: AgentToolResult,
    failure: AgentToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Brief on a session"),
);

export const StartSessionTool = changing(
  Tool.make("t3_start_session", {
    description:
      "Start a new session with a first message, in one call. Name the project by name, path or id, and the model by alias (opus, sonnet, haiku, codex, or any model name or id from the server's catalog). Omitted settings follow the project's saved new-session defaults. Set waitFor: first-reply to wait for the agent's first answer or question. With clientRequestId, a retry returns the same session.",
    parameters: Schema.Struct({
      project: described(Schema.String, "The project: its name, path or id."),
      prompt: described(Schema.String, "The first message: the outcome you want and its limits."),
      title: Schema.optional(described(Schema.String, "Session title. Defaults to the prompt.")),
      model: Schema.optional(
        described(
          Schema.String,
          "A model alias (opus, sonnet, haiku, codex), a model name or id, or provider/model.",
        ),
      ),
      effort: Schema.optional(
        described(
          Schema.String,
          "Reasoning effort, when the model offers one (low, medium, high).",
        ),
      ),
      mode: Schema.optional(
        described(
          Schema.Literals(["build", "plan"]),
          "build works on the task; plan proposes a plan first and waits for approval.",
        ),
      ),
      workspace: Schema.optional(
        described(
          Schema.String,
          "new-worktree, project-root, or an existing worktree path. Omit for the project's default.",
        ),
      ),
      group: Schema.optional(described(Schema.String, "Custom sidebar group to file it under.")),
      tag: Schema.optional(
        described(
          Schema.Array(Schema.String),
          "People to tag on the session, by email or T3 user id; they see it in their sidebar.",
        ),
      ),
      parent: Schema.optional(
        described(Schema.String, "A session to file the new one under, as a child."),
      ),
      waitFor: Schema.optional(
        described(
          Schema.Literals(["started", "first-reply"]),
          "started (the default) returns at once; first-reply waits for the first answer, question or failure.",
        ),
      ),
      timeoutSeconds: Schema.optional(
        described(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 })),
          "For waitFor: first-reply, the longest wait. Defaults to 50; most clients stop a call after 60 seconds.",
        ),
      ),
      clientRequestId: Schema.optional(
        described(
          Schema.String,
          "Your own id for this start, so a retry with the same id returns the same session.",
        ),
      ),
      ...format,
    }),
    success: AgentToolResult,
    failure: AgentToolFailure,
    dependencies: [
      ...dependencies,
      ProjectionSnapshotQuery,
      TurnStartBootstrap,
      ServerConfig,
      GitWorkflowService,
      ServerSettingsService,
      ProviderRegistry,
    ],
  }).annotate(Tool.Title, "Start a session"),
);

export const SendMessageTool = changing(
  Tool.make("t3_send_message", {
    description:
      "Send a message to a session. When it is busy, ifBusy decides: queue (the default) runs it after the current turn, steer adds it to the current turn, interrupt stops the turn and starts this one. When the session waits on a question or approval, the tool refuses and points to t3_answer, so an open question is never lost; pass force: true to send anyway.",
    parameters: Schema.Struct({
      session: sessionRef(SESSION_REF_HELP),
      message: described(Schema.String, "The message to send."),
      ifBusy: Schema.optional(
        described(
          Schema.Literals(["queue", "steer", "interrupt"]),
          "What to do when the session is working. Defaults to queue.",
        ),
      ),
      force: Schema.optional(
        described(
          Schema.Boolean,
          "Send even when a question or approval is open. Defaults to false.",
        ),
      ),
      clientRequestId: Schema.optional(
        described(
          Schema.String,
          "Your own id for this message, so a retry with the same id does not send twice.",
        ),
      ),
      ...format,
    }),
    success: AgentToolResult,
    failure: AgentToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Send to a session"),
);

export const WaitTool = readOnly(
  Tool.make("t3_wait", {
    description:
      "Wait for the next change instead of polling: a session that starts to wait on a person (question, approval, plan), finishes, or fails. Returns at the first match or at the timeout, with a cursor; pass the cursor to the next call so no change is missed. Watches every session you can see, or only the ones you name.",
    parameters: Schema.Struct({
      sessions: Schema.optional(
        described(Schema.Array(Schema.String), `Only these sessions. ${SESSION_REF_HELP}`),
      ),
      until: Schema.optional(
        described(
          Schema.Array(Schema.Literals(["needs-human", "finished", "failed"])),
          "Which changes end the wait. Defaults to all three.",
        ),
      ),
      timeoutSeconds: Schema.optional(
        described(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 })),
          "Longest wait. Defaults to 50: most clients stop a call after 60 seconds, so use more only with a client that allows long calls.",
        ),
      ),
      cursor: Schema.optional(
        described(Schema.String, "The cursor from the previous t3_wait or t3_inbox result."),
      ),
      ...format,
    }),
    success: AgentToolResult,
    failure: AgentToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Wait for a change"),
);

export const AgentToolkit = Toolkit.make(
  WhoamiTool,
  InboxTool,
  AnswerTool,
  FindSessionsTool,
  SessionBriefTool,
  StartSessionTool,
  SendMessageTool,
  WaitTool,
);

export const AGENT_TOOL_NAMES = Object.keys(AgentToolkit.tools);
