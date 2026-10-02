/**
 * T3-CUSTOM(expbkt3): Implementation of external-operator and provider-scoped
 * T3 control tools. Capability checks remain local to this dedicated toolkit.
 */
import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  OrchestrationProposedPlanId,
  OrchestrationCommand as OrchestrationCommandSchema,
  ProjectId,
  EnvironmentId,
  ThreadId,
  UserId,
  // T3-CUSTOM(expbkt3): review comments on assistant messages in chat.
  ThreadCommentId,
  type ThreadComment,
  normalizeThreadCustomGroup,
  THREAD_CUSTOM_GROUP_MAX_LENGTH,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  // T3-CUSTOM(expbkt3): saved new-thread defaults for created sessions.
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerSettings,
} from "@t3tools/contracts";
import { parseLinearIssueUrl } from "@t3tools/shared/linearIssue";
// T3-CUSTOM(expbkt3): saved new-thread defaults for created sessions.
import { resolveNewThreadDefaults } from "@t3tools/shared/newThreadDefaults.expbkt3";
import {
  clearProjectSettingsOverrides,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ClerkDirectory } from "../../../auth/ClerkDirectory.ts";
import { ServerConfig } from "../../../config.ts";
import { GitWorkflowService } from "../../../git/GitWorkflowService.ts";
import { TurnStartBootstrap } from "../../../orchestration/turnStartBootstrap.expbkt3.ts";
import { resolveParentWorkspaceInheritance } from "../../../workspace-groups/parentWorkspaceInheritance.ts";
import { OrchestrationAccessControl } from "../../../orchestration/Services/AccessControl.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
// T3-CUSTOM(expbkt3): agent-rendered UI surfaces in chat.
import { AgentUiService } from "../../../agentui/AgentUiService.ts";
// T3-CUSTOM(expbkt3): review comments on assistant messages in chat.
import { ThreadCommentsService } from "../../../threadcomments/ThreadCommentsService.ts";
// T3-CUSTOM(expbkt3): user presence for agents deciding how to reach the human.
import { resolvePresenceTarget } from "../../../presence/presenceTarget.ts";
import { UserPresenceService } from "../../../presence/UserPresenceService.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { redactServerSettingsForClient, ServerSettingsService } from "../../../serverSettings.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { hasUserWideScope, resolveMcpSessionTarget } from "../../mcpSessionTarget.ts";
import { T3ControlToolkit, T3ControlToolError } from "./tools.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommandSchema);
// T3-CUSTOM(expbkt3): review comments on assistant messages in chat.
const decodeThreadCommentId = Schema.decodeEffect(ThreadCommentId);

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isSafeInteger(value)) return fallback;
  return Math.max(0, Math.min(value, maximum));
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return "T3 Code could not complete the requested operation.";
}

// T3-CUSTOM(expbkt3): the agent-facing shape of a review comment: the quote
// and what the user wants, without anchor offsets or author ids.
function describeComment(comment: ThreadComment) {
  return {
    id: comment.commentId,
    number: comment.number,
    kind: comment.kind,
    status: comment.status,
    messageId: comment.anchor.messageId,
    quote: comment.anchor.text,
    body: comment.body,
    author: comment.authorLabel,
    createdAt: comment.createdAt,
    replies: comment.replies.map((reply) => ({
      author: reply.author,
      body: reply.body,
      createdAt: reply.createdAt,
    })),
  };
}

const mapControlError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, T3ControlToolError, R> =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new T3ControlToolError({
            operation,
            message: errorMessage(cause),
          }),
      ),
    );

const requireCapability = Effect.fn("T3ControlToolkit.requireCapability")(function* (
  operation: string,
  capability: McpInvocationContext.McpCapability,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has(capability)) {
    return yield* new T3ControlToolError({
      operation,
      message: `This MCP credential does not grant ${capability}.`,
    });
  }
  return scope;
});

const requireExternalOperator = Effect.fn("T3ControlToolkit.requireExternalOperator")(function* (
  operation: string,
) {
  const scope = yield* requireCapability(operation, "t3.control");
  if (!McpInvocationContext.isExternalMcpOperator(scope)) {
    return yield* new T3ControlToolError({
      operation,
      message: "This operation requires the Settings-issued external operator credential.",
    });
  }
  return scope;
});

const requireSessionCreator = Effect.fn("T3ControlToolkit.requireSessionCreator")(function* (
  operation: string,
) {
  const scope = yield* requireCapability(operation, "t3.control");
  if (!McpInvocationContext.canCreateMcpSessions(scope)) {
    return yield* new T3ControlToolError({
      operation,
      message:
        "Creating sessions requires an authenticated user-bound provider session, personal external token, or external operator credential.",
    });
  }
  return scope;
});

/**
 * T3-CUSTOM(expbkt3): decide which session a newly created session is filed
 * under.
 *
 * Nesting is the agent's call. A session fanning out cross-repo work wants its
 * children visible as a subtree; a session that incidentally files unrelated
 * work does not, and burying that session inside an unrelated tree is worse
 * than leaving it flat.
 *
 *   createAsChild === false        → root session
 *   parentSessionId given          → that session, after existence + access
 *   caller is a provider session   → the calling session
 *   otherwise                      → root session
 *
 * The principal check is load-bearing independently of the flag: an
 * external-user token has a synthetic threadId rather than a session the user
 * is working in, so defaulting to it would file every session the user creates
 * under one synthetic root.
 */
const resolveCreatedSessionParent = Effect.fn("T3ControlToolkit.resolveCreatedSessionParent")(
  function* (input: {
    readonly operation: string;
    readonly scope: McpInvocationContext.McpInvocationScope;
    readonly threads: ReadonlyArray<{ readonly id: ThreadId; readonly projectId: ProjectId }>;
    readonly createAsChild: boolean | undefined;
    readonly parentSessionId: string | undefined;
  }) {
    const { operation, scope } = input;
    // Two ways to say different things about the same field: refuse rather
    // than letting one silently win.
    if (input.parentSessionId !== undefined && input.createAsChild === false) {
      return yield* new T3ControlToolError({
        operation,
        message:
          "createAsChild: false cannot be combined with parentSessionId. Omit parentSessionId to create a top-level session.",
      });
    }
    if (input.createAsChild === false) return null;

    if (input.parentSessionId !== undefined) {
      const requestedParentId = ThreadId.make(input.parentSessionId);
      const parent = input.threads.find((candidate) => candidate.id === requestedParentId);
      // A parent the caller cannot see is reported as absent rather than
      // forbidden, matching how this handler already treats projects.
      const visible =
        parent !== undefined &&
        (McpInvocationContext.isExternalMcpOperator(scope) ||
          scope.actorUserId === null ||
          (yield* (yield* OrchestrationAccessControl)
            .canAccessProject(scope.actorUserId, parent.projectId)
            .pipe(mapControlError(operation))));
      if (!visible) {
        return yield* new T3ControlToolError({
          operation,
          message: `T3 session ${requestedParentId} was not found.`,
        });
      }
      return requestedParentId;
    }

    return scope.principal === "provider-session" ? scope.threadId : null;
  },
);

