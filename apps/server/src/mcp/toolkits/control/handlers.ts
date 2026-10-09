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
  // T3-CUSTOM(expbkt3): the shared custom-group registry and its colours.
  isThreadCustomGroupColorId,
  ThreadCustomGroup,
  THREAD_CUSTOM_GROUP_COLOR_IDS,
  type ThreadCustomGroupColorId,
  type ThreadCustomGroupDefinition,
  type ThreadCustomGroupRegistry,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  // T3-CUSTOM(expbkt3): saved new-thread defaults for created sessions.
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  parseLinearIssueUrl,
  // T3-CUSTOM(expbkt3): Linear tags on a session.
  parseLinearLinkUrl,
  threadLinearLinks,
  type LinearLinkRef,
} from "@t3tools/shared/linearIssue";
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
import { TurnStartBootstrap } from "../../../orchestration-v2/turnStartBootstrap.expbkt3.ts";
import { resolveParentWorkspaceInheritance } from "../../../workspace-groups/parentWorkspaceInheritance.ts";
import { OrchestrationAccessControl } from "../../../orchestration-v2/Services/AccessControl.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
// T3-CUSTOM(expbkt3): agent-rendered UI surfaces in chat.
import { AgentUiService } from "../../../agentui/AgentUiService.ts";
// T3-CUSTOM(expbkt3): review comments on assistant messages in chat.
import { ThreadCommentsService } from "../../../threadcomments/ThreadCommentsService.ts";
// T3-CUSTOM(expbkt3): user presence for agents deciding how to reach the human.
import { resolvePresenceTarget } from "../../../presence/presenceTarget.ts";
import { UserPresenceService } from "../../../presence/UserPresenceService.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import { redactServerSettingsForClient, ServerSettingsService } from "../../../serverSettings.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "../../OrchestratorMcpService.ts";
import { hasUserWideScope, resolveMcpSessionTarget } from "../../mcpSessionTarget.ts";
import { T3ControlToolkit, T3ControlToolError, type T3CreateSessionTool } from "./tools.ts";
import type { Tool } from "effect/ai";

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

/** Tools that act on the caller's own session; an external caller has none. */
const requireOwnThreadId = Effect.fn("T3ControlToolkit.requireOwnThreadId")(function* (
  operation: string,
  scope: McpInvocationContext.McpInvocationScope,
) {
  if (scope.thread === undefined) {
    return yield* new T3ControlToolError({
      operation,
      message: "This tool acts on the calling T3 session, so it needs an agent running inside one.",
    });
  }
  return scope.thread.threadId;
});

