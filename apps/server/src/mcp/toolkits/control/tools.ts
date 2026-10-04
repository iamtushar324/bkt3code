/**
 * T3-CUSTOM(expbkt3): Tool definitions for the experimental T3 MCP control
 * plane. Kept separate from upstream MCP toolkits for clean merges.
 */
import {
  ModelSelection,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderUserInputAnswers,
  ProjectScript,
  RuntimeMode,
  ServerSettingsPatch,
  ProjectThreadCreationDefaults,
  ThreadId,
  ThreadPriority,
  WorktreeBaseRef,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { ThreadExecutionSupervisor } from "../../../execution/ThreadExecutionSupervisor.ts";
import { ClerkDirectory } from "../../../auth/ClerkDirectory.ts";
import { ServerConfig } from "../../../config.ts";
import { OrchestrationCommandDispatcher } from "../../../orchestration/dispatchCommand.ts";
import { OrchestrationAccessControl } from "../../../orchestration/Services/AccessControl.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  PlannotatorManager,
  PlannotatorPlanFormat,
} from "../../../plannotator/PlannotatorManager.ts";
// T3-CUSTOM(expbkt3): agent-rendered UI surfaces in chat.
import { AgentUiService } from "../../../agentui/AgentUiService.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export class T3ControlToolError extends Schema.TaggedError<T3ControlToolError>()(
  "T3ControlToolError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery,
  OrchestrationCommandDispatcher,
  OrchestrationAccessControl,
  ThreadExecutionSupervisor,
  Crypto.Crypto,
];
const plannotatorDependencies = [...dependencies, PlannotatorManager];
const agentUiDependencies = [...dependencies, AgentUiService];
const configurationDependencies = [...dependencies, ProviderRegistry, ServerSettingsService];
const ownershipDependencies = [ClerkDirectory, ServerConfig];
const projectDependencies = [
  ...dependencies,
  ...ownershipDependencies,
  Path.Path,
  WorkspacePaths.WorkspacePaths,
];
const sessionDependencies = [...dependencies, ...ownershipDependencies];

const described = <S extends Schema.Top>(schema: S, description: string): S =>
  schema.annotate({ description }) as S;

const optionalSessionId = {
  sessionId: Schema.optional(ThreadId).pipe(
    Schema.annotateKey({
      description:
        "T3 session/thread ID. User-bound agents may target any accessible session or omit this for their current session.",
    }),
  ),
};

const readonlyTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true) as T;

const mutatingTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.Readonly, false).annotate(Tool.Destructive, true) as T;