/**
 * T3-CUSTOM(expbkt3): resolve tag targets written as T3 user IDs or emails.
 *
 * An agent knows the humans in a session by email far more reliably than by
 * Clerk ID, so both are accepted and an unknown entry fails loudly rather than
 * silently tagging nobody.
 */
const resolveTagUserIds = Effect.fn("T3ControlToolkit.resolveTagUserIds")(function* (
  operation: string,
  entries: ReadonlyArray<string>,
) {
  const wanted = entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (wanted.length === 0) return [] as ReadonlyArray<UserId>;
  const clerkDirectory = yield* ClerkDirectory;
  const users = yield* clerkDirectory.listOrgMembers().pipe(mapControlError(operation));
  const resolved: Array<UserId> = [];
  for (const entry of wanted) {
    const match = users.find(
      (user) =>
        user.id === entry ||
        (user.email !== null && user.email.toLowerCase() === entry.toLowerCase()),
    );
    if (match === undefined) {
      return yield* new T3ControlToolError({
        operation,
        message: `'${entry}' does not match a T3 user. Pass a T3 user ID or the email address of a user in this workspace.`,
      });
    }
    resolved.push(match.id);
  }
  return Array.from(new Set(resolved)) as ReadonlyArray<UserId>;
});

/**
 * T3-CUSTOM(expbkt3): decide who a newly created session is tagged with.
 *
 * A session an agent creates is work a human asked for, so the audience of the
 * session that asked is the audience that needs to see the result: the new
 * session is born tagged with its source session's owner and everyone tagged
 * there. Without this, delegated work lands owned by whoever happened to send
 * the last prompt and disappears from every other watcher's sidebar.
 *
 *   tagUserIds given            → exactly those users (the override)
 *   tagUserIds + inherit: true  → both sets
 *   inheritParentTags: false    → nobody but the new owner
 *   otherwise                   → source owner + source tags
 *
 * The source is the calling session, and only falls back to the resolved parent
 * for callers that have no session of their own: an external-user token's
 * threadId is synthetic, so it has no audience to inherit. Following the caller
 * rather than the lineage link is deliberate — `createAsChild: false` files the
 * session at top level, but the people who asked for it still want to see it.
 *
 * The new owner is dropped from the result: ownership already implies access,
 * and the projector tags the creator on its own.
 */
const resolveCreatedSessionTags = (input: {
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly ownerUserId: UserId | null;
    readonly memberUserIds: ReadonlyArray<UserId>;
  }>;
  readonly parentThreadId: ThreadId | null;
  readonly ownerUserId: UserId | null;
  readonly explicitTagUserIds: ReadonlyArray<UserId>;
  readonly inheritParentTags: boolean | undefined;
}): ReadonlyArray<UserId> => {
  const explicit = input.explicitTagUserIds;
  const inherit = input.inheritParentTags ?? explicit.length === 0;
  const sourceThreadId =
    input.scope.principal === "provider-session" ? input.scope.threadId : input.parentThreadId;
  const source =
    inherit && sourceThreadId !== null
      ? input.threads.find((candidate) => candidate.id === sourceThreadId)
      : undefined;
  const inherited =
    source === undefined
      ? []
      : [...(source.ownerUserId === null ? [] : [source.ownerUserId]), ...source.memberUserIds];
  return Array.from(new Set([...inherited, ...explicit])).filter(
    (userId) => userId !== input.ownerUserId,
  );
};

const resolveConfiguredOwnerUserId = Effect.fn("T3ControlToolkit.resolveConfiguredOwnerUserId")(
  function* (operation: string) {
    const config = yield* ServerConfig;
    const clerkAuth = config.clerkAuth;
    if (clerkAuth === undefined) return null;

    const explicitUserId = clerkAuth.defaultOwnerUserId?.trim();
    if (explicitUserId) return UserId.make(explicitUserId);

    const defaultOwnerEmail = clerkAuth.defaultOwnerEmail?.trim();
    if (defaultOwnerEmail) {
      const clerkDirectory = yield* ClerkDirectory;
      const resolved = yield* clerkDirectory
        .findUserIdByEmail(defaultOwnerEmail)
        .pipe(mapControlError(operation));
      if (resolved !== null) return resolved;
    }

    return yield* new T3ControlToolError({
      operation,
      message:
        "Team mode requires a resolvable T3CODE_DEFAULT_OWNER_USER_ID or T3CODE_DEFAULT_OWNER_EMAIL before external MCP can create projects or ownerless sessions.",
    });
  },
);

const resolveSessionId = Effect.fn("T3ControlToolkit.resolveSessionId")(function* (
  operation: string,
  requested: ThreadId | undefined,
  capability: "t3.read" | "t3.control" | "t3.plan" = "t3.read",
) {
  // The policy itself lives in `mcpSessionTarget` so the pull-request tools
  // authorize a named session exactly the way these do.
  return yield* resolveMcpSessionTarget({ requested, capability }).pipe(
    Effect.mapError((error) => new T3ControlToolError({ operation, message: error.message })),
  );
});

// Status is derived from upstream's projected provider session and latest turn.
function sessionStatus(thread: OrchestrationThreadShell | OrchestrationThread) {
  const session = thread.session;
  return {
    status: session?.status ?? "absent",
    activeTurnId: session?.activeTurnId ?? null,
    lastError: session?.lastError ?? null,
  } as const;
}

function isRunningStatus(status: string): boolean {
  return status === "running" || status === "starting";
}

function attentionReasons(
  thread: OrchestrationThreadShell | OrchestrationThread,
): ReadonlyArray<string> {
  const reasons: Array<string> = [];
  if ("hasPendingApprovals" in thread && thread.hasPendingApprovals) {
    reasons.push("approval");
  }
  if ("hasPendingUserInput" in thread && thread.hasPendingUserInput) {
    reasons.push("user-input");
  }
  if (
    ("hasActionableProposedPlan" in thread && thread.hasActionableProposedPlan) ||
    ("proposedPlans" in thread && thread.proposedPlans.some((plan) => plan.implementedAt === null))
  ) {
    reasons.push("proposed-plan");
  }
  if (thread.session?.status === "error") reasons.push("failure");
  return reasons;
}

/**
 * T3-CUSTOM(expbkt3): an agent's custom group clears the same bar a human's
 * does: trimmed, non-empty, and short enough for a sidebar header. Undefined
 * leaves the group unchanged; null clears it.
 */
function resolveCustomGroupInput(
  operation: string,
  value: string | null | undefined,
): Effect.Effect<string | null | undefined, T3ControlToolError> {
  if (value === undefined || value === null) return Effect.succeed(value);
  const label = value.replace(/\s+/g, " ").trim();
  if (label.length === 0) {
    return Effect.fail(
      new T3ControlToolError({
        operation,
        message:
          "customGroup must not be blank. Pass a label, or null to remove the session from its group.",
      }),
    );
  }
  if (label.length > THREAD_CUSTOM_GROUP_MAX_LENGTH) {
    return Effect.fail(
      new T3ControlToolError({
        operation,
        message: `customGroup must be at most ${THREAD_CUSTOM_GROUP_MAX_LENGTH} characters; got ${label.length}.`,
      }),
    );
  }
  return Effect.succeed(label);
}