const requireExternalOperator = Effect.fn("T3ControlToolkit.requireExternalOperator")(function* (
  operation: string,
) {
  const scope = yield* requireCapability(operation, "t3.control");
  if (!McpInvocationContext.isExternalMcpOperator(scope)) {
    return yield* new T3ControlToolError({
      operation,
      message:
        "This operation requires an operator: the Settings-issued external operator credential, or an MCP client approved by an administrator.",
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

    return scope.thread?.threadId ?? null;
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
  const sourceThreadId = input.scope.thread?.threadId ?? input.parentThreadId;
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

// T3-CUSTOM(expbkt3): BEGIN — Linear tags on a session.
/**
 * The session a Linear tag tool acts on. As with link_pull_request, an omitted
 * id (or the caller's own) is the calling agent's session even when its
 * credential is user-wide — an agent rarely knows its own session id. Any other
 * session is authorized exactly as the other control tools authorize it.
 */
const resolveTaggedSessionId = Effect.fn("T3ControlToolkit.resolveTaggedSessionId")(function* (
  operation: string,
  requested: ThreadId | undefined,
) {
  const scope = yield* requireCapability(operation, "t3.control");
  const own = scope.thread?.threadId;
  if (own !== undefined && (requested === undefined || requested === own)) return own;
  return yield* resolveSessionId(operation, requested, "t3.control");
});

/** Every URL as a tag, canonicalised and deduplicated; one bad URL fails the call. */
const parseLinearLinkInputs = Effect.fn("T3ControlToolkit.parseLinearLinkInputs")(function* (
  operation: string,
  urls: ReadonlyArray<string>,
) {
  const parsed = urls.map((url) => ({ url, link: parseLinearLinkUrl(url) }));
  const invalid = parsed.filter((entry) => entry.link === null).map((entry) => entry.url);
  if (invalid.length > 0) {
    return yield* new T3ControlToolError({
      operation,
      message: `${invalid.join(", ")} ${invalid.length === 1 ? "is not a Linear issue or project URL" : "are not Linear issue or project URLs"}. Pass URLs like https://linear.app/acme/issue/ENG-42 or https://linear.app/acme/project/checkout-revamp-0a1b2c3d4e5f.`,
    });
  }
  const links = new Map<string, LinearLinkRef>();
  for (const { link } of parsed) {
    if (link !== null && !links.has(link.url)) links.set(link.url, link);
  }
  return [...links.values()];
});

const readLinearLinks = Effect.fn("T3ControlToolkit.readLinearLinks")(function* (
  operation: string,
  sessionId: ThreadId,
) {
  const query = yield* ProjectionSnapshotQuery;
  const shell = yield* query.getThreadShellById(sessionId).pipe(mapControlError(operation));
  if (Option.isNone(shell)) {
    return yield* new T3ControlToolError({
      operation,
      message: `T3 session ${sessionId} was not found.`,
    });
  }
  return threadLinearLinks(shell.value);
});

const dispatchLinearChange = Effect.fn("T3ControlToolkit.dispatchLinearChange")(function* (
  operation: string,
  sessionId: ThreadId,
  change:
    | { readonly linearLinksAdd: ReadonlyArray<LinearLinkRef> }
    | { readonly linearLinksRemove: ReadonlyArray<string> },
) {
  const dispatcher = yield* TurnStartBootstrap;
  const crypto = yield* Crypto.Crypto;
  const commandId = yield* makeCommandId(crypto, operation);
  // Add and remove are applied against the stored list under the thread's
  // lock, so a concurrent tag from the sidebar or another agent is kept.
  const result = yield* dispatcher
    .dispatch({
      type: "thread.meta.update",
      commandId,
      threadId: sessionId,
      ...("linearLinksAdd" in change
        ? { linearLinksAdd: change.linearLinksAdd.map(({ url, kind }) => ({ url, kind })) }
        : { linearLinksRemove: [...change.linearLinksRemove] }),
    })
    .pipe(mapControlError(operation));
  return result.sequence;
});
// T3-CUSTOM(expbkt3): END

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
  return resolveGroupLabelInput(
    operation,
    "customGroup",
    value,
    "Pass a label, or null to remove the session from its group.",
  );
}

const isThreadCustomGroupLabel = Schema.is(ThreadCustomGroup);

/**
 * T3-CUSTOM(expbkt3): a custom group name as a client would store it:
 * single-spaced, trimmed, non-blank and short enough for a sidebar header.
 * `field` names the tool parameter in the error, `blankHint` says what to pass.
 */
function resolveGroupLabelInput(
  operation: string,
  field: string,
  value: string,
  blankHint: string,
): Effect.Effect<string, T3ControlToolError> {
  const label = value.replace(/\s+/g, " ").trim();
  if (label.length === 0) {
    return Effect.fail(
      new T3ControlToolError({
        operation,
        message: `${field} must not be blank. ${blankHint}`,
      }),
    );
  }
  if (label.length > THREAD_CUSTOM_GROUP_MAX_LENGTH) {
    return Effect.fail(
      new T3ControlToolError({
        operation,
        message: `${field} must be at most ${THREAD_CUSTOM_GROUP_MAX_LENGTH} characters; got ${label.length}.`,
      }),
    );
  }
  if (!isThreadCustomGroupLabel(label)) {
    return Effect.fail(
      new T3ControlToolError({
        operation,
        message: `${field} is not a valid custom group name.`,
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

// T3-CUSTOM(expbkt3): BEGIN — the shared custom-group registry (XFN-59).

/** Whether the caller may see `thread`: the rule t3_list_sessions applies. */
function callerSeesThread(
  scope: McpInvocationContext.McpInvocationScope,
  thread: Pick<OrchestrationThreadShell, "id" | "ownerUserId" | "memberUserIds">,
): boolean {
  return (
    McpInvocationContext.isExternalMcpOperator(scope) ||
    (scope.actorUserId !== null
      ? thread.ownerUserId === scope.actorUserId || thread.memberUserIds.includes(scope.actorUserId)
      : thread.id === scope.thread?.threadId)
  );
}

/** A colour id the registry accepts. Undefined keeps the colour; null clears it. */
function resolveGroupColorInput(
  operation: string,
  value: string | null | undefined,
): Effect.Effect<ThreadCustomGroupColorId | null | undefined, T3ControlToolError> {
  if (value === undefined || value === null) return Effect.succeed(value);
  const colorId = value.trim().toLowerCase();
  if (!isThreadCustomGroupColorId(colorId)) {
    return Effect.fail(
      new T3ControlToolError({
        operation,
        message: `'${value}' is not a custom group colour. Pass one of ${THREAD_CUSTOM_GROUP_COLOR_IDS.join(", ")}, or null to clear the colour.`,
      }),
    );
  }
  return Effect.succeed(colorId);
}

/** The sessions among `threads` filed under the group whose key is `key`. */
function sessionsInGroup<T extends Pick<OrchestrationThreadShell, "customGroup">>(
  threads: ReadonlyArray<T>,
  key: string,
): ReadonlyArray<T> {
  return threads.filter(
    (thread) =>
      thread.customGroup !== undefined &&
      thread.customGroup !== null &&
      normalizeThreadCustomGroup(thread.customGroup) === key,
  );
}

interface CustomGroupSummary {
  readonly label: string;
  readonly colorId: string | null;
  readonly registered: boolean;
  sessionCount: number;
}

/**
 * Every saved group, plus every group that exists only because a visible
 * session carries its label, sorted by label. A label-only group takes the
 * first spelling met, as the sidebar does.
 */
function describeCustomGroups(
  registry: ThreadCustomGroupRegistry,
  visibleThreads: ReadonlyArray<Pick<OrchestrationThreadShell, "customGroup">>,
): ReadonlyArray<CustomGroupSummary> {
  const groups = new Map<string, CustomGroupSummary>();
  for (const definition of Object.values(registry)) {
    groups.set(normalizeThreadCustomGroup(definition.label), {
      label: definition.label,
      colorId: definition.colorId ?? null,
      registered: true,
      sessionCount: 0,
    });
  }
  for (const thread of visibleThreads) {
    const label = thread.customGroup ?? null;
    if (label === null) continue;
    const key = normalizeThreadCustomGroup(label);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { label, colorId: null, registered: false, sessionCount: 1 });
    } else {
      group.sessionCount += 1;
    }
  }
  return [...groups.values()].toSorted((left, right) =>
    normalizeThreadCustomGroup(left.label).localeCompare(normalizeThreadCustomGroup(right.label)),
  );
}

/**
 * File each session under `customGroup` (null ungroups it). Every session is
 * dispatched on its own, so one refusal — such as a session running above the
 * caller's modes, which the orchestrator checks under the session's lock —
 * is reported in `skipped` instead of stranding the rest half-moved.
 */
const moveGroupSessions = Effect.fn("T3ControlToolkit.moveGroupSessions")(function* (
  operation: string,
  sessionIds: ReadonlyArray<ThreadId>,
  customGroup: string | null,
) {
  const dispatcher = yield* TurnStartBootstrap;
  const crypto = yield* Crypto.Crypto;
  const moved: Array<ThreadId> = [];
  const skipped: Array<{ readonly sessionId: ThreadId; readonly reason: string }> = [];
  for (const sessionId of sessionIds) {
    const commandId = yield* makeCommandId(crypto, operation);
    yield* dispatcher
      .dispatch({ type: "thread.meta.update", commandId, threadId: sessionId, customGroup })
      .pipe(
        Effect.match({
          onFailure: (cause) => {
            skipped.push({ sessionId, reason: errorMessage(cause) });
          },
          onSuccess: () => {
            moved.push(sessionId);
          },
        }),
      );
  }
  return { moved, skipped };
});
// T3-CUSTOM(expbkt3): END

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
    // T3-CUSTOM(expbkt3): Linear tags (projects, issues, sub-issues).
    linearLinks: threadLinearLinks(thread),
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

/**
 * `started` is what McpToolAccess.startsThreads resolved: the modes the caller
 * asked for, or its own where it asked for none. A saved default it did not ask
 * for may not run broader than the caller either.
 */
const createSession = Effect.fn("T3ControlToolkit.createSession")(function* (
  input: Tool.Parameters<typeof T3CreateSessionTool>,
  started?: McpToolAccess.StartedModes,
) {
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
  if (started !== undefined) {
    yield* resolveRuntimeMode(started.runtimeMode, runtimeMode);
    yield* resolveInteractionMode(started.interactionMode, interactionMode);
  }
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
});

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
    // T3-CUSTOM(expbkt3): the visibility rule is shared with t3_group_list.
    const threads = [...shell.threads, ...(archived?.threads ?? [])].filter((thread) =>
      callerSeesThread(scope, thread),
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
                  (thread) =>
                    thread.id === scope.thread?.threadId && thread.projectId === project.id,
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

  // T3-CUSTOM(expbkt3): BEGIN — Linear tags on a session.
  // Both tools send the whole request and let the decider dedupe and cap it
  // under the thread's lock, then report what the stored list now holds, so a
  // tag written concurrently by the sidebar or another agent is never lost or
  // misreported.
  t3_link_linear: Effect.fn("T3ControlToolkit.linkLinear")(function* (input) {
    const operation = "link-linear";
    const sessionId = yield* resolveTaggedSessionId(operation, input.sessionId);
    const links = yield* parseLinearLinkInputs(operation, input.urls);
    const before = yield* readLinearLinks(operation, sessionId);
    const sequence = yield* dispatchLinearChange(operation, sessionId, { linearLinksAdd: links });
    const after = yield* readLinearLinks(operation, sessionId);
    const urls = links.map((link) => link.url);
    const has = (list: typeof before, url: string) => list.some((entry) => entry.url === url);
    return {
      sessionId,
      linearLinks: after,
      added: urls.filter((url) => !has(before, url) && has(after, url)),
      alreadyLinked: urls.filter((url) => has(before, url)),
      // Left out because the session already holds the maximum number of tags.
      notAdded: urls.filter((url) => !has(before, url) && !has(after, url)),
      sequence,
    };
  }),

  t3_unlink_linear: Effect.fn("T3ControlToolkit.unlinkLinear")(function* (input) {
    const operation = "unlink-linear";
    const sessionId = yield* resolveTaggedSessionId(operation, input.sessionId);
    const links = yield* parseLinearLinkInputs(operation, input.urls);
    const before = yield* readLinearLinks(operation, sessionId);
    const urls = links.map((link) => link.url);
    const sequence = yield* dispatchLinearChange(operation, sessionId, {
      linearLinksRemove: urls,
    });
    const after = yield* readLinearLinks(operation, sessionId);
    const has = (list: typeof before, url: string) => list.some((entry) => entry.url === url);
    return {
      sessionId,
      linearLinks: after,
      removed: urls.filter((url) => has(before, url) && !has(after, url)),
      notLinked: urls.filter((url) => !has(before, url)),
      sequence,
    };
  }),
  // T3-CUSTOM(expbkt3): END

  t3_create_session: (input) => createSession(input),

  // T3-CUSTOM(expbkt3): the submitted document becomes the session's proposed
  // plan; native plan review ingests it from the proposed-plan event like any
  // provider-authored plan (Markdown or HTML).
  t3_submit_plan: Effect.fn("T3ControlToolkit.submitPlan")(function* (input) {
    const operation = "submit-plan";
    const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
      mapControlError(operation),
    );
    if (!settings.experimental.agentPlanSubmissionEnabled) {
      return yield* new T3ControlToolError({
        operation,
        message: "Plan submission is disabled. Put the complete plan in the main chat.",
      });
    }
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
    const threadId = yield* requireOwnThreadId(operation, scope);
    const agentUi = yield* AgentUiService;
    const handle = yield* agentUi
      .show({
        threadId,
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
    const threadId = yield* requireOwnThreadId(operation, scope);
    const threadComments = yield* ThreadCommentsService;
    const snapshot = yield* threadComments.snapshot(threadId).pipe(mapControlError(operation));
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
    const threadId = yield* requireOwnThreadId(operation, scope);
    const threadComments = yield* ThreadCommentsService;
    const commentId = yield* decodeThreadCommentId(input.commentId).pipe(
      mapControlError(operation),
    );
    const comment = yield* threadComments
      .agentReply({
        threadId,
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

  // T3-CUSTOM(expbkt3): BEGIN — the shared custom-group registry (XFN-59).
  //
  // Saved groups and colours live in the host's server settings; membership
  // lives on each session's `customGroup`. Rename and remove change both:
  // the registry first, then every session the caller can see.
  t3_group_list: Effect.fn("T3ControlToolkit.groupList")(function* (input) {
    const operation = "group-list";
    const scope = yield* requireCapability(operation, "t3.read");
    const query = yield* ProjectionSnapshotQuery;
    const settingsService = yield* ServerSettingsService;
    const [shell, settings] = yield* Effect.all([
      query.getShellSnapshot(),
      settingsService.getSettings,
    ]).pipe(mapControlError(operation));
    const visible = shell.threads.filter((thread) => callerSeesThread(scope, thread));
    const groups = describeCustomGroups(settings.threadCustomGroups, visible);
    const filter = input.label === undefined ? undefined : normalizeThreadCustomGroup(input.label);
    return {
      groups:
        filter === undefined
          ? groups
          : groups.filter((group) => normalizeThreadCustomGroup(group.label) === filter),
      colors: [...THREAD_CUSTOM_GROUP_COLOR_IDS],
    };
  }),

  t3_group_save: Effect.fn("T3ControlToolkit.groupSave")(function* (input) {
    const operation = "group-save";
    yield* requireCapability(operation, "t3.control");
    const label = yield* resolveGroupLabelInput(
      operation,
      "label",
      input.label,
      "Pass the name of the group.",
    );
    const color = yield* resolveGroupColorInput(operation, input.color);
    const settingsService = yield* ServerSettingsService;
    const current = yield* settingsService.getSettings.pipe(mapControlError(operation));
    const key = normalizeThreadCustomGroup(label);
    const existing = current.threadCustomGroups[key];
    // An omitted colour keeps the saved one; null clears it.
    const colorId = color === undefined ? existing?.colorId : (color ?? undefined);
    const definition: ThreadCustomGroupDefinition = {
      label,
      ...(colorId === undefined ? {} : { colorId }),
    };
    const settings = yield* settingsService
      .updateSettings({ threadCustomGroups: { [key]: definition } })
      .pipe(mapControlError(operation));
    const saved = settings.threadCustomGroups[key] ?? definition;
    return {
      saved: true,
      created: existing === undefined,
      group: { label: saved.label, colorId: saved.colorId ?? null },
    };
  }),

  t3_group_rename: Effect.fn("T3ControlToolkit.groupRename")(function* (input) {
    const operation = "group-rename";
    const scope = yield* requireCapability(operation, "t3.control");
    const label = yield* resolveGroupLabelInput(
      operation,
      "label",
      input.label,
      "Pass the current name of the group.",
    );
    const newLabel = yield* resolveGroupLabelInput(
      operation,
      "newLabel",
      input.newLabel,
      "Pass the new name of the group.",
    );
    const oldKey = normalizeThreadCustomGroup(label);
    const newKey = normalizeThreadCustomGroup(newLabel);
    const query = yield* ProjectionSnapshotQuery;
    const settingsService = yield* ServerSettingsService;
    const [shell, current] = yield* Effect.all([
      query.getShellSnapshot(),
      settingsService.getSettings,
    ]).pipe(mapControlError(operation));
    const visible = shell.threads.filter((thread) => callerSeesThread(scope, thread));
    const existing = current.threadCustomGroups[oldKey];
    const members = sessionsInGroup(visible, oldKey);
    if (existing === undefined && members.length === 0) {
      return yield* new T3ControlToolError({
        operation,
        message: `There is no custom group named '${label}'. Call t3_group_list to see the groups you can rename.`,
      });
    }
    // Renaming onto another group would merge the two silently; make the
    // caller say so by moving the sessions itself.
    if (
      newKey !== oldKey &&
      (current.threadCustomGroups[newKey] !== undefined ||
        sessionsInGroup(visible, newKey).length > 0)
    ) {
      return yield* new T3ControlToolError({
        operation,
        message: `A custom group named '${newLabel}' already exists. To merge the two, move the sessions with t3_update_session and then call t3_group_remove for '${label}'.`,
      });
    }
    // Only a saved group stays saved: a group that exists through session
    // labels alone is renamed on those sessions and nowhere else.
    if (existing !== undefined) {
      const patch: Record<string, ThreadCustomGroupDefinition | null> = {};
      patch[oldKey] = null;
      // Same key for a respelling: the definition then replaces the removal.
      patch[newKey] = {
        label: newLabel,
        ...(existing.colorId === undefined ? {} : { colorId: existing.colorId }),
      };
      yield* settingsService
        .updateSettings({ threadCustomGroups: patch })
        .pipe(mapControlError(operation));
    }
    const { moved, skipped } = yield* moveGroupSessions(
      operation,
      members.filter((thread) => thread.customGroup !== newLabel).map((thread) => thread.id),
      newLabel,
    );
    return {
      renamed: true,
      previousLabel: existing?.label ?? members[0]?.customGroup ?? label,
      group: {
        label: newLabel,
        colorId: existing?.colorId ?? null,
        registered: existing !== undefined,
      },
      sessionsMoved: moved.length,
      movedSessionIds: moved,
      skipped,
    };
  }),

  t3_group_remove: Effect.fn("T3ControlToolkit.groupRemove")(function* (input) {
    const operation = "group-remove";
    const scope = yield* requireCapability(operation, "t3.control");
    const label = yield* resolveGroupLabelInput(
      operation,
      "label",
      input.label,
      "Pass the name of the group to remove.",
    );
    const key = normalizeThreadCustomGroup(label);
    const query = yield* ProjectionSnapshotQuery;
    const settingsService = yield* ServerSettingsService;
    const [shell, current] = yield* Effect.all([
      query.getShellSnapshot(),
      settingsService.getSettings,
    ]).pipe(mapControlError(operation));
    const visible = shell.threads.filter((thread) => callerSeesThread(scope, thread));
    const existing = current.threadCustomGroups[key];
    const members = sessionsInGroup(visible, key);
    if (existing !== undefined) {
      yield* settingsService
        .updateSettings({ threadCustomGroups: { [key]: null } })
        .pipe(mapControlError(operation));
    }
    const { moved, skipped } = yield* moveGroupSessions(
      operation,
      members.map((thread) => thread.id),
      null,
    );
    return {
      removed: existing !== undefined || moved.length > 0,
      label: existing?.label ?? members[0]?.customGroup ?? label,
      savedGroupRemoved: existing !== undefined,
      sessionsUngrouped: moved.length,
      ungroupedSessionIds: moved,
      skipped,
    };
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

/** The control tools a session (`sessionId`, or the caller's own when omitted) changes. */
const writesSession = <P extends { readonly sessionId?: string | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  McpToolAccess.writesThreads(
    (params: P) => [params.sessionId === undefined ? undefined : ThreadId.make(params.sessionId)],
    handle,
  );

/**
 * Who may call each control tool (see McpToolAccess). The fork-only checks
 * (t3.* capabilities, team boundary, external-operator tools) stay inside the
 * handlers above.
 */
export const T3ControlToolkitHandlers = McpToolAccess.toLayer(T3ControlToolkit, {
  t3_list_sessions: McpToolAccess.reads(handlers.t3_list_sessions),
  t3_get_session: McpToolAccess.reads(handlers.t3_get_session),
  t3_list_projects: McpToolAccess.reads(handlers.t3_list_projects),
  t3_get_configuration: McpToolAccess.reads(handlers.t3_get_configuration),
  t3_send_prompt: writesSession(handlers.t3_send_prompt),
  t3_update_session: writesSession(handlers.t3_update_session),
  t3_update_server_settings: McpToolAccess.writesEnvironment((input) =>
    handlers.t3_update_server_settings(input),
  ),
  t3_session_action: writesSession(handlers.t3_session_action),
  t3_respond_approval: writesSession(handlers.t3_respond_approval),
  t3_respond_user_input: writesSession(handlers.t3_respond_user_input),
  t3_create_project: McpToolAccess.writesEnvironment((input) => handlers.t3_create_project(input)),
  t3_update_project: McpToolAccess.writesEnvironment((input) => handlers.t3_update_project(input)),
  t3_create_session: McpToolAccess.startsThreads(
    (input) => ({ runtimeMode: input.runtimeMode, interactionMode: input.interactionMode }),
    (input, started) => createSession(input, started),
  ),
  t3_link_session: writesSession(handlers.t3_link_session),
  t3_unlink_session: writesSession(handlers.t3_unlink_session),
  // T3-CUSTOM(expbkt3): Linear tags on a session.
  t3_link_linear: writesSession(handlers.t3_link_linear),
  t3_unlink_linear: writesSession(handlers.t3_unlink_linear),
  t3_submit_plan: writesSession(handlers.t3_submit_plan),
  t3_dispatch_command: McpToolAccess.writesEnvironment((input) =>
    handlers.t3_dispatch_command(input),
  ),
  t3_show_ui: McpToolAccess.actsAsCaller(handlers.t3_show_ui),
  t3_list_comments: McpToolAccess.readsAsCaller(handlers.t3_list_comments),
  t3_reply_comment: McpToolAccess.actsAsCaller(handlers.t3_reply_comment),
  t3_user_presence: McpToolAccess.reads(handlers.t3_user_presence),
  // T3-CUSTOM(expbkt3): the shared custom-group registry. Saving touches no
  // session. Rename and remove re-file sessions they cannot name up front, so
  // they declare no target: the caller check still runs, and the orchestrator
  // holds each re-filed session to the caller's modes under its lock.
  t3_group_list: McpToolAccess.reads(handlers.t3_group_list),
  t3_group_save: McpToolAccess.writes(handlers.t3_group_save),
  t3_group_rename: McpToolAccess.writesThreads(() => [], handlers.t3_group_rename),
  t3_group_remove: McpToolAccess.writesThreads(() => [], handlers.t3_group_remove),
});

/** The control handlers as a layer, for tests that build the toolkit directly. */
export const T3ControlToolkitHandlersLive =
  McpToolAccess.HandlersLayer.layer(T3ControlToolkitHandlers);

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
  // T3-CUSTOM(expbkt3): Linear tags on a session.
  linkLinear: handlers.t3_link_linear,
  unlinkLinear: handlers.t3_unlink_linear,
  // T3-CUSTOM(expbkt3): the shared custom-group registry.
  groupList: handlers.t3_group_list,
  groupSave: handlers.t3_group_save,
  groupRename: handlers.t3_group_rename,
  groupRemove: handlers.t3_group_remove,
  resolveGroupColorInput,
};