export const T3ListSessionsTool = readonlyTool(
  Tool.make("t3_list_sessions", {
    description:
      "List T3 Code sessions with project, model, mode, live execution state, human-attention reasons, rolling catch-up summary, and latest turn summary. User-bound agents see every session accessible to that user; external operators see all sessions.",
    parameters: Schema.Struct({
      includeArchived: Schema.optional(
        described(
          Schema.Boolean,
          "Include archived sessions accessible to the caller. External operators may access every archived session.",
        ),
      ),
      attentionOnly: Schema.optional(
        described(
          Schema.Boolean,
          "When true, return only sessions currently requiring human attention.",
        ),
      ),
      limit: Schema.optional(
        described(Schema.Int, "Maximum sessions to return, from 0 through 500. Defaults to 100."),
      ),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies,
  }).annotate(Tool.Title, "List T3 sessions"),
);

export const T3GetSessionTool = readonlyTool(
  Tool.make("t3_get_session", {
    description:
      "Inspect an accessible T3 Code session deeply: metadata, live execution, recent messages, activities, proposed plans, checkpoints, and catch-up summaries. Omit sessionId for the caller's current session.",
    parameters: Schema.Struct({
      ...optionalSessionId,
      messageLimit: Schema.optional(
        described(Schema.Int, "Maximum recent messages to include, capped at 200. Defaults to 30."),
      ),
      activityLimit: Schema.optional(
        described(
          Schema.Int,
          "Maximum recent activity records to include, capped at 300. Defaults to 50.",
        ),
      ),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies,
  }).annotate(Tool.Title, "Inspect T3 session"),
);

export const T3ListProjectsTool = readonlyTool(
  Tool.make("t3_list_projects", {
    description:
      "List T3 Code projects/workspaces, including IDs, roots, repository identity, default model, scripts, and active session counts. Use a projectId when creating a session.",
    parameters: Schema.Struct({
      includeArchived: Schema.optional(
        described(
          Schema.Boolean,
          "Include projects that currently appear only in archived sessions and are accessible to the caller.",
        ),
      ),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies,
  }).annotate(Tool.Title, "List T3 projects"),
);

export const T3SendPromptTool = mutatingTool(
  Tool.make("t3_send_prompt", {
    description:
      "Send or steer a prompt in a T3 Code session through the same durable orchestration path as the UI. Optionally change the model, sandbox/runtime mode, or plan/default interaction mode for this turn.",
    parameters: Schema.Struct({
      ...optionalSessionId,
      prompt: described(
        Schema.String,
        "The user message to send. State the desired outcome and any constraints clearly.",
      ),
      modelSelection: Schema.optional(ModelSelection).pipe(
        Schema.annotateKey({
          description:
            "Optional provider instance, model slug, and model options for this turn. Discover valid values with t3_get_configuration.",
        }),
      ),
      runtimeMode: Schema.optional(
        described(
          RuntimeMode,
          "Optional execution/sandbox mode for this turn, including full-access where supported.",
        ),
      ),
      interactionMode: Schema.optional(
        described(
          ProviderInteractionMode,
          "Optional interaction mode for this turn: plan for planning only, or default for implementation.",
        ),
      ),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies,
  }).annotate(Tool.Title, "Send T3 prompt"),
);

export const T3UpdateSessionTool = mutatingTool(
  Tool.make("t3_update_session", {
    description:
      "Update T3 session metadata and defaults. Supports title, Linear issue tag, model selection, runtime/sandbox mode, interaction mode (plan/default), and branch. Only supplied fields change. Use it to name the session once you know what the work is, and to tag the Linear ticket it belongs to; pull requests are tagged separately with link_pull_request.",
    parameters: Schema.Struct({
      ...optionalSessionId,
      title: Schema.optional(
        described(
          Schema.String,
          "New concise session title. Keep it aligned with the session's current objective.",
        ),
      ),
      modelSelection: Schema.optional(ModelSelection).pipe(
        Schema.annotateKey({
          description:
            "New default provider instance, model slug, and model options. Discover valid values with t3_get_configuration.",
        }),
      ),
      runtimeMode: Schema.optional(
        described(RuntimeMode, "New default execution/sandbox mode for future turns."),
      ),
      interactionMode: Schema.optional(
        described(
          ProviderInteractionMode,
          "New default interaction mode: plan for planning only, or default for implementation.",
        ),
      ),
      branch: Schema.optional(
        described(
          Schema.NullOr(Schema.String),
          "New source-control branch metadata, or null to clear it.",
        ),
      ),
      // T3-CUSTOM(expbkt3): session priority.
      priority: Schema.optional(
        described(
          Schema.NullOr(ThreadPriority),
          "New session priority: 0 (P0, highest) through 4 (P4, lowest), or null to clear it.",
        ),
      ),
      // T3-CUSTOM(expbkt3): the Linear ticket this session answers to.
      linearIssueUrl: Schema.optional(
        described(
          Schema.NullOr(Schema.String),
          "Linear issue URL to tag this session with, for example https://linear.app/acme/issue/ENG-42, or null to clear the tag. The key and its live status then appear beside the session in the sidebar. Only linear.app issue URLs are accepted.",
        ),
      ),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies,
  }).annotate(Tool.Title, "Update T3 session"),
);

export const T3SessionActionTool = mutatingTool(
  Tool.make("t3_session_action", {
    description:
      "Perform a lifecycle action on a T3 session: interrupt the active turn, stop/restart its provider, archive/unarchive, settle/activate, snooze/unsnooze, delete, request a fresh catch-up summary, or request a fresh work summary and progress estimate.",
    parameters: Schema.Struct({
      ...optionalSessionId,
      action: described(
        Schema.Literals([
          "interrupt",
          "stop",
          "restart",
          "archive",
          "unarchive",
          "settle",
          "activate",
          "snooze",
          "unsnooze",
          "delete",
          "request-catchup",
          "request-work-summary",
        ]),
        "Lifecycle action to perform. delete is irreversible; snooze additionally requires snoozedUntil.",
      ),
      snoozedUntil: Schema.optional(
        described(
          Schema.String,
          "ISO-8601 wake time required for the snooze action, for example 2026-07-27T09:00:00.000Z.",
        ),
      ),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies,
  }).annotate(Tool.Title, "Control T3 session lifecycle"),
);

export const T3RespondApprovalTool = mutatingTool(
  Tool.make("t3_respond_approval", {
    description:
      "Resolve a pending provider approval in a T3 session. Obtain requestId and allowed decisions from t3_get_session before responding.",
    parameters: Schema.Struct({
      ...optionalSessionId,
      requestId: described(
        Schema.String,
        "Pending approval request ID obtained from t3_get_session.",
      ),
      decision: described(
        ProviderApprovalDecision,
        "One of the exact decisions allowed by the pending approval request.",
      ),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies,
  }).annotate(Tool.Title, "Respond to T3 approval"),
);

export const T3RespondUserInputTool = mutatingTool(
  Tool.make("t3_respond_user_input", {
    description:
      "Answer a pending structured user-input request in a T3 session. Obtain requestId and question IDs/options from t3_get_session.",
    parameters: Schema.Struct({
      ...optionalSessionId,
      requestId: described(
        Schema.String,
        "Pending user-input request ID obtained from t3_get_session.",
      ),
      answers: described(
        ProviderUserInputAnswers,
        "Answers keyed by the exact question IDs returned by t3_get_session.",
      ),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies,
  }).annotate(Tool.Title, "Answer T3 user input"),
);

export const T3CreateProjectTool = mutatingTool(
  Tool.make("t3_create_project", {
    description:
      "Register a workspace as a T3 Code project so an external operator can bootstrap a fresh server before creating sessions. The workspace must already be a directory unless createWorkspaceRootIfMissing is explicitly enabled. Reusing an active workspace returns that project instead of creating a duplicate.",
    parameters: Schema.Struct({
      workspaceRoot: described(
        Schema.String,
        "Absolute workspace directory or a path supported by this T3 host, such as ~/repos/example.",
      ),
      title: Schema.optional(
        described(
          Schema.String,
          "Concise project title. Defaults to the normalized workspace directory name.",
        ),
      ),
      createWorkspaceRootIfMissing: Schema.optional(
        described(
          Schema.Boolean,
          "Create the directory recursively when it does not exist. Defaults to false.",
        ),
      ),
      defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)).pipe(
        Schema.annotateKey({
          description:
            "Optional project default provider/model selection, or null to inherit the server default. Discover valid values with t3_get_configuration.",
        }),
      ),
      threadCreationDefaults: Schema.optional(ProjectThreadCreationDefaults).pipe(
        Schema.annotateKey({
          description:
            "Optional per-project location, base-ref, runtime, and interaction defaults. Null fields inherit app defaults.",
        }),
      ),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies: projectDependencies,
  })
    .annotate(Tool.Title, "Create T3 project")
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

export const T3UpdateProjectTool = mutatingTool(
  Tool.make("t3_update_project", {
    description:
      "Update an existing T3 project, including its default agent model, new-thread creation defaults, and project actions. External operators only; omitted fields remain unchanged.",
    parameters: Schema.Struct({
      projectId: described(Schema.String, "Target project ID obtained from t3_list_projects."),
      title: Schema.optional(described(Schema.String, "Optional replacement project title.")),
      defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)).pipe(
        Schema.annotateKey({
          description:
            "Optional project agent model/options override, or null to inherit the app default.",
        }),
      ),
      threadCreationDefaults: Schema.optional(ProjectThreadCreationDefaults).pipe(
        Schema.annotateKey({
          description:
            "Optional per-project location, base-ref, runtime, and interaction defaults. Null fields inherit app defaults.",
        }),
      ),
      scripts: Schema.optional(Schema.Array(ProjectScript)).pipe(
        Schema.annotateKey({
          description:
            "Optional complete project-action list. At most one action should enable runOnWorktreeCreate.",
        }),
      ),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies,
  }).annotate(Tool.Title, "Update T3 project"),
);

export const T3CreateSessionTool = mutatingTool(
  Tool.make("t3_create_session", {
    description:
      "Create a user-owned T3 Code session in an accessible project and optionally start its first prompt. Available to user-bound provider sessions, personal external users, and external operators. The new session is tagged with your session's audience — its owner and everyone tagged on it — so delegated work stays visible to the people who asked for it; override with tagUserIds or inheritParentTags.",
    parameters: Schema.Struct({
      projectId: described(Schema.String, "Target project ID obtained from t3_list_projects."),
      title: Schema.optional(
        described(Schema.String, "Concise initial session title. Inferred from prompt if omitted."),
      ),
      prompt: Schema.optional(
        described(
          Schema.String,
          "Optional first user message. When present, starts the first turn.",
        ),
      ),
      modelSelection: Schema.optional(ModelSelection).pipe(
        Schema.annotateKey({
          description:
            "Initial provider instance, model slug, and model options. Discover valid values with t3_get_configuration.",
        }),
      ),
      runtimeMode: Schema.optional(
        described(RuntimeMode, "Initial execution/sandbox mode. Defaults to full-access."),
      ),
      interactionMode: Schema.optional(
        described(ProviderInteractionMode, "Initial plan or default interaction mode."),
      ),
      branch: Schema.optional(
        described(Schema.NullOr(Schema.String), "Optional source-control branch metadata."),
      ),
      worktreePath: Schema.optional(
        described(
          Schema.NullOr(Schema.String),
          "Optional existing worktree path. Omit to inherit the calling session's workspace; see workspace.",
        ),
      ),
      workspace: Schema.optional(
        described(
          Schema.Union([
            Schema.Struct({ mode: Schema.Literal("local") }),
            Schema.Struct({
              mode: Schema.Literal("existing-worktree"),
              path: Schema.String,
              branch: Schema.optional(Schema.String),
            }),
            Schema.Struct({
              mode: Schema.Literal("new-worktree"),
              baseRef: Schema.optional(WorktreeBaseRef),
              newBranch: Schema.optional(Schema.String),
            }),
          ]),
          // T3-CUSTOM(expbkt3): the default is now inherited from the calling
          // session, so this description is the only place a calling model
          // learns how to ask for an isolated tree.
          "Optional workspace override. Omit and the new session works where yours does: your own worktree when it targets your repository, otherwise one worktree shared by every session you create in that repository. Pass {mode: 'new-worktree'} when this session needs a tree of its own — for example when several children will edit the same repository in parallel.",
        ),
      ),
      // T3-CUSTOM(expbkt3): session priority.
      priority: Schema.optional(
        described(
          ThreadPriority,
          "Optional session priority: 0 (P0, highest) through 4 (P4, lowest). Omit to leave the session unprioritised.",
        ),
      ),
      // T3-CUSTOM(expbkt3): BEGIN — session lineage. The description is
      // load-bearing: it is the only guidance the calling model receives about
      // when nesting is the wrong choice.
      createAsChild: Schema.optional(
        described(
          Schema.Boolean,
          "Whether this session is filed under yours in the sidebar. Defaults to true, so work you fan out stays visible as your subtree. Pass false when the new session is independent work that should stand on its own at the top level.",
        ),
      ),
      parentSessionId: Schema.optional(
        described(
          Schema.String,
          "Optional explicit parent session ID, for building a tree you are not the root of. Defaults to the calling session. Cannot be combined with createAsChild: false.",
        ),
      ),
      // T3-CUSTOM(expbkt3): END
      // T3-CUSTOM(expbkt3): BEGIN — inherited tagging. The default is
      // inheritance, so these two only exist for the cases where the new
      // session's audience genuinely differs from the calling session's.
      tagUserIds: Schema.optional(
        described(
          Schema.Array(Schema.String),
          "Users to tag on the new session, as T3 user IDs or email addresses. Replaces the tags inherited from your session unless you also pass inheritParentTags: true. Tagged users see the session in their own sidebar.",
        ),
      ),
      inheritParentTags: Schema.optional(
        described(
          Schema.Boolean,
          "Whether the new session inherits your session's audience — its owner plus everyone tagged on it. Defaults to true so delegated work stays visible to the people who asked for it. Pass false to keep the session to yourself, or combine with tagUserIds to add people on top of the inherited set.",
        ),
      ),
      // T3-CUSTOM(expbkt3): END
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies: sessionDependencies,
  }).annotate(Tool.Title, "Create T3 session"),
);

export const T3DispatchCommandTool = mutatingTool(
  Tool.make("t3_dispatch_command", {
    description:
      "External-operator escape hatch for advanced T3 automation. Dispatch any validated OrchestrationCommand through T3's durable command gate. Not available to an in-session agent; prefer the focused tools whenever possible.",
    parameters: Schema.Struct({
      // Schema.Unknown drops a schema-level description in the generated JSON
      // schema, so annotate the key instead — the agent needs to be told what
      // to pass here.
      command: Schema.Unknown.pipe(
        Schema.annotateKey({
          description:
            "A complete OrchestrationCommand object conforming to the current T3 contracts schema.",
        }),
      ),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies,
  }).annotate(Tool.Title, "Dispatch advanced T3 command"),
);

export const T3SubmitPlanTool = mutatingTool(
  Tool.make("t3_submit_plan", {
    description:
      "Submit a Markdown or HTML plan to an accessible T3 Code session and start a dedicated Plannotator review gate. The plan becomes the session's actionable proposed plan, annotations are sent back to its planning agent, and approval starts implementation through T3's normal durable turn path.",
    parameters: Schema.Struct({
      ...optionalSessionId,
      format: described(
        PlannotatorPlanFormat,
        "Plan document type: md for Markdown or html for a self-contained HTML plan.",
      ),
      content: described(
        Schema.String,
        "Complete plan document, up to 2 MiB. It is stored privately and opened in a review gate.",
      ),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies: [...plannotatorDependencies, ServerSettingsService],
  }).annotate(Tool.Title, "Submit plan for Plannotator review"),
);

export const T3ListPlannotatorReviewsTool = readonlyTool(
  Tool.make("t3_list_plannotator_reviews", {
    description:
      "List durable Plannotator review gates with their T3 session, plan, stable proxy URL, process state, decision, feedback, cumulative annotation history, and diagnostic paths. User-bound agents may inspect reviews for accessible sessions; external operators may inspect all reviews.",
    parameters: Schema.Struct({
      ...optionalSessionId,
      plannotatorSessionId: Schema.optional(
        described(Schema.String, "Optional Plannotator review ID returned by t3_submit_plan."),
      ),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies: plannotatorDependencies,
  }).annotate(Tool.Title, "List Plannotator reviews"),
);

export const T3GetConfigurationTool = readonlyTool(
  Tool.make("t3_get_configuration", {
    description:
      "Discover T3 Code's redacted server configuration and live provider catalog, including enabled provider instances, installed/auth status, model slugs, model capabilities/options, and the current text-generation default. Secrets and the external MCP API key are never returned.",
    parameters: Schema.Struct({
      refreshProviders: Schema.optional(
        described(
          Schema.Boolean,
          "Refresh provider install/auth/model status before returning. Defaults to false for a fast cached response.",
        ),
      ),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies: configurationDependencies,
  }).annotate(Tool.Title, "Get T3 configuration and model catalog"),
);

export const T3UpdateServerSettingsTool = mutatingTool(
  Tool.make("t3_update_server_settings", {
    description:
      "External-operator-only settings control. Apply a validated server settings patch through the same persistence service as the UI. Use t3_get_configuration first. The result is redacted, and rotating or disabling external MCP access can immediately invalidate this credential.",
    parameters: Schema.Struct({
      patch: described(
        ServerSettingsPatch,
        "Validated partial ServerSettings update. Only included fields change.",
      ),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies: configurationDependencies,
  }).annotate(Tool.Title, "Update T3 server settings"),
);

// T3-CUSTOM(expbkt3): BEGIN — session lineage as an explicit pair of verbs.
// One tri-state field would be terser, but an agent reorganising a workspace
// has to be able to reach "detach" without emitting a literal null, and a tool
// named for what it does is far likelier to be picked correctly.
export const T3LinkSessionTool = mutatingTool(
  Tool.make("t3_link_session", {
    description:
      "File one T3 session under another, so it renders nested beneath its parent in the sidebar. Use this to organise related work — for example, grouping sessions you fanned out across repositories under the session coordinating them, including sessions running on other machines. The session's own children move with it. Lineage must stay a tree: a session cannot be filed under itself or under any of its own descendants.",
    parameters: Schema.Struct({
      sessionId: described(Schema.String, "Session to move."),
      parentSessionId: described(
        Schema.String,
        "Session it should be filed under. Must not be the session itself or one of its descendants.",
      ),
      parentEnvironmentId: Schema.optional(
        described(
          Schema.String,
          "Environment the parent session lives on. Omit when it is on this one, which is the usual case; pass it to file a session under work running on another machine.",
        ),
      ),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies,
  }).annotate(Tool.Title, "Link T3 session to a parent"),
);

export const T3UnlinkSessionTool = mutatingTool(
  Tool.make("t3_unlink_session", {
    description:
      "Detach a T3 session from its parent so it returns to the top level of the sidebar. Its own child sessions stay attached to it and move with it. Safe to call on a session that already has no parent.",
    parameters: Schema.Struct({
      sessionId: described(Schema.String, "Session to detach from its parent."),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies,
  }).annotate(Tool.Title, "Unlink T3 session from its parent"),
);
// T3-CUSTOM(expbkt3): END

// T3-CUSTOM(expbkt3): BEGIN — agent-rendered UI surfaces in chat.
//
// Named to stay clear of the provider adapters' substring classifier: anything
// containing "create", "file", "agent" or "command" would be tagged as a file
// change or subagent row instead of an MCP tool call.
export const T3ShowUiTool = readonlyTool(
  Tool.make("t3_show_ui", {
    description:
      "Render an interactive view inside the chat transcript: a sandboxed box the user sees inline, right where the tool call happened. Pass a self-contained HTML document in `html` (inline <style> and <script> both run, no network access as the app) or an absolute https URL in `url` to embed a page. Use it for charts, diagrams, tables, dashboards, forms, canvases, and previews — anything clearer seen than described. Each call renders one new box; call it again to show an updated view. Scripts run in a sandbox with an opaque origin, so the document cannot reach T3 Code, its cookies, or the network as the user.",
    parameters: Schema.Struct({
      title: described(
        Schema.String,
        "Short label shown on the box, e.g. 'Latency by endpoint' or 'Migration plan'.",
      ),
      html: Schema.optional(
        described(
          Schema.String,
          "A self-contained HTML document or fragment. Inline CSS and JS are allowed and run sandboxed; external assets are not fetched. Mutually exclusive with `url`.",
        ),
      ),
      url: Schema.optional(
        described(
          Schema.String,
          "Absolute https:// URL to embed instead of inline HTML. Mutually exclusive with `html`.",
        ),
      ),
      height: Schema.optional(
        described(Schema.Int, "Box height in pixels, from 120 through 900. Defaults to 360."),
      ),
    }),
    success: Schema.Unknown,
    failure: T3ControlToolError,
    dependencies: agentUiDependencies,
  }).annotate(Tool.Title, "Show a view in chat"),
);
// T3-CUSTOM(expbkt3): END

export const T3ControlToolkit = Toolkit.make(
  T3ListSessionsTool,
  T3GetSessionTool,
  T3ListProjectsTool,
  T3GetConfigurationTool,
  T3SendPromptTool,
  T3UpdateSessionTool,
  T3UpdateServerSettingsTool,
  T3SessionActionTool,
  T3RespondApprovalTool,
  T3RespondUserInputTool,
  T3CreateProjectTool,
  T3UpdateProjectTool,
  T3CreateSessionTool,
  // T3-CUSTOM(expbkt3): session lineage.
  T3LinkSessionTool,
  T3UnlinkSessionTool,
  T3SubmitPlanTool,
  T3ListPlannotatorReviewsTool,
  T3DispatchCommandTool,
  // T3-CUSTOM(expbkt3): agent-rendered UI surfaces in chat.
  T3ShowUiTool,
);