/** T3-CUSTOM(expbkt3): exact, case-insensitive custom group match. */
function matchesCustomGroupFilter(
  thread: Pick<OrchestrationThreadShell, "customGroup">,
  filter: string | undefined,
): boolean {
  if (filter === undefined) return true;
  const customGroup = thread.customGroup ?? null;
  return (
    customGroup !== null &&
    normalizeThreadCustomGroup(customGroup) === normalizeThreadCustomGroup(filter)
  );
}

function sessionSummary(
  thread: OrchestrationThreadShell,
  project:
    | {
        readonly id: string;
        readonly title: string;
        readonly workspaceRoot: string;
      }
    | undefined,
) {
  const reasons = attentionReasons(thread);
  return {
    sessionId: thread.id,
    title: thread.title,
    project: project ?? null,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    archivedAt: thread.archivedAt,
    settledAt: thread.settledAt,
    snoozedUntil: thread.snoozedUntil ?? null,
    // T3-CUSTOM(expbkt3): session priority (0 = P0 highest, null = unset).
    priority: thread.priority ?? null,
    // T3-CUSTOM(expbkt3): custom sidebar group (null = ungrouped).
    customGroup: thread.customGroup ?? null,
    // T3-CUSTOM(expbkt3): session lineage. Lets an agent inspect its own
    // subtree instead of re-spawning work it already delegated.
    parentSessionId: thread.parentThreadId ?? null,
    session: thread.session,
    ...sessionStatus(thread),
    needsHumanAttention: reasons.length > 0,
    humanAttentionReasons: reasons,
    latestTurn: thread.latestTurn,
    updatedAt: thread.updatedAt,
  };
}

function redactMcpConfiguration(settings: Parameters<typeof redactServerSettingsForClient>[0]) {
  const redacted = redactServerSettingsForClient(settings);
  return {
    ...redacted,
    experimental: {
      ...redacted.experimental,
      externalMcp: {
        ...redacted.experimental.externalMcp,
        apiKey: "",
        apiKeyConfigured: redacted.experimental.externalMcp.apiKey.length >= 24,
      },
    },
  };
}

const makeCommandId = (crypto: Crypto.Crypto, operation: string) =>
  crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => CommandId.make(`mcp:${operation}:${uuid}`)),
    mapControlError(operation),
  );

const makeMessageId = (crypto: Crypto.Crypto, operation: string) =>
  crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => MessageId.make(`mcp:${uuid}`)),
    mapControlError(operation),
  );

