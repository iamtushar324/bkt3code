import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import {
  type ChatAttachment,
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationEvent,
  // T3-CUSTOM(expbkt3): thread shell shape used by the session-execution helpers.
  type OrchestrationThreadShell,
  ProviderDriverKind,
  type ProjectId,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
  // T3-CUSTOM(expbkt3): per-turn credential actor / message sender attribution.
  type UserId,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
// T3-CUSTOM(expbkt3): recreate a worktree deleted out from under a live thread.
import { decideWorktreeRecovery, describeWorktreeRecreation } from "../threadWorktreeRecovery.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderWorkspaceMissingError,
} from "../../provider/Errors.ts";

import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderAuthService } from "../../provider/Services/ProviderAuthService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
// T3-CUSTOM(expbkt3): execution options carrying source-control/identity environment.
import type { ProviderSessionExecutionOptions } from "../../provider/Services/ProviderAdapter.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import {
  formatThreadTitleContext,
  type ThreadTitleMessage,
} from "../../textGeneration/ThreadTitleContext.ts";
import { canReplaceThreadTitle, DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
// T3-CUSTOM(expbkt3): source-control identity profiles for provider sessions.
import { SourceControlProfileService } from "../../sourceControl/SourceControlProfileService.ts";
// T3-CUSTOM(expbkt3): session-identity markers injected into provider sessions.
import {
  SessionIdentityEnvironmentService,
  sessionIdentityFingerprint,
  unresolvedSessionIdentityEnvironment,
} from "../../identity/SessionIdentityEnvironment.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
// T3-CUSTOM(expbkt3): open review comments ride along with every turn.
import { appendOpenThreadComments } from "../../threadcomments/turnContext.ts";
const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderWorkspaceMissingError = Schema.is(ProviderWorkspaceMissingError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      // T3-CUSTOM(expbkt3): explicit provider reconnect (MCP session_action "restart").
      | "thread.session-restart-requested"
      | "thread.settled"
      | "thread.session-set";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

const isCompactCommandMessage = (message: ThreadTitleMessage): boolean =>
  message.role === "user" &&
  (message.attachments?.length ?? 0) === 0 &&
  message.text.trim().toLowerCase() === "/compact";
function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

// T3-CUSTOM(expbkt3): exported for reuse by fork-only call sites.
export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request") ||
      detail.includes("unknown pending codex approval request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request") ||
    message.includes("unknown pending codex approval request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

// T3-CUSTOM(expbkt3): dead-session interrupt detection pairs with
// setThreadSessionInterrupted below to let Stop settle a turn with no live process.
/**
 * An interrupt that could not be delivered because nothing was running.
 *
 * After a server restart the provider process is gone, so the orchestration
 * turn is the only thing left to settle — respawning an agent just to stop it
 * would be absurd. Both shapes reach here as adapter request errors: the
 * service refuses to route to a dead session, and codex reports a session
 * with no active turn.
 */
function isDeadSessionInterruptError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  const detail = (error ? error.detail : Cause.pretty(cause)).toLowerCase();
  return (
    detail.includes("no live provider session") ||
    detail.includes("no active turn to interrupt") ||
    detail.includes("no persisted provider binding exists")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerAuthService = yield* ProviderAuthService;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  // T3-CUSTOM(expbkt3): optional keeps isolated upstream reactor tests lightweight.
  const sourceControlProfiles = yield* Effect.serviceOption(SourceControlProfileService);
  // T3-CUSTOM(expbkt3): optional for the same reason as the profile service —
  // isolated upstream reactor tests do not build the user directory.
  const sessionIdentity = yield* Effect.serviceOption(SessionIdentityEnvironmentService);
  const terminalManager = yield* TerminalManager.TerminalManager;
  /** Environment settings with the thread's project overrides applied. */
  const projectSettingsForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const settings = yield* serverSettingsService.getSettings;
    if (Object.keys(settings.projectSettingsOverrides).length === 0) return settings;
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return resolveProjectSettings(settings, Option.isSome(thread) ? thread.value.projectId : null)
      .settings;
  });
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();
  // T3-CUSTOM(expbkt3): Tracks the identity whose personal MCP credentials
  // were bound when this reactor started each ACP session. An absent entry
  // means a pre-existing session has not yet been rebound in this process.
  const threadCredentialActors = new Map<ThreadId, UserId | null>();
  // T3-CUSTOM(expbkt3): identity environment the live provider process for each
  // thread was spawned with. A process reads its environment once, so this is
  // what makes an owner transfer or a new sender observable as staleness.
  const threadSessionIdentities = new Map<ThreadId, NodeJS.ProcessEnv>();
  const compactingThreadIds = new Set<ThreadId>();
  type QueuedTurnStart = Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>;
  // Turn starts received while a thread compacts, replayed in order once its session is restored.
  const turnsAfterCompaction = new Map<ThreadId, Array<QueuedTurnStart>>();
  // Replay command id → the queued turn start it re-requests. `sent` settles once the replay's
  // provider send finishes, which is what lets the next queued turn follow it in order.
  const resumedTurnStarts = new Map<
    CommandId,
    {
      readonly event: QueuedTurnStart;
      readonly queued: Array<QueuedTurnStart>;
      readonly sent: Deferred.Deferred<void>;
    }
  >();
  const stoppingThreadIds = new Set<ThreadId>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const cancelTurnsAfterCompaction = Effect.fn("cancelTurnsAfterCompaction")(function* (
    threadId: ThreadId,
    detail: string,
  ) {
    const queued = turnsAfterCompaction.get(threadId) ?? [];
    turnsAfterCompaction.delete(threadId);
    for (const event of queued) {
      yield* appendProviderFailureActivity({
        threadId,
        kind: "provider.turn.start.failed",
        summary: "Queued message was not sent",
        detail,
        turnId: null,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        requestId: event.payload.messageId,
      }).pipe(Effect.ignore({ log: true, message: "failed to report canceled queued message" }));
    }
  });

  const resumeTurnsAfterCompaction = Effect.fn("resumeTurnsAfterCompaction")(function* (
    threadId: ThreadId,
  ) {
    const queued = turnsAfterCompaction.get(threadId) ?? [];
    while (queued.length > 0 && turnsAfterCompaction.get(threadId) === queued) {
      const event = queued[0]!;
      const turnStart = yield* projectionSnapshotQuery.getTurnStartMessage({
        threadId,
        messageId: event.payload.messageId,
      });
      if (turnsAfterCompaction.get(threadId) !== queued) return;
      // In flight from here on: a cancellation reports it when the replay runs, not from the queue.
      queued.shift();
      if (Option.isNone(turnStart)) continue;
      // Reissue the durable request after restoration clears compaction's
      // pending slot. Reusing the message id preserves a single user bubble.
      const commandId = yield* serverCommandId("after-compaction");
      const sent = yield* Deferred.make<void>();
      resumedTurnStarts.set(commandId, { event, queued, sent });
      const { messageId, ...request } = event.payload;
      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId,
          ...request,
          message: {
            messageId,
            role: "user",
            text: turnStart.value.message.text,
            attachments: turnStart.value.message.attachments ?? [],
          },
        })
        .pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              resumedTurnStarts.delete(commandId);
              queued.unshift(event);
            }),
          ),
        );
      yield* Deferred.await(sent);
      resumedTurnStarts.delete(commandId);
    }
    if (turnsAfterCompaction.get(threadId) === queued) turnsAfterCompaction.delete(threadId);
  });

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    if (isProviderAdapterRequestError(failReason?.error)) {
      return failReason.error.detail;
    }
    if (isProviderAdapterProcessError(failReason?.error)) {
      return failReason.error.detail;
    }
    if (isProviderAdapterValidationError(failReason?.error)) {
      return failReason.error.issue;
    }
    if (isProviderWorkspaceMissingError(failReason?.error)) {
      return failReason.error.message;
    }
    return Cause.pretty(cause);
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // T3-CUSTOM(expbkt3): Stop must always be able to unstick a thread — settle
  // the session as interrupted even when there is nothing left to interrupt.
  const setThreadSessionInterrupted = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThreadDetail(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "interrupted",
        activeTurnId: null,
        lastError: null,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const restoreCompaction = Effect.fnUntraced(function* (threadId: ThreadId, fromRunning = false) {
    if (stoppingThreadIds.has(threadId)) {
      compactingThreadIds.delete(threadId);
      return;
    }
    const thread = yield* resolveThreadShell(threadId);
    if (!thread?.session) return;
    if (
      thread.session.status !== "starting" &&
      thread.session.status !== "ready" &&
      (!fromRunning || thread.session.status !== "running")
    )
      return;
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    if (stoppingThreadIds.has(threadId)) {
      compactingThreadIds.delete(threadId);
      return;
    }
    yield* setThreadSession({
      threadId,
      session: {
        ...thread.session,
        status: "ready",
        activeTurnId: null,
        lastError: null,
        updatedAt: completedAt,
      },
      createdAt: completedAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /**
   * Recreates a thread's worktree from its branch when the directory has
   * disappeared. Provider sessions resume into the persisted cwd, so a missing
   * worktree makes every later turn fail as a bogus "session not found".
   * Best-effort: on failure the turn proceeds and reports the real error.
   */

  const resolveThreadShell = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadDetail = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  // T3-CUSTOM(expbkt3): source-control identity — resolves the execution
  // options a provider call needs from durable thread ownership.
  const resolveSourceControlExecutionOptions = Effect.fnUntraced(function* (
    thread: Pick<OrchestrationThreadShell, "id" | "ownerUserId" | "modelSelection">,
    method: string,
  ): Effect.fn.Return<ProviderSessionExecutionOptions | undefined, ProviderAdapterRequestError> {
    const context = yield* Option.match(sourceControlProfiles, {
      onNone: () => Effect.succeed(null),
      // T3-CUSTOM(expbkt3): attribution follows durable thread ownership.
      onSome: (profiles) =>
        profiles.resolveThreadExecutionContext(thread.id, thread.ownerUserId, {}).pipe(
          Effect.mapError(
            (error) =>
              new ProviderAdapterRequestError({
                provider: providerErrorLabelFromInstanceHint({
                  instanceId: String(thread.modelSelection.instanceId),
                }),
                method,
                detail: error.detail,
              }),
          ),
        ),
    });
    return context ? { environment: context.environment } : undefined;
  });

  // T3-CUSTOM(expbkt3): resolves who owns this thread and who sent the message
  // being answered, from the durable environment-user directory. `undefined`
  // means "this operation has no sender of its own" — an interrupt or an
  // approval reply — and reuses whatever the live session was started with, so
  // a session recovered by one of those paths does not drift from the identity
  // this reactor is tracking for the thread.
  const resolveSessionIdentityEnvironment = Effect.fnUntraced(function* (
    thread: Pick<OrchestrationThreadShell, "id" | "ownerUserId" | "modelSelection">,
    senderUserId: UserId | null | undefined,
  ) {
    if (senderUserId === undefined) {
      const bound = threadSessionIdentities.get(thread.id);
      if (bound !== undefined) {
        return bound;
      }
    }
    return yield* Option.match(sessionIdentity, {
      onNone: () => Effect.succeed(unresolvedSessionIdentityEnvironment()),
      onSome: (service) =>
        service.resolve({
          ownerUserId: thread.ownerUserId,
          senderUserId: senderUserId ?? null,
        }),
    });
  });

  // T3-CUSTOM(expbkt3): the source-control profile environment and the identity
  // markers compose — a thread-profile session carries both, a machine-identity
  // session carries the markers alone.
  const resolveSessionExecutionOptions = Effect.fnUntraced(function* (
    thread: Pick<OrchestrationThreadShell, "id" | "ownerUserId" | "modelSelection">,
    method: string,
    senderUserId: UserId | null | undefined,
  ): Effect.fn.Return<ProviderSessionExecutionOptions, ProviderAdapterRequestError> {
    const sourceControlExecutionOptions = yield* resolveSourceControlExecutionOptions(
      thread,
      method,
    );
    const identityEnvironment = yield* resolveSessionIdentityEnvironment(thread, senderUserId);
    return { ...sourceControlExecutionOptions, identityEnvironment };
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    });
  });

  // T3-CUSTOM(expbkt3): a worktree deleted out from under a live thread —
  // external cleanup, a disk incident, a manual `git worktree remove` — would
  // otherwise fail every session start with the same ENOENT until a human
  // rebuilds the directory by hand.
  const ensureThreadWorktree = Effect.fn("ensureThreadWorktree")(function* (input: {
    readonly thread: Pick<
      OrchestrationThreadShell,
      "id" | "modelSelection" | "worktreePath" | "branch"
    >;
    readonly workspaceRoot: string | null;
    readonly createdAt: string;
  }) {
    const worktreePath = input.thread.worktreePath;
    if (worktreePath === null) {
      return;
    }
    if (yield* fileSystem.exists(worktreePath)) {
      return;
    }
    const branch = input.thread.branch;
    const branchExists =
      input.workspaceRoot !== null && branch !== null
        ? (yield* gitWorkflow.listLocalBranchNames(input.workspaceRoot)).includes(branch)
        : false;
    const decision = decideWorktreeRecovery({
      worktreePath,
      branch,
      branchExists,
      workspaceRoot: input.workspaceRoot,
    });
    if (decision.kind === "unrecoverable") {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabelFromInstanceHint({
          instanceId: String(input.thread.modelSelection.instanceId),
        }),
        method: "thread.turn.start",
        detail: decision.detail,
      });
    }
    // An `rm -rf` deletion leaves a stale `.git/worktrees/` registration that
    // keeps the branch "checked out" and blocks re-adding it at this path.
    yield* gitWorkflow.pruneWorktrees({ cwd: decision.workspaceRoot });
    // Upstream #12955: honour the worktree submodule setting. A settings read
    // failure falls back to the checkout's t3.json.
    const submodules = yield* projectSettingsForThread(input.thread.id).pipe(
      Effect.map((settings) => settings.worktreeSubmodules),
      Effect.orElseSucceed(() => null),
    );
    yield* gitWorkflow.createWorktree(
      {
        cwd: decision.workspaceRoot,
        refName: decision.branch,
        path: decision.worktreePath,
      },
      { submodules },
    );
    yield* Effect.all({
      commandId: serverCommandId("worktree-recreated-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.thread.id,
          activity: {
            id: eventId,
            tone: "info",
            kind: "worktree.recreated",
            summary: `Recreated missing worktree from branch '${decision.branch}'`,
            payload: {
              detail: describeWorktreeRecreation({
                worktreePath: decision.worktreePath,
                branch: decision.branch,
              }),
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
      // T3-CUSTOM(expbkt3): who is credited as acting operator for this session start.
      readonly actorUserId?: UserId | null;
      // T3-CUSTOM(expbkt3): the user who actually sent this message, with no
      // owner fallback — an inferred sender is the misattribution this exists
      // to prevent.
      readonly messageSenderUserId?: UserId | null;
      // First-turn prompt seed. A manual title that still equals this seed was
      // written by the client's auto-title, not a user rename.
      readonly titleSeed?: string;
    },
  ) {
    const thread = yield* resolveThreadShell(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    // T3-CUSTOM(expbkt3): per-turn credential actor for multi-user sessions.
    const desiredCredentialActor = options?.actorUserId ?? thread.ownerUserId;
    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: activeSession?.provider ?? preferredProvider,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
    }
    if (thread.session !== null) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      });
    }
    if (
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    ) {
      if (currentInfo.driverKind !== desiredInfo.driverKind) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
        });
      }
      if (
        currentInfo.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        });
      }
    }
    const project = yield* resolveProject(thread.projectId);
    // T3-CUSTOM(expbkt3): recreate a worktree deleted out from under a live thread.
    yield* ensureThreadWorktree({
      thread,
      workspaceRoot: project?.workspaceRoot ?? null,
      createdAt,
    });
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });
    // T3-CUSTOM(expbkt3): source-control profile environment plus the session
    // identity markers the agent reads to name the person it works for.
    const sessionExecutionOptions = yield* resolveSessionExecutionOptions(
      thread,
      "thread.turn.start",
      options?.messageSenderUserId ?? null,
    );
    const desiredSessionIdentity =
      sessionExecutionOptions.identityEnvironment ?? unresolvedSessionIdentityEnvironment();
    const refreshWorkspaceSnapshot = effectiveCwd
      ? providerRegistry
          .refreshWorkspaceSnapshot({ instanceId: desiredInstanceId, cwd: effectiveCwd })
          .pipe(Effect.forkDetach)
      : Effect.void;
    // OpenCode skips SessionPrompt.ensureTitle when session.create already has
    // a title. Prompt seeds and "New thread" are not user titles, so omit them
    // and let the provider generate one. A real rename is source "manual" and
    // differs from the first-turn prompt seed (the web client writes that seed
    // through thread.meta.update, which also marks the title manual).
    const manualTitle = thread.titleState?.source === "manual" ? thread.title.trim() : "";
    const promptSeed = options?.titleSeed?.trim();
    const sessionTitle =
      manualTitle.length > 0 && manualTitle !== promptSeed ? thread.title : undefined;

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      providerService
        // T3-CUSTOM(expbkt3): two-arg call — session params plus the resolved
        // source-control/identity execution options and credential actor.
        .startSession(
          threadId,
          {
            threadId,
            ...(preferredProvider ? { provider: preferredProvider } : {}),
            providerInstanceId: desiredInstanceId,
            ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
            ...(sessionTitle ? { title: sessionTitle } : {}),
            modelSelection: desiredModelSelection,
            ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
            runtimeMode: desiredRuntimeMode,
          },
          // T3-CUSTOM(expbkt3): per-turn credential actor for multi-user sessions.
          {
            ...sessionExecutionOptions,
            actorUserId: desiredCredentialActor,
          },
        )
        .pipe(Effect.tap(() => refreshWorkspaceSnapshot));

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        // T3-CUSTOM(expbkt3): remember which actor/identity this session was bound
        // with, and preserve the provider's own durable thread id across restarts.
        threadCredentialActors.set(threadId, desiredCredentialActor);
        threadSessionIdentities.set(threadId, desiredSessionIdentity);
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            providerThreadId: thread.session?.providerThreadId ?? null,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);
      // T3-CUSTOM(expbkt3): Managed MCP credentials are bound to the user who
      // starts this turn. Resume the ACP under a fresh generation when a
      // different authorized user takes over a shared thread.
      const credentialActorChanged =
        !threadCredentialActors.has(threadId) ||
        threadCredentialActors.get(threadId) !== desiredCredentialActor;
      // T3-CUSTOM(expbkt3): the running process already read its environment,
      // so an owner transfer or a different sender only reaches the agent
      // through a fresh session.
      const boundSessionIdentity = threadSessionIdentities.get(threadId);
      const sessionIdentityChanged =
        boundSessionIdentity === undefined ||
        sessionIdentityFingerprint(boundSessionIdentity) !==
          sessionIdentityFingerprint(desiredSessionIdentity);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        // T3-CUSTOM(expbkt3): also restart when the credential actor or the
        // bound session identity has drifted from what this turn needs.
        !shouldRestartForModelSelectionChange &&
        !credentialActorChanged &&
        !sessionIdentityChanged
      ) {
        yield* refreshWorkspaceSnapshot;
        return existingSessionThreadId;
      }

      const resumeCursor = shouldRestartForModelChange
        ? undefined
        : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        // T3-CUSTOM(expbkt3): log the multi-user restart triggers alongside upstream's.
        credentialActorChanged,
        sessionIdentityChanged,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    // T3-CUSTOM(expbkt3): owner/sender attribution for the send-turn request.
    readonly actorUserId?: UserId | null;
    // T3-CUSTOM(expbkt3): sender of this message, never the owner by fallback.
    readonly messageSenderUserId?: UserId | null;
    readonly createdAt: string;
    readonly titleSeed?: string;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.titleSeed !== undefined ? { titleSeed: input.titleSeed } : {}),
      pendingTurnStart: true,
      // T3-CUSTOM(expbkt3): owner and sender attribution carried into session start.
      actorUserId: input.actorUserId ?? thread.ownerUserId,
      messageSenderUserId: input.messageSenderUserId ?? null,
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const settings = yield* projectSettingsForThread(input.threadId);
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : resolveSourceControlWriterModelSelection(
              settings,
              yield* providerRegistry.getProviders,
            );

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
      readonly expectedTitle: string;
      readonly expectedVersion: CommandId | null;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } = yield* projectSettingsForThread(
          input.threadId,
        );

        const generated = yield* textGeneration
          .generateThreadTitle({
            cwd: input.cwd,
            message: input.messageText,
            ...(attachments.length > 0 ? { attachments } : {}),
            modelSelection,
          })
          .pipe(
            Effect.retry({
              times: 2,
              schedule: Schedule.exponential("2 seconds"),
            }),
          );
        if (!generated) return;

        const thread = yield* resolveThreadShell(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.title.generate.complete",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title === DEFAULT_THREAD_TITLE ? input.expectedTitle : generated.title,
          expectedTitle: input.expectedTitle,
          expectedVersion: input.expectedVersion,
          needsRefinement:
            generated.needsRefinement === true || generated.title === DEFAULT_THREAD_TITLE,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const maybeRefineThreadTitle = Effect.fn("maybeRefineThreadTitle")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* resolveThreadShell(threadId);
    if (
      !thread?.titleState?.needsRefinement ||
      thread.titleState.source !== "generated" ||
      thread.titleRegeneration != null ||
      thread.latestTurn?.state !== "completed" ||
      thread.session?.status !== "ready"
    )
      return;
    const detail = yield* resolveThreadDetail(threadId);
    if (!detail || detail.messages.filter((message) => message.role === "user").length !== 1)
      return;
    yield* orchestrationEngine.dispatch({
      type: "thread.title.refine",
      commandId: yield* serverCommandId("thread-title-refine"),
      threadId,
      expectedVersion: thread.titleState.version,
    });
  });

  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    const { message, attachments } = formatThreadTitleContext(thread.messages);
    if (message.length === 0) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;
    if (thread.title !== previousTitle) {
      return { _tag: "Superseded" } as const;
    }
    const project = yield* resolveProject(thread.projectId);
    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } = resolveProjectSettings(
      yield* serverSettingsService.getSettings,
      thread.projectId,
    ).settings;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (generated.title === DEFAULT_THREAD_TITLE || generated.title === previousTitle) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const latestThread = yield* resolveThreadShell(event.payload.threadId);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return { _tag: "Superseded" } as const;
    }

    return { _tag: "Completed", title: generated.title } as const;
  });
  const dispatchThreadTitleRegenerationCompletion = Effect.fn(
    "dispatchThreadTitleRegenerationCompletion",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: yield* serverCommandId("thread-title-regeneration-complete"),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  });
  const findPendingThreadTitles = Effect.fn("findPendingThreadTitles")(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return {
      interruptedRegenerations: readModel.threads.flatMap((thread) => {
        const requestId = thread.titleRegeneration?.requestId;
        return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
      }),
      refinementThreadIds: readModel.threads
        .filter((thread) => thread.titleState?.needsRefinement)
        .map((thread) => thread.id),
    };
  });
  const clearInterruptedThreadTitleRegenerations = Effect.fn(
    "clearInterruptedThreadTitleRegenerations",
  )(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) => {
        return dispatchThreadTitleRegenerationCompletion({
          threadId,
          requestId,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to clear interrupted title regeneration",
              {
                threadId,
                cause: Cause.pretty(cause),
              },
            );
          }),
        );
      },
      { discard: true },
    );
  });
  const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
      if (requestId === null) {
        return;
      }
      const result = yield* regenerateThreadTitle(event, requestId).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("provider command reactor failed to regenerate thread title", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as({ _tag: "Completed", title: undefined } as const)),
        ),
      );
      if (result._tag === "Superseded") {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };
      yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("provider command reactor retrying title regeneration completion", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion))),
        ),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("provider command reactor failed to complete title regeneration", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  );
  const threadTitleRegenerationWorker = yield* makeDrainableWorker(
    processThreadTitleRegenerationSafely,
  );

  // T3-CUSTOM(expbkt3): BEGIN — native account commands precede busy-turn steering too.
  const processNativeAuthCommand = Effect.fn("processNativeAuthCommand")(function* (
    thread: Pick<OrchestrationThreadShell, "id" | "session" | "modelSelection" | "runtimeMode">,
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
    message: {
      readonly text: string;
      readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
    },
  ) {
    // Native account commands belong to the thread's existing provider session.
    const instanceId =
      thread.session?.providerInstanceId ??
      event.payload.modelSelection?.instanceId ??
      thread.modelSelection.instanceId;
    const handled = yield* providerAuthService.tryHandlePromptCommand({
      instanceId,
      text: message.text,
      hasAttachments: (message.attachments?.length ?? 0) > 0,
    });
    if (!handled) {
      return false;
    }

    const instanceInfo = yield* providerService.getInstanceInfo(instanceId);
    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: instanceInfo.driverKind,
        providerInstanceId: instanceId,
        runtimeMode: thread.runtimeMode,
        activeTurnId: null,
        lastError: null,
        updatedAt: event.payload.createdAt,
      },
      createdAt: event.payload.createdAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("provider-sign-out"),
      threadId: thread.id,
      activity: {
        id: yield* serverEventId(),
        tone: "info",
        kind: "provider.auth.signed-out",
        summary: "Provider signed out",
        payload: { providerInstanceId: instanceId },
        turnId: null,
        createdAt: event.payload.createdAt,
      },
      createdAt: event.payload.createdAt,
    });
    return true;
  });
  // T3-CUSTOM(expbkt3): END

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    receivedEvent: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const resumed =
      receivedEvent.commandId !== null ? resumedTurnStarts.get(receivedEvent.commandId) : undefined;
    const event = resumed ? { ...receivedEvent, payload: resumed.event.payload } : receivedEvent;
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const turnStart = yield* projectionSnapshotQuery.getTurnStartMessage({
      threadId: thread.id,
      messageId: event.payload.messageId,
    });
    if (Option.isNone(turnStart) || turnStart.value.message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.messageId,
      });
      return;
    }
    const { message, hasOtherUserMessages } = turnStart.value;
    const appendTurnStartFailure = (summary: string, detail: string) =>
      appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary,
        detail,
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.messageId,
      });
    if (resumed && turnsAfterCompaction.get(event.payload.threadId) !== resumed.queued) {
      return yield* appendTurnStartFailure(
        "Queued message was not sent",
        "The queued message was canceled before it could resume. Send it again to continue.",
      );
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      return setThreadSessionErrorOnTurnStartFailure({
        threadId: event.payload.threadId,
        detail,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.flatMap(() => appendTurnStartFailure("Provider turn start failed", detail)),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    // T3-CUSTOM(expbkt3): native account commands live in processNativeAuthCommand.
    const authCommandHandled = yield* processNativeAuthCommand(thread, event, message).pipe(
      Effect.catchCause((cause) => recoverTurnStartFailure(cause).pipe(Effect.as(true))),
    );
    if (authCommandHandled) {
      return;
    }

    // T3-CUSTOM(expbkt3): upstream #7839 recreates a missing worktree at the top of
    // the turn; the fork already does it in startProviderSession with a richer
    // recovery path (branch check, decideWorktreeRecovery, activity events), so the
    // guarantee holds without running the recovery twice per turn.

    const isCompactCommand = isCompactCommandMessage(message);
    if (!hasOtherUserMessages && !isCompactCommand) {
      const project = yield* resolveProject(thread.projectId);
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: project ? [project] : [],
        }) ?? process.cwd();
      const generationInput = {
        messageText: assistantCitationsToPlainText(message.text),
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (
        thread.titleState?.source !== "manual" &&
        canReplaceThreadTitle(thread.title, event.payload.titleSeed)
      ) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          expectedTitle: thread.title,
          expectedVersion: thread.titleState?.version ?? null,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    let compactionSessionEnsured = false;
    const handleCompactionFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      if (!compactionSessionEnsured) {
        return setThreadSessionErrorOnTurnStartFailure({
          threadId: event.payload.threadId,
          detail,
          createdAt: event.payload.createdAt,
        }).pipe(
          Effect.flatMap(() => appendTurnStartFailure("Context compaction failed", detail)),
          Effect.asVoid,
        );
      }
      return appendTurnStartFailure("Context compaction failed", detail).pipe(
        Effect.ensuring(
          restoreCompaction(event.payload.threadId).pipe(
            Effect.catchCause((restoreCause) =>
              Effect.logWarning("failed to restore provider session after compaction failure", {
                threadId: event.payload.threadId,
                cause: Cause.pretty(restoreCause),
              }),
            ),
          ),
        ),
        Effect.asVoid,
      );
    };
    const recoverCompactionFailure = (cause: Cause.Cause<unknown>) =>
      handleCompactionFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover compaction failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );
    if (isCompactCommand) {
      if (!hasOtherUserMessages) {
        return yield* appendTurnStartFailure(
          "Context compaction failed",
          "Context compaction requires an existing conversation.",
        );
      }
      const latestThread = yield* resolveThreadShell(event.payload.threadId);
      if (
        compactingThreadIds.has(event.payload.threadId) ||
        turnsAfterCompaction.has(event.payload.threadId) ||
        latestThread?.session?.status === "starting" ||
        latestThread?.session?.status === "running"
      ) {
        yield* appendTurnStartFailure(
          "Context compaction failed",
          "Context compaction is unavailable while a provider turn is running.",
        );
        return;
      }
      compactingThreadIds.add(event.payload.threadId);
      const clearCompacting = Effect.sync(
        () => void compactingThreadIds.delete(event.payload.threadId),
      );
      yield* Effect.gen(function* () {
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.payload.createdAt,
          event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection, pendingTurnStart: true }
            : { pendingTurnStart: true },
        );
        compactionSessionEnsured = true;
        if (event.payload.modelSelection !== undefined) {
          threadModelSelections.set(event.payload.threadId, event.payload.modelSelection);
        }
        yield* providerService.compactThread(
          event.payload.threadId,
          event.payload.modelSelection,
          event.payload.messageId,
        );
      }).pipe(
        Effect.andThen(restoreCompaction(event.payload.threadId, true)),
        Effect.andThen(clearCompacting),
        Effect.andThen(resumeTurnsAfterCompaction(event.payload.threadId)),
        Effect.catchCause((cause) =>
          recoverCompactionFailure(cause).pipe(
            Effect.ensuring(clearCompacting),
            Effect.andThen(
              cancelTurnsAfterCompaction(
                event.payload.threadId,
                "Context compaction failed. Send this message again to continue.",
              ),
            ),
          ),
        ),
        Effect.forkScoped,
      );
      return;
    }
    if (
      !resumed &&
      (compactingThreadIds.has(event.payload.threadId) ||
        turnsAfterCompaction.has(event.payload.threadId))
    ) {
      const queued = turnsAfterCompaction.get(event.payload.threadId) ?? [];
      queued.push(event);
      turnsAfterCompaction.set(event.payload.threadId, queued);
      return;
    }
    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      // T3-CUSTOM(expbkt3): BEGIN open review comments ride along with every turn.
      messageText: yield* appendOpenThreadComments(
        event.payload.threadId,
        projectComposerContextForProvider({
          text: message.text,
          records: message.context?.records ?? [],
        }),
      ),
      // T3-CUSTOM(expbkt3): END
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      // T3-CUSTOM(expbkt3): owner and sender attribution for the provider session.
      actorUserId: message.sentByUserId ?? thread.ownerUserId,
      messageSenderUserId: message.sentByUserId ?? null,
      createdAt: event.payload.createdAt,
      // Later turns must not reuse the current title as titleSeed. Only the
      // first prompt seed should suppress a not-yet-renamed session title.
      ...(!hasOtherUserMessages && event.payload.titleSeed !== undefined
        ? { titleSeed: event.payload.titleSeed }
        : {}),
    }).pipe(
      Effect.asSome,
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      return;
    }

    // T3-CUSTOM(expbkt3): identity-scoped execution options for the send.
    const sessionExecutionOptions = yield* resolveSessionExecutionOptions(
      thread,
      "thread.turn.start",
      message.sentByUserId ?? null,
    );
    const send = providerService
      .sendTurn(sendTurnRequest.value, sessionExecutionOptions)
      .pipe(Effect.asVoid, Effect.catchCause(recoverTurnStartFailure));
    // The forked send settles `sent` from here on, so drop the entry the post-processing hook uses.
    if (resumed && event.commandId !== null) resumedTurnStarts.delete(event.commandId);
    yield* send.pipe(
      Effect.ensuring(resumed ? Deferred.succeed(resumed.sent, undefined) : Effect.void),
      Effect.forkScoped,
    );
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    yield* cancelTurnsAfterCompaction(
      event.payload.threadId,
      "Context compaction was interrupted. Send this message again to continue.",
    );
    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    if (!session || session.status === "stopped") {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    const recoverInterruptFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.interrupt;
      }

      const detail = formatFailureDetail(cause);
      return Effect.gen(function* () {
        const latestThread = yield* resolveThreadShell(event.payload.threadId);
        const latestSession = latestThread?.session;
        if (
          !latestSession ||
          latestSession.status === "stopped" ||
          latestSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            latestSession.activeTurnId !== null &&
            latestSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        yield* providerService.stopSession({ threadId: event.payload.threadId }).pipe(
          Effect.catchCause((stopCause) => {
            if (Cause.hasInterruptsOnly(stopCause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to stop session after interrupt failure",
              {
                threadId: event.payload.threadId,
                cause: Cause.pretty(stopCause),
                originalCause: Cause.pretty(cause),
              },
            );
          }),
        );
        const stoppedThread = yield* resolveThreadShell(event.payload.threadId);
        const stoppedSession = stoppedThread?.session;
        if (
          !stoppedSession ||
          stoppedSession.status === "stopped" ||
          stoppedSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            stoppedSession.activeTurnId !== null &&
            stoppedSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        yield* setThreadSession({
          threadId: event.payload.threadId,
          session: {
            ...stoppedSession,
            status: "stopped",
            activeTurnId: null,
            lastError: detail,
            updatedAt: event.payload.createdAt,
          },
          createdAt: event.payload.createdAt,
        });
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.interrupt.failed",
          summary: "Provider turn interrupt failed",
          detail,
          turnId: event.payload.turnId ?? null,
          createdAt: event.payload.createdAt,
        });
      });
    };

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    // T3-CUSTOM(expbkt3): identity-scoped execution options for the interrupt call.
    const sessionExecutionOptions = yield* resolveSessionExecutionOptions(
      thread,
      "thread.turn.interrupt",
      undefined,
    );
    yield* providerService
      .interruptTurn({ threadId: event.payload.threadId }, sessionExecutionOptions)
      .pipe(
        Effect.catchCause((cause) => {
          // T3-CUSTOM(expbkt3): BEGIN — Stop must always be able to unstick a
          // thread. When the provider session is already gone there is nothing
          // to interrupt, so settle the orchestration turn directly instead of
          // leaving it pinned. Every other failure goes through upstream's
          // stop-and-recover path below.
          if (isDeadSessionInterruptError(cause)) {
            return setThreadSessionInterrupted({
              threadId: event.payload.threadId,
              createdAt: event.payload.createdAt,
            }).pipe(
              Effect.andThen(
                appendProviderFailureActivity({
                  threadId: event.payload.threadId,
                  kind: "provider.turn.interrupt.failed",
                  summary: "Turn stopped",
                  detail: "The provider session was no longer running, so the turn was closed.",
                  turnId: event.payload.turnId ?? null,
                  createdAt: event.payload.createdAt,
                }),
              ),
            );
          }
          // Every other failure falls through to upstream's stop-and-recover path.
          return recoverInterruptFailure(cause);
        }),
      );
    // T3-CUSTOM(expbkt3): END
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    // T3-CUSTOM(expbkt3): identity-scoped execution options for the approval response.
    const sessionExecutionOptions = yield* resolveSessionExecutionOptions(
      thread,
      "thread.approval.respond",
      undefined,
    );
    yield* providerService
      .respondToRequest(
        {
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          decision: event.payload.decision,
        },
        sessionExecutionOptions,
      )
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThreadShell(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      // T3-CUSTOM(expbkt3): identity-scoped execution options for the user-input response.
      const sessionExecutionOptions = yield* resolveSessionExecutionOptions(
        thread,
        "thread.user-input.respond",
        undefined,
      );
      yield* providerService
        .respondToUserInput(
          {
            threadId: event.payload.threadId,
            requestId: event.payload.requestId,
            answers: event.payload.answers,
            ...(event.payload.attachmentsByQuestionId
              ? { attachmentsByQuestionId: event.payload.attachmentsByQuestionId }
              : {}),
          },
          sessionExecutionOptions,
        )
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    const wasCompacting = compactingThreadIds.has(thread.id);
    stoppingThreadIds.add(thread.id);
    const clearStopping = Effect.sync(() => void stoppingThreadIds.delete(thread.id));
    yield* cancelTurnsAfterCompaction(
      thread.id,
      "The session was stopped during context compaction. Send this message again to continue.",
    ).pipe(
      Effect.andThen(
        thread.session && thread.session.status !== "stopped"
          ? providerService.stopSession({ threadId: thread.id })
          : Effect.void,
      ),
      Effect.matchCauseEffect({
        onFailure: (cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          const detail = formatFailureDetail(cause);
          return Effect.sync(() => {
            stoppingThreadIds.delete(thread.id);
            return wasCompacting && !compactingThreadIds.has(thread.id);
          }).pipe(
            Effect.flatMap((compactionSettled) =>
              compactionSettled ? restoreCompaction(thread.id) : Effect.void,
            ),
            Effect.andThen(
              appendProviderFailureActivity({
                threadId: thread.id,
                kind: "provider.session.stop.failed",
                summary: "Provider session stop failed",
                detail,
                turnId: null,
                createdAt: now,
              }),
            ),
          );
        },
        onSuccess: () =>
          setThreadSession({
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "stopped",
              providerName: thread.session?.providerName ?? null,
              ...(thread.session?.providerInstanceId !== undefined
                ? { providerInstanceId: thread.session.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
              activeTurnId: null,
              lastError: thread.session?.lastError ?? null,
              updatedAt: now,
            },
            createdAt: now,
          }),
      }),
      // T3-CUSTOM(expbkt3): a stopped session forgets its per-turn credential actor.
      Effect.tap(() => Effect.sync(() => threadCredentialActors.delete(thread.id))),
      Effect.ensuring(clearStopping),
    );
  });

  // T3-CUSTOM(expbkt3): BEGIN — explicit provider reconnect (MCP session_action "restart").
  const processSessionRestartRequested = Effect.fn("processSessionRestartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-restart-requested" }>,
  ) {
    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread?.session) {
      return yield* new ProviderAdapterRequestError({
        provider: "unknown",
        method: "thread.session.restart",
        detail: `Thread '${event.payload.threadId}' does not have a provider session to reconnect.`,
      });
    }

    const modelSelection =
      thread.session.providerInstanceId !== undefined
        ? {
            ...thread.modelSelection,
            instanceId: thread.session.providerInstanceId,
          }
        : thread.modelSelection;
    yield* ensureSessionForThread(thread.id, event.payload.createdAt, { modelSelection });
  });
  // T3-CUSTOM(expbkt3): END

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.meta-updated":
        if (event.payload.regenerateTitle) yield* threadTitleRegenerationWorker.enqueue(event);
        else if (event.payload.titleState?.needsRefinement)
          yield* maybeRefineThreadTitle(event.payload.threadId);
        return;
      case "thread.session-set":
        if (event.payload.session.status === "ready")
          yield* maybeRefineThreadTitle(event.payload.threadId);
        return;
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThreadShell(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        const resume = ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        yield* thread.worktreePath
          ? withWorkspaceLease(path.resolve(thread.worktreePath), resume)
          : resume;
        return;
      }
      case "thread.turn-start-requested": {
        const thread = yield* resolveThreadShell(event.payload.threadId);
        yield* thread?.worktreePath
          ? withWorkspaceLease(path.resolve(thread.worktreePath), processTurnStartRequested(event))
          : processTurnStartRequested(event);
        return;
      }
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
      // T3-CUSTOM(expbkt3): explicit provider reconnect.
      case "thread.session-restart-requested":
        yield* processSessionRestartRequested(event);
        return;
      case "thread.settled": {
        const thread = yield* projectionSnapshotQuery.getThreadShellById(event.payload.threadId);
        // A thread re-engaged before this event ran keeps its shells and session.
        if (Option.isNone(thread) || thread.value.settledOverride !== "settled") {
          return;
        }
        // Idle shells close so they stop holding the worktree. A terminal that
        // runs a command (a dev server, an editor) stays for the user to close.
        yield* terminalManager.closeIdle({ threadId: event.payload.threadId });
        if (thread.value.session == null || thread.value.session.status === "stopped") {
          return;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(`session-stop-for-settle:${event.commandId ?? event.eventId}`),
          threadId: event.payload.threadId,
          createdAt: event.occurredAt,
          onlyIfSettled: true,
        });
        return;
      }
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      // A replay that returned before forking its send still holds its entry; settle it so
      // the compaction queue moves on. Forked sends drop the entry first and settle it themselves.
      Effect.ensuring(
        Effect.suspend(() => {
          const resumed = event.commandId !== null && resumedTurnStarts.get(event.commandId);
          return resumed ? Deferred.succeed(resumed.sent, undefined) : Effect.void;
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const pendingTitles = yield* findPendingThreadTitles().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to find pending thread titles", {
          failureKind: Cause.hasDies(cause) ? "defect" : "failure",
          reasonCount: cause.reasons.length,
        }).pipe(Effect.as({ interruptedRegenerations: [], refinementThreadIds: [] }));
      }),
    );
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        (event.type === "thread.meta-updated" &&
          (event.payload.regenerateTitle === true ||
            event.payload.titleState?.needsRefinement === true)) ||
        (event.type === "thread.session-set" && event.payload.session.status === "ready") ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested" ||
        // T3-CUSTOM(expbkt3): explicit provider reconnect.
        event.type === "thread.session-restart-requested" ||
        event.type === "thread.settled"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    // Subscribe before returning, even while event handling waits for server activation.
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(domainEvents, processEvent));

    // Earlier events do not replay. Clear interrupted requests by their captured
    // IDs, then schedule persisted refinements after subscribing to their events.
    const recoverTitles = clearInterruptedThreadTitleRegenerations(
      pendingTitles.interruptedRegenerations,
    ).pipe(
      Effect.andThen(
        Effect.forEach(pendingTitles.refinementThreadIds, maybeRefineThreadTitle, {
          discard: true,
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to recover pending thread titles",
          {
            failureKind: Cause.hasDies(cause) ? "defect" : "failure",
            reasonCount: cause.reasons.length,
          },
        );
      }),
    );
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* recoverTitles;
    } else {
      yield* forkParked(recoverTitles);
    }
  });

  return {
    start,
    drain: Effect.gen(function* () {
      yield* worker.drain;
      yield* threadTitleRegenerationWorker.drain;
    }),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