const handlers = {
  t3_list_sessions: Effect.fn("T3ControlToolkit.listSessions")(function* (input) {
    const operation = "list-sessions";
    const scope = yield* requireCapability(operation, "t3.read");
    const query = yield* ProjectionSnapshotQuery;
    // T3-CUSTOM(expbkt3): never materialize full message/activity history for session lists.
    const shell = yield* query.getShellSnapshot().pipe(mapControlError(operation));
    const archived =
      input.includeArchived === true && hasUserWideScope(scope)
        ? yield* query.getArchivedShellSnapshot().pipe(mapControlError(operation))
        : null;
    const threads = [...shell.threads, ...(archived?.threads ?? [])].filter(
      (thread) =>
        McpInvocationContext.isExternalMcpOperator(scope) ||
        (scope.actorUserId !== null
          ? thread.ownerUserId === scope.actorUserId ||
            thread.memberUserIds.includes(scope.actorUserId)
          : thread.id === scope.threadId),
    );
    const projects = new Map(
      [...shell.projects, ...(archived?.projects ?? [])].map((project) => [
        project.id,
        {
          id: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
        },
      ]),
    );
    // T3-CUSTOM(expbkt3): cap first, then bulk-read only catch-up fields for returned sessions.
    const selected = threads
      .filter((thread) => input.attentionOnly !== true || attentionReasons(thread).length > 0)
      // T3-CUSTOM(expbkt3): custom sidebar group facet.
      .filter((thread) => matchesCustomGroupFilter(thread, input.customGroup))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, boundedLimit(input.limit, 100, 500));
    const summaries = selected.map((thread) =>
      sessionSummary(thread, projects.get(thread.projectId)),
    );
    return {
      totals: {
        returned: summaries.length,
        attention: summaries.filter((session) => session.needsHumanAttention).length,
        running: summaries.filter((session) => isRunningStatus(session.status)).length,
      },
      sessions: summaries,
    };
  }),

  t3_get_session: Effect.fn("T3ControlToolkit.getSession")(function* (input) {
    const operation = "get-session";
    const sessionId = yield* resolveSessionId(operation, input.sessionId);
    const query = yield* ProjectionSnapshotQuery;
    const loaded = yield* query.getThreadDetailSnapshot(sessionId).pipe(mapControlError(operation));
    if (Option.isNone(loaded)) {
      return yield* new T3ControlToolError({
        operation,
        message: `T3 session ${sessionId} was not found.`,
      });
    }
    const thread = loaded.value.thread;
    const messageLimit = boundedLimit(input.messageLimit, 30, 200);
    const activityLimit = boundedLimit(input.activityLimit, 50, 300);
    return {
      snapshotSequence: loaded.value.snapshotSequence,
      thread: {
        ...thread,
        messages: thread.messages.slice(-messageLimit),
        activities: thread.activities.slice(-activityLimit),
      },
      ...sessionStatus(thread),
      humanAttentionReasons: attentionReasons(thread),
    };
  }),

  t3_list_projects: Effect.fn("T3ControlToolkit.listProjects")(function* (input) {
    const operation = "list-projects";
    const scope = yield* requireCapability(operation, "t3.read");
    const query = yield* ProjectionSnapshotQuery;
    const snapshot = yield* query.getShellSnapshot().pipe(mapControlError(operation));
    const archived =
      input.includeArchived === true && hasUserWideScope(scope)
        ? yield* query.getArchivedShellSnapshot().pipe(mapControlError(operation))
        : null;
    const actorUserId = scope.actorUserId;
    const activeCounts = new Map<string, number>();
    for (const thread of snapshot.threads) {
      activeCounts.set(thread.projectId, (activeCounts.get(thread.projectId) ?? 0) + 1);
    }
    const projects = new Map(
      [...snapshot.projects, ...(archived?.projects ?? [])]
        .filter(
          (project) =>
            McpInvocationContext.isExternalMcpOperator(scope) ||
            (actorUserId !== null
              ? project.ownerUserId === actorUserId ||
                project.memberUserIds.includes(actorUserId) ||
                snapshot.threads.some(
                  (thread) =>
                    thread.projectId === project.id &&
                    (thread.ownerUserId === actorUserId ||
                      thread.memberUserIds.includes(actorUserId)),
                )
              : snapshot.threads.some(
                  (thread) => thread.id === scope.threadId && thread.projectId === project.id,
                )),
        )
        .map((project) => [project.id, project]),
    );
    return {
      projects: [...projects.values()].map((project) => ({
        ...project,
        activeSessionCount: activeCounts.get(project.id) ?? 0,
      })),
    };
  }),

  t3_get_configuration: Effect.fn("T3ControlToolkit.getConfiguration")(function* (input) {
    const operation = "get-configuration";
    yield* requireCapability(operation, "t3.read");
    const settingsService = yield* ServerSettingsService;
    const providerRegistry = yield* ProviderRegistry;
    const [settings, providers] = yield* Effect.all([
      settingsService.getSettings,
      input.refreshProviders === true ? providerRegistry.refresh() : providerRegistry.getProviders,
    ]).pipe(mapControlError(operation));
    return {
      settings: redactMcpConfiguration(settings),
      providers,
      guidance: {
        modelSelection:
          "Use a provider instanceId and one of that provider's model slugs. Include only supported option selections.",
        runtimeMode: "Use t3_update_session or t3_send_prompt to select a runtime/sandbox mode.",
        interactionMode: "Use plan for planning-only turns and default for implementation turns.",
      },
    };
  }),

  t3_send_prompt: Effect.fn("T3ControlToolkit.sendPrompt")(function* (input) {
    const operation = "send-prompt";
    const scope = yield* requireCapability(operation, "t3.control");
    const sessionId = yield* resolveSessionId(operation, input.sessionId, "t3.control");
    const query = yield* ProjectionSnapshotQuery;
    const dispatcher = yield* TurnStartBootstrap;
    const crypto = yield* Crypto.Crypto;
    const loaded = yield* query.getThreadDetailById(sessionId).pipe(mapControlError(operation));
    if (Option.isNone(loaded)) {
      return yield* new T3ControlToolError({
        operation,
        message: `T3 session ${sessionId} was not found.`,
      });
    }
    const thread = loaded.value;
    const [commandId, messageId, createdAt] = yield* Effect.all([
      makeCommandId(crypto, operation),
      makeMessageId(crypto, operation),
      nowIso,
    ]);
    const result = yield* dispatcher
      .dispatch(
        {
          type: "thread.turn.start",
          commandId,
          threadId: sessionId,
          message: {
            messageId,
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          modelSelection: input.modelSelection ?? thread.modelSelection,
          runtimeMode: input.runtimeMode ?? thread.runtimeMode,
          interactionMode: input.interactionMode ?? thread.interactionMode,
          createdAt,
        },
        { actorUserId: scope.actorUserId },
      )
      .pipe(mapControlError(operation));
    return { accepted: true, sequence: result.sequence, sessionId, messageId, createdAt };
  }),

  t3_update_session: Effect.fn("T3ControlToolkit.updateSession")(function* (input) {
    const operation = "update-session";
    const sessionId = yield* resolveSessionId(operation, input.sessionId, "t3.control");
    const dispatcher = yield* TurnStartBootstrap;
    const crypto = yield* Crypto.Crypto;
    const createdAt = yield* nowIso;
    const results: Array<{ readonly type: string; readonly sequence: number }> = [];

    // T3-CUSTOM(expbkt3): an agent's Linear tag clears the same bar a human's
    // does. The stored URL ends up in `openExternal` on the sidebar row, so a
    // string that is not a linear.app issue never reaches the projection.
    const linearIssueUrl =
      input.linearIssueUrl === undefined || input.linearIssueUrl === null
        ? input.linearIssueUrl
        : (parseLinearIssueUrl(input.linearIssueUrl)?.url ??
          (yield* new T3ControlToolError({
            operation,
            message: `${input.linearIssueUrl} is not a Linear issue URL. Pass one like https://linear.app/acme/issue/ENG-42, or null to clear the tag.`,
          })));

    // T3-CUSTOM(expbkt3): custom sidebar group.
    const customGroup = yield* resolveCustomGroupInput(operation, input.customGroup);

    if (
      input.title !== undefined ||
      input.modelSelection !== undefined ||
      input.branch !== undefined ||
      // T3-CUSTOM(expbkt3): session priority.
      input.priority !== undefined ||
      // T3-CUSTOM(expbkt3): the Linear ticket this session answers to.
      linearIssueUrl !== undefined ||
      // T3-CUSTOM(expbkt3): custom sidebar group.
      customGroup !== undefined
    ) {
      const commandId = yield* makeCommandId(crypto, operation);
      const result = yield* dispatcher
        .dispatch({
          type: "thread.meta.update",
          commandId,
          threadId: sessionId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          // T3-CUSTOM(expbkt3): undefined leaves priority unchanged; null clears it.
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          // T3-CUSTOM(expbkt3): undefined leaves the Linear tag unchanged; null clears it.
          ...(linearIssueUrl === undefined ? {} : { linearIssueUrl }),
          // T3-CUSTOM(expbkt3): undefined leaves the custom group unchanged; null clears it.
          ...(customGroup === undefined ? {} : { customGroup }),
        })
        .pipe(mapControlError(operation));
      results.push({ type: "thread.meta.update", sequence: result.sequence });
    }
    if (input.runtimeMode !== undefined) {
      const commandId = yield* makeCommandId(crypto, operation);
      const result = yield* dispatcher
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId,
          threadId: sessionId,
          runtimeMode: input.runtimeMode,
          createdAt,
        })
        .pipe(mapControlError(operation));
      results.push({ type: "thread.runtime-mode.set", sequence: result.sequence });
    }
    if (input.interactionMode !== undefined) {
      const commandId = yield* makeCommandId(crypto, operation);
      const result = yield* dispatcher
        .dispatch({
          type: "thread.interaction-mode.set",
          commandId,
          threadId: sessionId,
          interactionMode: input.interactionMode,
          createdAt,
        })
        .pipe(mapControlError(operation));
      results.push({ type: "thread.interaction-mode.set", sequence: result.sequence });
    }
    if (results.length === 0) {
      return yield* new T3ControlToolError({
        operation,
        message: "Provide at least one session field to update.",
      });
    }
    return { updated: true, sessionId, commands: results };
  }),

  t3_update_server_settings: Effect.fn("T3ControlToolkit.updateServerSettings")(function* (input) {
    const operation = "update-server-settings";
    yield* requireExternalOperator(operation);
    const settingsService = yield* ServerSettingsService;
    const settings = yield* settingsService
      .updateSettings(input.patch)
      .pipe(mapControlError(operation));
    return {
      updated: true,
      settings: redactMcpConfiguration(settings),
      warning:
        "If this patch rotated or disabled external MCP access, use the newly configured credential for future calls.",
    };
  }),

  t3_session_action: Effect.fn("T3ControlToolkit.sessionAction")(function* (input) {
    const operation = `session-${input.action}`;
    const sessionId = yield* resolveSessionId(operation, input.sessionId, "t3.control");
    const query = yield* ProjectionSnapshotQuery;
    const dispatcher = yield* TurnStartBootstrap;
    const crypto = yield* Crypto.Crypto;
    const [commandId, createdAt] = yield* Effect.all([makeCommandId(crypto, operation), nowIso]);
    let command: OrchestrationCommand;
    switch (input.action) {
      case "interrupt":
        command = {
          type: "thread.turn.interrupt",
          commandId,
          threadId: sessionId,
          createdAt,
        };
        break;
      case "stop":
        command = {
          type: "thread.session.stop",
          commandId,
          threadId: sessionId,
          createdAt,
        };
        break;
      case "restart":
        command = {
          type: "thread.session.restart",
          commandId,
          threadId: sessionId,
          createdAt,
        };
        break;
      case "archive":
        command = { type: "thread.archive", commandId, threadId: sessionId };
        break;
      case "unarchive":
        command = { type: "thread.unarchive", commandId, threadId: sessionId };
        break;
      case "settle":
        command = { type: "thread.settle", commandId, threadId: sessionId };
        break;
      case "activate":
        command = {
          type: "thread.unsettle",
          commandId,
          threadId: sessionId,
          reason: "user",
        };
        break;
      case "snooze":
        if (input.snoozedUntil === undefined) {
          return yield* new T3ControlToolError({
            operation,
            message: "snoozedUntil is required for the snooze action.",
          });
        }
        command = {
          type: "thread.snooze",
          commandId,
          threadId: sessionId,
          snoozedUntil: input.snoozedUntil,
        };
        break;
      case "unsnooze":
        command = {
          type: "thread.unsnooze",
          commandId,
          threadId: sessionId,
          reason: "user",
        };
        break;
      case "delete":
        command = { type: "thread.delete", commandId, threadId: sessionId };
        break;
    }
    const result = yield* dispatcher.dispatch(command).pipe(mapControlError(operation));
    return { accepted: true, action: input.action, sessionId, sequence: result.sequence };
  }),

  t3_respond_approval: Effect.fn("T3ControlToolkit.respondApproval")(function* (input) {
    const operation = "respond-approval";
    const sessionId = yield* resolveSessionId(operation, input.sessionId, "t3.control");
    const dispatcher = yield* TurnStartBootstrap;
    const crypto = yield* Crypto.Crypto;
    const [commandId, createdAt] = yield* Effect.all([makeCommandId(crypto, operation), nowIso]);
    const result = yield* dispatcher
      .dispatch({
        type: "thread.approval.respond",
        commandId,
        threadId: sessionId,
        requestId: ApprovalRequestId.make(input.requestId),
        decision: input.decision,
        createdAt,
      })
      .pipe(mapControlError(operation));
    return { accepted: true, sessionId, requestId: input.requestId, sequence: result.sequence };
  }),

  t3_respond_user_input: Effect.fn("T3ControlToolkit.respondUserInput")(function* (input) {
    const operation = "respond-user-input";
    const sessionId = yield* resolveSessionId(operation, input.sessionId, "t3.control");
    const dispatcher = yield* TurnStartBootstrap;
    const crypto = yield* Crypto.Crypto;
    const [commandId, createdAt] = yield* Effect.all([makeCommandId(crypto, operation), nowIso]);
    const result = yield* dispatcher
      .dispatch({
        type: "thread.user-input.respond",
        commandId,
        threadId: sessionId,
        requestId: ApprovalRequestId.make(input.requestId),
        answers: input.answers,
        createdAt,
      })
      .pipe(mapControlError(operation));
    return { accepted: true, sessionId, requestId: input.requestId, sequence: result.sequence };
  }),

  t3_create_project: Effect.fn("T3ControlToolkit.createProject")(function* (input) {
    const operation = "create-project";
    yield* requireExternalOperator(operation);
    const query = yield* ProjectionSnapshotQuery;
    const dispatcher = yield* TurnStartBootstrap;
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const workspaceRoot = yield* workspacePaths
      .normalizeWorkspaceRoot(input.workspaceRoot, {
        createIfMissing: input.createWorkspaceRootIfMissing === true,
      })
      .pipe(mapControlError(operation));
    const shell = yield* query.getShellSnapshot().pipe(mapControlError(operation));
    const existing = shell.projects.find((project) => project.workspaceRoot === workspaceRoot);
    if (existing) {
      return {
        created: false,
        project: existing,
        guidance: "This workspace is already registered. Use its id with t3_create_session.",
      };
    }

    const uuid = yield* crypto.randomUUIDv4.pipe(mapControlError(operation));
    const projectId = ProjectId.make(`mcp-project:${uuid}`);
    const commandId = yield* makeCommandId(crypto, operation);
    const createdAt = yield* nowIso;
    const title = input.title?.trim() || path.basename(workspaceRoot) || "New MCP project";
    const ownerUserId = yield* resolveConfiguredOwnerUserId(operation);
    const result = yield* dispatcher
      .dispatch(
        {
          type: "project.create",
          commandId,
          projectId,
          title,
          workspaceRoot,
          createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing === true,
          defaultModelSelection: input.defaultModelSelection ?? null,
          createdAt,
        },
        { actorUserId: ownerUserId },
      )
      .pipe(mapControlError(operation));
    // T3-CUSTOM(expbkt3): clients read the project's override entry once the
    // legacy column is folded, so a requested default model is written there too.
    if (input.defaultModelSelection) {
      const settingsService = yield* ServerSettingsService;
      yield* settingsService
        .updateSettings({
          projectSettingsOverrides: {
            [projectId]: { defaultModelSelection: input.defaultModelSelection },
          },
        })
        .pipe(mapControlError(operation));
    }
    return {
      created: true,
      project: {
        id: projectId,
        title,
        workspaceRoot,
        defaultModelSelection: input.defaultModelSelection ?? null,
      },
      sequence: result.sequence,
      guidance: "Use this project id with t3_create_session.",
    };
  }),

  t3_update_project: Effect.fn("T3ControlToolkit.updateProject")(function* (input) {
    const operation = "update-project";
    yield* requireExternalOperator(operation);
    const query = yield* ProjectionSnapshotQuery;
    const dispatcher = yield* TurnStartBootstrap;
    const crypto = yield* Crypto.Crypto;
    const projectId = ProjectId.make(input.projectId);
    const shell = yield* query.getShellSnapshot().pipe(mapControlError(operation));
    const project = shell.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      return yield* new T3ControlToolError({
        operation,
        message: `T3 project ${projectId} was not found.`,
      });
    }
    if (
      input.title === undefined &&
      input.defaultModelSelection === undefined &&
      input.scripts === undefined
    ) {
      return yield* new T3ControlToolError({
        operation,
        message: "Provide at least one project field to update.",
      });
    }
    const commandId = yield* makeCommandId(crypto, operation);
    const result = yield* dispatcher
      .dispatch({
        type: "project.meta.update",
        commandId,
        projectId,
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        ...(input.defaultModelSelection !== undefined
          ? { defaultModelSelection: input.defaultModelSelection }
          : {}),
        ...(input.scripts !== undefined ? { scripts: input.scripts } : {}),
      })
      .pipe(mapControlError(operation));
    // T3-CUSTOM(expbkt3): BEGIN — clients read the project's override entry
    // once the server has folded the legacy column, so the default model is
    // written there as well (the legacy column above keeps un-folded hosts in
    // step). Null means inherit the host default: the override is removed.
    const settingsService = yield* ServerSettingsService;
    let settings = yield* settingsService.getSettings.pipe(mapControlError(operation));
    if (input.defaultModelSelection !== undefined) {
      const entry =
        input.defaultModelSelection === null
          ? clearProjectSettingsOverrides(settings, projectId, ["defaultModelSelection"])
          : {
              ...settings.projectSettingsOverrides[projectId],
              defaultModelSelection: input.defaultModelSelection,
            };
      settings = yield* settingsService
        .updateSettings({ projectSettingsOverrides: { [projectId]: entry } })
        .pipe(mapControlError(operation));
    }
    return {
      updated: true,
      projectId,
      sequence: result.sequence,
      defaults: {
        defaultModelSelection: resolveNewThreadDefaults(settings, projectId, {
          ...project,
          ...(input.defaultModelSelection !== undefined
            ? { defaultModelSelection: input.defaultModelSelection }
            : {}),
        }).modelSelection,
      },
    };
    // T3-CUSTOM(expbkt3): END
  }),

  // T3-CUSTOM(expbkt3): BEGIN — session lineage, editable after creation so an
  // agent can reorganise a workspace it did not lay out itself.
  t3_link_session: Effect.fn("T3ControlToolkit.linkSession")(function* (input) {
    const operation = "link-session";
    const sessionId = yield* resolveSessionId(
      operation,
      ThreadId.make(input.sessionId),
      "t3.control",
    );
    // A parent on another environment cannot be resolved here — this server has
    // never spoken to that one — so the id is taken on trust and recorded as
    // given. Clients that render the tree already handle a parent they cannot
    // see, which is the same state as a parent whose host is offline.
    const parentEnvironmentId = input.parentEnvironmentId ?? null;
    // Read access is the right bar for a local parent: the caller is not
    // changing it, only pointing at it. resolveSessionId reports an inaccessible
    // session as absent, so this leaks nothing.
    const parentSessionId =
      parentEnvironmentId === null
        ? yield* resolveSessionId(operation, ThreadId.make(input.parentSessionId), "t3.read")
        : ThreadId.make(input.parentSessionId);
    const dispatcher = yield* TurnStartBootstrap;
    const crypto = yield* Crypto.Crypto;
    const commandId = yield* makeCommandId(crypto, operation);
    // The decider owns the tree invariant, so a cycle fails here with its
    // message rather than being re-derived (and drifting) in this handler.
    const result = yield* dispatcher
      .dispatch({
        type: "thread.meta.update",
        commandId,
        threadId: sessionId,
        parentThreadId: parentSessionId,
        parentEnvironmentId:
          parentEnvironmentId === null ? null : EnvironmentId.make(parentEnvironmentId),
      })
      .pipe(mapControlError(operation));
    return {
      linked: true,
      sessionId,
      parentSessionId,
      parentEnvironmentId,
      sequence: result.sequence,
    };
  }),

  t3_unlink_session: Effect.fn("T3ControlToolkit.unlinkSession")(function* (input) {
    const operation = "unlink-session";
    const sessionId = yield* resolveSessionId(
      operation,
      ThreadId.make(input.sessionId),
      "t3.control",
    );
    const dispatcher = yield* TurnStartBootstrap;
    const crypto = yield* Crypto.Crypto;
    const commandId = yield* makeCommandId(crypto, operation);
    const result = yield* dispatcher
      .dispatch({
        type: "thread.meta.update",
        commandId,
        threadId: sessionId,
        parentThreadId: null,
        // T3-CUSTOM(expbkt3): detaching clears the environment with the id.
        parentEnvironmentId: null,
      })
      .pipe(mapControlError(operation));
    return { unlinked: true, sessionId, parentSessionId: null, sequence: result.sequence };
  }),
  // T3-CUSTOM(expbkt3): END

  t3_create_session: Effect.fn("T3ControlToolkit.createSession")(function* (input) {
    const operation = "create-session";
    const scope = yield* requireSessionCreator(operation);
    const query = yield* ProjectionSnapshotQuery;
    const dispatcher = yield* TurnStartBootstrap;
    const crypto = yield* Crypto.Crypto;
    const shell = yield* query.getShellSnapshot().pipe(mapControlError(operation));
    const projectId = ProjectId.make(input.projectId);
    const project = shell.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      return yield* new T3ControlToolError({
        operation,
        message: `T3 project ${projectId} was not found.`,
      });
    }
    if (!McpInvocationContext.isExternalMcpOperator(scope) && scope.actorUserId !== null) {
      const accessControl = yield* OrchestrationAccessControl;
      const allowed = yield* accessControl
        .canAccessProject(scope.actorUserId, projectId)
        .pipe(mapControlError(operation));
      if (!allowed) {
        return yield* new T3ControlToolError({
          operation,
          message: `T3 project ${projectId} was not found.`,
        });
      }
    }
    // T3-CUSTOM(expbkt3): session lineage.
    const parentThreadId = yield* resolveCreatedSessionParent({
      operation,
      scope,
      threads: shell.threads,
      createAsChild: input.createAsChild,
      parentSessionId: input.parentSessionId,
    });
    const uuid = yield* crypto.randomUUIDv4.pipe(mapControlError(operation));
    const sessionId = ThreadId.make(`mcp:${uuid}`);
    const ownerUserId =
      scope.actorUserId ?? project.ownerUserId ?? (yield* resolveConfiguredOwnerUserId(operation));
    // T3-CUSTOM(expbkt3): the new session inherits the calling session's audience.
    const memberUserIds = resolveCreatedSessionTags({
      scope,
      threads: shell.threads,
      parentThreadId,
      ownerUserId,
      explicitTagUserIds:
        input.tagUserIds === undefined ? [] : yield* resolveTagUserIds(operation, input.tagUserIds),
      inheritParentTags: input.inheritParentTags,
    });
    const title =
      input.title?.trim() ||
      input.prompt?.trim().split(/\s+/).slice(0, 10).join(" ").slice(0, 80) ||
      "New MCP session";
    const createdAt = yield* nowIso;
    const commandId = yield* makeCommandId(crypto, operation);
    const prompt = input.prompt?.trim();
    const messageId = prompt ? yield* makeMessageId(crypto, operation) : null;
    const explicitWorkspace =
      input.workspace ??
      (input.worktreePath
        ? {
            mode: "existing-worktree" as const,
            path: input.worktreePath,
            ...(input.branch ? { branch: input.branch } : {}),
          }
        : input.branch
          ? {
              mode: "existing-worktree" as const,
              path: project.workspaceRoot,
              branch: input.branch,
            }
          : undefined);
    // T3-CUSTOM(expbkt3): a child session works where its parent works — its
    // parent's own worktree in the same repository, otherwise one worktree
    // shared by every child of that parent in the target repository.
    const parentShell =
      parentThreadId === null
        ? null
        : (shell.threads.find((thread) => thread.id === parentThreadId) ?? null);
    const inheritance = resolveParentWorkspaceInheritance({
      hasExplicitWorkspace: explicitWorkspace !== undefined,
      parentThreadId,
      parent:
        parentShell === null
          ? null
          : {
              projectId: parentShell.projectId,
              worktreePath: parentShell.worktreePath,
              branch: parentShell.branch,
            },
      targetProjectId: projectId,
    });
    const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
      mapControlError(operation),
    );
    // T3-CUSTOM(expbkt3): every field the caller omits takes the saved
    // new-thread default — the project's override entry, then the host — the
    // same way the web's new-thread paths do.
    const defaults = resolveCreatedSessionDefaults({ settings, projectId, project, input });
    const workspace =
      explicitWorkspace ??
      (inheritance.kind === "parent-worktree"
        ? {
            mode: "existing-worktree" as const,
            path: inheritance.path,
            ...(inheritance.branch ? { branch: inheritance.branch } : {}),
          }
        : inheritance.kind === "parent-checkout" || defaults.envMode === "local"
          ? { mode: "local" as const }
          : { mode: "new-worktree" as const });
    const { modelSelection, runtimeMode, interactionMode } = defaults;
    // Upstream's bootstrap needs a concrete base branch; the caller's choice
    // wins, otherwise the branch checked out in the project root.
    const prepareWorktree =
      workspace.mode === "new-worktree"
        ? yield* Effect.gen(function* () {
            const gitWorkflow = yield* GitWorkflowService;
            const baseRef = workspace.baseRef;
            const baseBranch =
              baseRef?.kind === "branch"
                ? baseRef.branch
                : (yield* gitWorkflow.localStatus({ cwd: project.workspaceRoot })).refName;
            if (!baseBranch) {
              return yield* new T3ControlToolError({
                operation,
                message: `${project.workspaceRoot} is not on a branch a new worktree could start from. Pass workspace.baseRef.`,
              });
            }
            return {
              projectCwd: project.workspaceRoot,
              baseBranch,
              ...(workspace.newBranch ? { branch: workspace.newBranch } : {}),
              startFromOrigin: baseRef?.source !== "local",
            };
          }).pipe(mapControlError(operation))
        : undefined;
    const createThread = {
      projectId,
      title,
      modelSelection,
      runtimeMode,
      interactionMode,
      branch: workspace.mode === "existing-worktree" ? (workspace.branch ?? null) : null,
      worktreePath: workspace.mode === "existing-worktree" ? workspace.path : null,
      sourceControlProfileId: null,
      ...(ownerUserId ? { ownerUserId } : {}),
      // T3-CUSTOM(expbkt3): always stated, never omitted: the audience is
      // resolved from the calling session here, so an empty list has to read as
      // "tag nobody" rather than letting the lineage default tag the parent's.
      memberUserIds,
      createdAt,
      priority: input.priority ?? null,
      // T3-CUSTOM(expbkt3): custom sidebar group.
      customGroup: (yield* resolveCustomGroupInput(operation, input.customGroup)) ?? null,
      // T3-CUSTOM(expbkt3): session lineage.
      parentThreadId,
    } as const;
    const runSetupScript = workspace.mode === "new-worktree";
    const dispatchOptions = {
      actorUserId: ownerUserId,
      ...(inheritance.kind === "shared-group" && parentThreadId !== null
        ? { workspaceGroup: { ownerThreadId: parentThreadId, projectId } }
        : {}),
    };
    const result =
      messageId && prompt
        ? yield* dispatcher
            .dispatch(
              {
                type: "thread.turn.start",
                commandId,
                threadId: sessionId,
                message: {
                  messageId,
                  role: "user",
                  text: prompt,
                  attachments: [],
                },
                runtimeMode,
                interactionMode,
                bootstrap: {
                  createThread,
                  ...(prepareWorktree ? { prepareWorktree } : {}),
                  runSetupScript,
                },
                // T3-CUSTOM(expbkt3): when the caller did not name the session we
                // clipped one out of the prompt above. Declaring it as the seed
                // marks it replaceable, so the first turn titles the session the
                // same way it does for one started from a client. A title the
                // caller passed explicitly is theirs and is not seeded.
                ...(input.title?.trim() ? {} : { titleSeed: title }),
                createdAt,
              },
              dispatchOptions,
            )
            .pipe(mapControlError(operation))
        : yield* dispatcher
            .createThread(
              {
                create: {
                  type: "thread.create",
                  commandId,
                  threadId: sessionId,
                  ...createThread,
                },
                ...(prepareWorktree ? { prepareWorktree } : {}),
                runSetupScript,
              },
              dispatchOptions,
            )
            .pipe(mapControlError(operation));
    return {
      created: true,
      started: messageId !== null,
      sessionId,
      threadId: sessionId,
      workspace:
        workspace.mode === "existing-worktree"
          ? { mode: workspace.mode, path: workspace.path }
          : workspace.mode === "local"
            ? { mode: workspace.mode, path: project.workspaceRoot }
            : {
                mode: workspace.mode,
                ...("worktreePath" in result ? { path: result.worktreePath } : {}),
                sharedWithParent: inheritance.kind === "shared-group",
              },
      ...(messageId ? { messageId } : {}),
      // T3-CUSTOM(expbkt3): who can see this session, so the caller can say so
      // instead of guessing.
      ownerUserId,
      taggedUserIds: [...(ownerUserId ? [ownerUserId] : []), ...memberUserIds],
      sequence: result.sequence,
    };
  }),

  // T3-CUSTOM(expbkt3): the submitted document becomes the session's proposed
  // plan; native plan review ingests it from the proposed-plan event like any
  // provider-authored plan (Markdown or HTML).
  t3_submit_plan: Effect.fn("T3ControlToolkit.submitPlan")(function* (input) {
    const operation = "submit-plan";
    const sessionId = yield* resolveSessionId(operation, input.sessionId, "t3.plan");
    const query = yield* ProjectionSnapshotQuery;
    const dispatcher = yield* TurnStartBootstrap;
    const crypto = yield* Crypto.Crypto;
    const thread = yield* query.getThreadDetailById(sessionId).pipe(mapControlError(operation));
    if (Option.isNone(thread)) {
      return yield* new T3ControlToolError({
        operation,
        message: `T3 session ${sessionId} was not found.`,
      });
    }
    const [uuid, commandId, createdAt] = yield* Effect.all([
      crypto.randomUUIDv4.pipe(mapControlError(operation)),
      makeCommandId(crypto, operation),
      nowIso,
    ]);
    const planId = OrchestrationProposedPlanId.make(`mcp-plan:${uuid}`);
    const result = yield* dispatcher
      .dispatch({
        type: "thread.proposed-plan.upsert",
        commandId,
        threadId: sessionId,
        proposedPlan: {
          id: planId,
          turnId: thread.value.latestTurn?.turnId ?? null,
          planMarkdown: input.content,
          implementedAt: null,
          implementationThreadId: null,
          createdAt,
          updatedAt: createdAt,
        },
        createdAt,
      })
      .pipe(mapControlError(operation));
    return {
      accepted: true,
      sessionId,
      planId,
      format: input.format,
      sequence: result.sequence,
    };
  }),

  // T3-CUSTOM(expbkt3): BEGIN — agent-rendered UI surfaces in chat.
  //
  // Always renders into the caller's own session: the box appears where the tool
  // call appears, so there is no cross-session target to authorize.
  t3_show_ui: Effect.fn("T3ControlToolkit.showUi")(function* (input) {
    const operation = "show-ui";
    const scope = yield* requireCapability(operation, "t3.read");
    const agentUi = yield* AgentUiService;
    const handle = yield* agentUi
      .show({
        threadId: scope.threadId,
        title: input.title,
        html: input.html,
        url: input.url,
        height: input.height,
      })
      .pipe(mapControlError(operation));
    // Small and single-line on purpose: activity projection summarizes an MCP
    // result to one short line, and this handle has to survive that trip to
    // reach the chat client.
    return {
      t3UiRender: true,
      renderId: handle.renderId,
      kind: handle.kind,
      height: handle.height,
    };
  }),
  // T3-CUSTOM(expbkt3): END

  // T3-CUSTOM(expbkt3): BEGIN — review comments on assistant messages in chat.
  //
  // Both tools act on the caller's own session: comments are instructions for
  // this agent, so there is no cross-session target to authorize.
  t3_list_comments: Effect.fn("T3ControlToolkit.listComments")(function* (input) {
    const operation = "list-comments";
    const scope = yield* requireCapability(operation, "t3.read");
    const threadComments = yield* ThreadCommentsService;
    const snapshot = yield* threadComments
      .snapshot(scope.threadId)
      .pipe(mapControlError(operation));
    const status = input.status ?? "open";
    const comments = snapshot.comments.filter(
      (comment) => status === "all" || comment.status === status,
    );
    return {
      status,
      deliveryPaused: snapshot.deliveryPaused,
      count: comments.length,
      comments: comments.map(describeComment),
    };
  }),

  t3_reply_comment: Effect.fn("T3ControlToolkit.replyComment")(function* (input) {
    const operation = "reply-comment";
    const scope = yield* requireCapability(operation, "t3.read");
    const threadComments = yield* ThreadCommentsService;
    const commentId = yield* decodeThreadCommentId(input.commentId).pipe(
      mapControlError(operation),
    );
    const comment = yield* threadComments
      .agentReply({
        threadId: scope.threadId,
        commentId,
        body: input.body,
        addressed: input.addressed,
      })
      .pipe(mapControlError(operation));
    return { recorded: true, comment: describeComment(comment) };
  }),
  // T3-CUSTOM(expbkt3): END

  // T3-CUSTOM(expbkt3): BEGIN — user presence. Targets the caller's own session
  // unless a user-wide credential names one it can see.
  t3_user_presence: Effect.fn("T3ControlToolkit.userPresence")(function* (input) {
    const operation = "user-presence";
    // Own session by default, even for a user-bound credential that could
    // also name others: "is the human here?" is about the session I am in.
    const sessionId = yield* resolvePresenceTarget(input.sessionId).pipe(
      Effect.mapError((error) => new T3ControlToolError({ operation, message: error.message })),
    );
    const presence = yield* UserPresenceService;
    return yield* presence
      .report({
        threadId: sessionId,
        ...(input.userId === undefined ? {} : { userId: input.userId }),
        ...(input.email === undefined ? {} : { email: input.email }),
      })
      .pipe(mapControlError(operation));
  }),
  // T3-CUSTOM(expbkt3): END

  t3_dispatch_command: Effect.fn("T3ControlToolkit.dispatchCommand")(function* (input) {
    const operation = "dispatch-command";
    yield* requireExternalOperator(operation);
    const dispatcher = yield* TurnStartBootstrap;
    const command = yield* decodeOrchestrationCommand(input.command).pipe(
      mapControlError(operation),
    );
    const result = yield* dispatcher.dispatch(command).pipe(mapControlError(operation));
    return { accepted: true, commandType: command.type, sequence: result.sequence };
  }),
} satisfies Parameters<typeof T3ControlToolkit.toLayer>[0];

export const T3ControlToolkitHandlersLive = T3ControlToolkit.toLayer(handlers);

/** Exposed for focused authorization tests. */
// T3-CUSTOM(expbkt3): what a created session starts with when the caller
// leaves a field out: the project's override, then the host (shared resolver),
// then — for the model only — the deprecated host-wide key's decoded default,
// since a session needs some provider to start. The env mode stays null when
// no tier sets it; the caller treats that as "new worktree", as before.
function resolveCreatedSessionDefaults(options: {
  readonly settings: ServerSettings;
  readonly projectId: ProjectId;
  readonly project: LegacyProjectSettingsFields;
  readonly input: {
    readonly modelSelection?: ModelSelection | undefined;
    readonly runtimeMode?: RuntimeMode | undefined;
    readonly interactionMode?: ProviderInteractionMode | undefined;
  };
}) {
  const { settings, projectId, project, input } = options;
  const defaults = resolveNewThreadDefaults(settings, projectId, project);
  return {
    modelSelection:
      input.modelSelection ?? defaults.modelSelection ?? settings.defaultThreadModelSelection,
    runtimeMode: input.runtimeMode ?? defaults.runtimeMode,
    interactionMode: input.interactionMode ?? defaults.interactionMode,
    envMode: defaults.envMode,
  };
}

export const __testing = {
  resolveSessionId,
  // T3-CUSTOM(expbkt3): saved new-thread defaults for created sessions.
  resolveCreatedSessionDefaults,
  // T3-CUSTOM(expbkt3): caller-seam regression for bounded session list reads.
  listSessions: handlers.t3_list_sessions,
  // T3-CUSTOM(expbkt3): custom sidebar group on update and list.
  updateSession: handlers.t3_update_session,
  resolveCustomGroupInput,
  matchesCustomGroupFilter,
  // T3-CUSTOM(expbkt3): session lineage resolution for created sessions.
  resolveCreatedSessionParent,
  // T3-CUSTOM(expbkt3): inherited tagging for created sessions.
  resolveCreatedSessionTags,
  resolveTagUserIds,
  // T3-CUSTOM(expbkt3): review comments on assistant messages in chat.
  listComments: handlers.t3_list_comments,
  replyComment: handlers.t3_reply_comment,
  // T3-CUSTOM(expbkt3): user presence.
  userPresence: handlers.t3_user_presence,
};
