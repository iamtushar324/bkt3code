import {
  type ChatAttachment,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  ProviderDriverKind,
  type ProjectId,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  TurnId,
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
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

// T3-CUSTOM(expbkt3): one bounded seam keeps the upstream worker model intact.
import { runProviderCommandWithinLaneDeadline } from "../providerCommandLane.expbkt3.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { decideWorktreeRecovery, describeWorktreeRecreation } from "../threadWorktreeRecovery.ts";
import {
  durableExecutionGuardedContinuationsTotal,
  durableExecutions,
  increment,
  orchestrationEventsProcessedTotal,
  setMetric,
} from "../../observability/Metrics.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderWorkspaceMissingError,
} from "../../provider/Errors.ts";

import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderAuthService } from "../../provider/Services/ProviderAuthService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import type {
  ProviderSessionExecutionOptions,
  ProviderThreadSnapshot,
} from "../../provider/Services/ProviderAdapter.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { makeProviderSessionRestartSweep } from "./ProviderSessionRestartSweep.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
// T3-CUSTOM(expbkt3): canReplaceThreadTitle is wrapped locally to honour titleManuallySet.
import { DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
// T3-CUSTOM(expbkt3): fence reused thread resources before durable bootstrap effects.
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { ThreadExecutionSupervisor } from "../../execution/ThreadExecutionSupervisor.ts";
import { SourceControlProfileService } from "../../sourceControl/SourceControlProfileService.ts";
// T3-CUSTOM(expbkt3): session-identity markers injected into provider sessions.
import {
  SessionIdentityEnvironmentService,
  sessionIdentityFingerprint,
  unresolvedSessionIdentityEnvironment,
} from "../../identity/SessionIdentityEnvironment.ts";
import { ServerConfig } from "../../config.ts";
// T3-CUSTOM(expbkt3): schema guards preserve setup launch certainty across the durable boundary.
import {
  ProjectSetupScriptCommandError,
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
  ProjectSetupScriptRunner,
} from "../../project/ProjectSetupScriptRunner.ts";
// T3-CUSTOM(expbkt3): exact durable-bootstrap bases bypass ref-list pagination.
import { resolveAvailableWorktreeBase } from "../../thread-bootstrap/WorktreeBaseResolver.ts";
// T3-CUSTOM(expbkt3): siblings sharing one worktree must not race its creation.
import { withWorktreeCreationPermit } from "../../thread-bootstrap/parentWorkspaceInheritance.ts";
// T3-CUSTOM(expbkt3): periodic title refresh cadence.
import { shouldRefreshThreadTitle } from "../../thread-title/titleRefreshCadence.ts";
// T3-CUSTOM(expbkt3): who owns a session title, and when generation may replace it.
import {
  canGeneratedTitleReplace,
  shouldNameThreadFromFirstPrompt,
} from "../../thread-title/titleAuthorship.ts";
// T3-CUSTOM(expbkt3): durable dispatch control plane; provider mechanics stay here.
import {
  DurableExecutionDispatchError,
  makeDurableExecutionCoordinator,
} from "../../execution/DurableExecutionCoordinator.ts";
import { DurableExecutionIntentRepository } from "../../execution/DurableExecutionIntentRepository.ts";
// T3-CUSTOM(expbkt3): guarded recovery quotes the request it may have lost.
import { buildGuardedContinuationPrompt } from "../../execution/guardedContinuationPrompt.ts";
// T3-CUSTOM(expbkt3): stop a setup command by its owned durable terminal id.
import { TerminalManager } from "../../terminal/Manager.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderWorkspaceMissingError = Schema.is(ProviderWorkspaceMissingError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);
const isProjectSetupScriptCommandError = Schema.is(ProjectSetupScriptCommandError);
const isProjectSetupScriptOperationError = Schema.is(ProjectSetupScriptOperationError);
const isProjectSetupScriptProjectNotFoundError = Schema.is(ProjectSetupScriptProjectNotFoundError);

// T3-CUSTOM(expbkt3): mere provider-history presence is not terminal evidence.
export function providerHistoryProvesCompletion(
  history: ProviderThreadSnapshot,
  providerTurnId: TurnId,
): boolean {
  return history.turns.some((turn) => turn.id === providerTurnId && turn.state === "completed");
}

// T3-CUSTOM(expbkt3): Codex only materializes a thread after its first user message.
export function providerHistoryReadProvesUndelivered(cause: unknown): boolean {
  if (!isProviderAdapterRequestError(cause)) return false;
  const detail = cause.detail.toLowerCase();
  return (
    cause.provider === "codex" &&
    cause.method === "thread/read" &&
    detail.includes("not materialized yet") &&
    detail.includes("before first user message")
  );
}

// T3-CUSTOM(expbkt3): ten retries cannot repair missing resume state or removed configuration.
export function durableRecoveryFailure(
  cause: unknown,
  fallbackFailureType: string,
): DurableExecutionDispatchError {
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause ? String(cause._tag) : "";
  const detail = String(cause);
  // Adapter errors bury the decisive message (an ENOENT from a spawn, a
  // permission failure) in nested `cause`s that String() never surfaces, so
  // classify against the whole chain.
  let normalized = detail.toLowerCase();
  const seen = new Set<unknown>();
  let nested: unknown = cause;
  while (typeof nested === "object" && nested !== null && "cause" in nested && !seen.has(nested)) {
    seen.add(nested);
    nested = (nested as { readonly cause?: unknown }).cause;
    if (nested !== undefined && nested !== null) {
      normalized += ` ${String(nested).toLowerCase()}`;
    }
  }
  const permanentTag =
    tag === "ProviderAdapterValidationError" ||
    tag === "ProviderValidationError" ||
    tag === "ProviderUnsupportedError" ||
    tag === "ProviderInstanceNotFoundError" ||
    tag === "ProviderSessionNotFoundError";
  const permanentDetail =
    /resume (?:cursor|state).*(?:missing|unavailable|not found)/.test(normalized) ||
    /(?:session|thread).*(?:does not exist|not found|unknown)/.test(normalized) ||
    /worktree.*(?:does not exist|not found|missing)/.test(normalized) ||
    normalized.includes("enoent") ||
    normalized.includes("permission denied") ||
    normalized.includes("access revoked");
  const retryable = !(permanentTag || permanentDetail);
  return new DurableExecutionDispatchError({
    failureType: retryable ? fallbackFailureType : "durable-resume-unavailable",
    detail,
    retryable,
    cause,
  });
}

const normalizeDurableDispatchError = (cause: unknown, fallbackFailureType: string) =>
  Schema.is(DurableExecutionDispatchError)(cause)
    ? cause
    : durableRecoveryFailure(cause, fallbackFailureType);

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
      | "thread.session-restart-requested"
      | "thread.archived"
      | "thread.session-set"
      | "thread.settled";
  }
>;

// T3-CUSTOM(expbkt3): projection fences a Stop before the reactor processes
// it. A later accepted turn must never be mistaken for that Stop's setup.
export function isSetupOwnedByStop(
  item: Pick<
    import("../../execution/DurableExecutionIntentRepository.ts").DurableExecutionIntent,
    "desiredState" | "phase" | "requestEventSequence"
  >,
  stopEventSequence: number,
): boolean {
  return (
    item.desiredState === "stopped" &&
    item.phase === "stopping" &&
    item.requestEventSequence !== null &&
    item.requestEventSequence <= stopEventSequence
  );
}

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

const isCompactCommandMessage = (message: ThreadTitleMessage): boolean =>
  message.role === "user" &&
  (message.attachments?.length ?? 0) === 0 &&
  message.text.trim().toLowerCase() === "/compact";
const isCompactCommandText = (text: string | null | undefined): boolean =>
  text?.trim().toLowerCase() === "/compact";
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
const MAX_REGENERATION_ATTACHMENTS = 4;
const MAX_THREAD_TITLE_CONTEXT_CHARS = 8_000;
const MAX_FIRST_USER_TITLE_CONTEXT_CHARS = 2_000;
const THREAD_TITLE_CONTEXT_TRUNCATION_MARKER = "[Earlier content truncated]\n\n";
const FIRST_USER_CONTEXT_TRUNCATION_MARKER = "\n[First user message truncated]";

type ThreadTitleMessage = {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
};

function formatThreadTitleSection(message: ThreadTitleMessage): string | undefined {
  if (message.role === "system") {
    return undefined;
  }
  const text = assistantCitationsToPlainText(message.text).trim();
  const attachmentSummary = (message.attachments ?? [])
    .map((attachment) => attachment.name)
    .join(", ");
  const contents = [
    ...(text.length > 0 ? [text] : []),
    ...(attachmentSummary.length > 0 ? [`[Attachments: ${attachmentSummary}]`] : []),
  ].join("\n");
  return contents.length > 0 ? `${message.role.toUpperCase()}:\n${contents}` : undefined;
}

function limitFirstUserSection(section: string): string {
  if (section.length <= MAX_FIRST_USER_TITLE_CONTEXT_CHARS) {
    return section;
  }
  return `${section.slice(
    0,
    MAX_FIRST_USER_TITLE_CONTEXT_CHARS - FIRST_USER_CONTEXT_TRUNCATION_MARKER.length,
  )}${FIRST_USER_CONTEXT_TRUNCATION_MARKER}`;
}

function collectRecentThreadTitleContext(
  messages: ReadonlyArray<ThreadTitleMessage>,
  maxChars: number,
): {
  readonly context: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly truncated: boolean;
} {
  let context = "";
  let truncated = false;
  const retainedAttachments: Array<ChatAttachment> = [];

  for (const message of messages.toReversed()) {
    const section = formatThreadTitleSection(message);
    if (section === undefined) {
      continue;
    }

    const separator = context.length > 0 ? "\n\n" : "";
    const available = maxChars - context.length - separator.length;
    if (section.length > available) {
      if (available > 0) {
        context = `${section.slice(-available)}${separator}${context}`;
        retainedAttachments.unshift(...(message.attachments ?? []));
      }
      truncated = true;
      break;
    }
    context = `${section}${separator}${context}`;
    retainedAttachments.unshift(...(message.attachments ?? []));
  }

  return { context, attachments: retainedAttachments, truncated };
}

function formatThreadTitleContext(messages: ReadonlyArray<ThreadTitleMessage>): {
  readonly message: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
} {
  const recent = collectRecentThreadTitleContext(messages, MAX_THREAD_TITLE_CONTEXT_CHARS);
  if (!recent.truncated) {
    return {
      message: recent.context,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const firstUserMessage = messages.find(
    (message) => message.role === "user" && formatThreadTitleSection(message),
  );
  const firstUserSection = firstUserMessage
    ? formatThreadTitleSection(firstUserMessage)
    : undefined;
  if (!firstUserMessage || !firstUserSection) {
    return {
      message: `${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${recent.context}`,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const pinnedSection = limitFirstUserSection(firstUserSection);
  const recentContextBudget =
    MAX_THREAD_TITLE_CONTEXT_CHARS -
    pinnedSection.length -
    "\n\n".length -
    THREAD_TITLE_CONTEXT_TRUNCATION_MARKER.length;
  const retainedRecent = collectRecentThreadTitleContext(messages, recentContextBudget);
  const pinnedAttachment = firstUserMessage.attachments?.[0];
  const recentAttachments = retainedRecent.attachments.filter(
    (attachment) => attachment.id !== pinnedAttachment?.id,
  );

  return {
    message: `${pinnedSection}\n\n${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${retainedRecent.context}`,
    attachments: [
      ...(pinnedAttachment ? [pinnedAttachment] : []),
      ...recentAttachments.slice(
        -(MAX_REGENERATION_ATTACHMENTS - (pinnedAttachment === undefined ? 0 : 1)),
      ),
    ],
  };
}

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

// T3-CUSTOM(expbkt3): title ownership moved to apps/server/src/thread-title.
// Upstream compared the current title to the raw seed, but clients title a new
// thread with `truncate(prompt)` while seeding the full prompt, so no prompt
// over the truncation budget was ever auto-named. `titleManuallySet` is the
// durable "a human chose this" flag the periodic refresh also honors.
function canReplaceThreadTitle(
  currentTitle: string,
  titleSeed?: string,
  titleManuallySet?: boolean,
): boolean {
  return canGeneratedTitleReplace({
    title: currentTitle,
    ...(titleSeed !== undefined ? { titleSeed } : {}),
    ...(titleManuallySet !== undefined ? { titleManuallySet } : {}),
  });
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
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const executionSupervisor = yield* ThreadExecutionSupervisor;
  // T3-CUSTOM(expbkt3): required production cleanup fence for atomic thread creation.
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const serverConfig = yield* ServerConfig;
  const path = yield* Path.Path;
  const projectSetupScriptRunner = yield* Effect.serviceOption(ProjectSetupScriptRunner);
  // T3-CUSTOM(expbkt3): optional keeps isolated upstream reactor tests lightweight.
  const durableIntentRepository = yield* Effect.serviceOption(DurableExecutionIntentRepository);
  const terminalManager = yield* Effect.serviceOption(TerminalManager);
  const sourceControlProfiles = yield* Effect.serviceOption(SourceControlProfileService);
  // T3-CUSTOM(expbkt3): optional for the same reason as the profile service —
  // isolated upstream reactor tests do not build the user directory.
  const sessionIdentity = yield* Effect.serviceOption(SessionIdentityEnvironmentService);
  const providerSessionRestartSweep = yield* makeProviderSessionRestartSweep;
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
  // T3-CUSTOM(expbkt3): first-prompt naming hands its message context to the
  // regeneration worker so that run decodes no stored message bodies. Keyed by
  // the meta.update command id and consumed once; a miss (a request replayed
  // after a restart) falls back to the conversation read the manual refresh uses.
  const firstPromptTitleContexts = new Map<
    CommandId,
    { readonly message: string; readonly attachments: ReadonlyArray<ChatAttachment> }
  >();

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
    yield* gitWorkflow.createWorktree({
      cwd: decision.workspaceRoot,
      refName: decision.branch,
      path: decision.worktreePath,
    });
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
      readonly actorUserId?: UserId | null;
      /**
       * T3-CUSTOM(expbkt3): the user who actually sent this message, with no
       * owner fallback — an inferred sender is the misattribution this exists
       * to prevent.
       */
      readonly messageSenderUserId?: UserId | null;
    },
  ) {
    const thread = yield* resolveThreadShell(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

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

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      providerService
        .startSession(
          threadId,
          {
            threadId,
            ...(preferredProvider ? { provider: preferredProvider } : {}),
            providerInstanceId: desiredInstanceId,
            ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
            ...(thread.title ? { title: thread.title } : {}),
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
    readonly actorUserId?: UserId | null;
    /** T3-CUSTOM(expbkt3): sender of this message, never the owner by fallback. */
    readonly messageSenderUserId?: UserId | null;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      pendingTurnStart: true,
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
        // T3-CUSTOM(expbkt3): a rename that landed while the model was thinking
        // wins — including one the user typed.
        if (!canReplaceThreadTitle(thread.title, input.titleSeed, thread.titleManuallySet)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
          // T3-CUSTOM(expbkt3): generated, so a later refresh may replace it.
          titleOrigin: "generated",
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

  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    // T3-CUSTOM(expbkt3): BEGIN — a first-prompt request carries its own
    // context, so only a manual or scheduled refresh reads the conversation.
    const firstPrompt =
      event.commandId === null ? undefined : firstPromptTitleContexts.get(event.commandId);
    if (event.commandId !== null) firstPromptTitleContexts.delete(event.commandId);
    const thread = yield* firstPrompt === undefined
      ? resolveThreadDetail(event.payload.threadId)
      : resolveThreadShell(event.payload.threadId);
    // T3-CUSTOM(expbkt3): END
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    // T3-CUSTOM(expbkt3): first-prompt context wins; see above.
    const { message, attachments } =
      firstPrompt ?? formatThreadTitleContext("messages" in thread ? thread.messages : []);
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
    const generated = yield* textGeneration
      .generateThreadTitle({
        cwd,
        message,
        previousTitle,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      })
      .pipe(
        // T3-CUSTOM(expbkt3): first-prompt naming moved here from upstream's
        // detached helper; retain its bounded retry without changing manual refresh.
        Effect.retry({
          times: event.commandId?.startsWith("server:thread-title-first-prompt:") ? 2 : 0,
          schedule: Schedule.exponential("2 seconds"),
        }),
      );
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
  const findInterruptedThreadTitleRegenerations = Effect.fn(
    "findInterruptedThreadTitleRegenerations",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return readModel.threads.flatMap((thread) => {
      const requestId = thread.titleRegeneration?.requestId;
      return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
    });
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
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("provider command reactor failed to regenerate thread title", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ _tag: "Completed", title: undefined } as const));
        }),
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
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor retrying title regeneration completion",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          ).pipe(Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion)));
        }),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor failed to complete title regeneration",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          );
        }),
      ),
  );
  const threadTitleRegenerationWorker = yield* makeDrainableWorker(
    processThreadTitleRegenerationSafely,
  );

  // T3-CUSTOM(expbkt3): native account commands precede busy-turn steering too.
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

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    receivedEvent: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
    // T3-CUSTOM(expbkt3): durable recovery replay and claim fencing.
    recovery?: {
      readonly messageText: string;
      readonly useOriginalAttachments: boolean;
    },
    claimGuard?: Effect.Effect<void, DurableExecutionDispatchError>,
  ) {
    const resumed =
      receivedEvent.commandId !== null ? resumedTurnStarts.get(receivedEvent.commandId) : undefined;
    const event = resumed ? { ...receivedEvent, payload: resumed.event.payload } : receivedEvent;
    if (claimGuard !== undefined) yield* claimGuard;
    const key = turnStartKeyForEvent(event);
    if (
      recovery === undefined &&
      Option.isNone(durableIntentRepository) &&
      (yield* hasHandledTurnStartRecently(key))
    ) {
      return;
    }
    const executionId = String(event.commandId ?? event.eventId);
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
    const isCompactCommand = isCompactCommandMessage(message);
    // T3-CUSTOM(expbkt3): compaction never creates a provider turn, so it must
    // check the pre-existing session before admission can dual-write itself as
    // running. Releasing the handled sequence below suppresses the subscriber's
    // later generic admission of this same durable request.
    if (!isCompactCommand) {
      const preparedExecution = yield* recovery === undefined
        ? executionSupervisor.prepareExecution(event)
        : executionSupervisor.recoverExecution(event);
      if (preparedExecution.turn?.executionId !== executionId) {
        return;
      }
    }
    const appendTurnStartFailure = (summary: string, detail: string) =>
      appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary,
        detail,
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.messageId,
      }).pipe(Effect.asVoid);
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
      return executionSupervisor.failExecution(event.payload.threadId, executionId, detail).pipe(
        Effect.andThen(
          setThreadSessionErrorOnTurnStartFailure({
            threadId: event.payload.threadId,
            detail,
            createdAt: event.payload.createdAt,
          }),
        ),
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

    const authCommandHandled = yield* processNativeAuthCommand(thread, event, message).pipe(
      Effect.catchCause((cause) => recoverTurnStartFailure(cause).pipe(Effect.as(true))),
    );
    if (authCommandHandled) {
      // T3-CUSTOM(expbkt3): native commands consume input without a provider turn.
      yield* executionSupervisor.releaseTurnAdmission(
        event.payload.threadId,
        executionId,
        event.sequence,
      );
      return { handledCommand: true, turnId: null } as const;
    }

    // T3-CUSTOM(expbkt3): upstream #7839 recreates a missing worktree at the top of
    // the turn; the fork already does it in startProviderSession with a richer
    // recovery path (branch check, decideWorktreeRecovery, activity events), so the
    // guarantee holds without running the recovery twice per turn.

    // T3-CUSTOM(expbkt3): BEGIN — first-turn eligibility comes from upstream's
    // hasOtherUserMessages flag and the refresh cadence counts prompts with a
    // dedicated query, so turn start never decodes stored message bodies
    // (upstream #10108).
    const isFirstUserMessageTurn = !hasOtherUserMessages;
    // T3-CUSTOM(expbkt3): END
    // T3-CUSTOM(expbkt3): BEGIN — re-derive the title as a long session drifts
    // from its opening prompt. Reuses the durable regeneration flow (request
    // ids, supersede checks, interrupted-run recovery) rather than renaming
    // directly, so a refresh behaves exactly like the manual action.
    if (!isFirstUserMessageTurn && !isCompactCommand) {
      const { experimental } = yield* serverSettingsService.getSettings;
      const userMessageCount = yield* projectionSnapshotQuery.countThreadUserMessages(
        event.payload.threadId,
      );
      if (
        shouldRefreshThreadTitle({
          userMessageCount,
          titleManuallySet: thread.titleManuallySet,
          settings: experimental.threadTitleMaintenance,
        })
      ) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.meta.update",
            commandId: yield* serverCommandId("thread-title-refresh"),
            threadId: event.payload.threadId,
            regenerateTitle: true,
          })
          .pipe(
            // A title is cosmetic; never let it interfere with starting the turn.
            Effect.catchCause((cause) =>
              Effect.logWarning("scheduled thread title refresh failed to dispatch", {
                threadId: event.payload.threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
      }
    }
    // T3-CUSTOM(expbkt3): END
    if (isFirstUserMessageTurn && !isCompactCommand) {
      const project = yield* resolveProject(thread.projectId);
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: project ? [project] : [],
        }) ?? process.cwd();
      const generationInput = {
        messageText: assistantCitationsToPlainText(recovery?.messageText ?? message.text),
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      // T3-CUSTOM(expbkt3): BEGIN — name the session through the durable
      // regeneration flow instead of upstream's forked fiber, which this fork's
      // durable turn dispatch interrupts before the model answers. See
      // shouldNameThreadFromFirstPrompt for the full reasoning.
      if (
        shouldNameThreadFromFirstPrompt({
          userMessageCount: 1,
          title: thread.title,
          titleManuallySet: thread.titleManuallySet,
          ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
        })
      ) {
        const firstPromptCommandId = yield* serverCommandId("thread-title-first-prompt");
        firstPromptTitleContexts.set(firstPromptCommandId, {
          message: generationInput.messageText,
          attachments: generationInput.attachments ?? [],
        });
        yield* orchestrationEngine
          .dispatch({
            type: "thread.meta.update",
            commandId: firstPromptCommandId,
            threadId: event.payload.threadId,
            regenerateTitle: true,
          })
          .pipe(
            // A title is cosmetic; never let it interfere with starting the turn.
            Effect.catchCause((cause) =>
              Effect.sync(() => firstPromptTitleContexts.delete(firstPromptCommandId)).pipe(
                Effect.andThen(
                  Effect.logWarning("first-prompt thread title naming failed to dispatch", {
                    threadId: event.payload.threadId,
                    cause: Cause.pretty(cause),
                  }),
                ),
              ),
            ),
          );
      } else if (
        canReplaceThreadTitle(thread.title, event.payload.titleSeed, thread.titleManuallySet)
      ) {
        // Retained for upstream parity: reachable only when the durable route
        // declines but the title is still replaceable.
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
      // T3-CUSTOM(expbkt3): END
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

    if (claimGuard !== undefined) yield* claimGuard;
    if (isCompactCommand) {
      if (!hasOtherUserMessages) {
        yield* appendTurnStartFailure(
          "Context compaction failed",
          "Context compaction requires an existing conversation.",
        );
        yield* executionSupervisor.releaseTurnAdmission(
          event.payload.threadId,
          executionId,
          event.sequence,
        );
        return { handledCommand: true, turnId: null } as const;
      }
      const latestThread = yield* resolveThreadShell(event.payload.threadId);
      const projectedBusy =
        latestThread?.session?.status === "starting" || latestThread?.session?.status === "running";
      // T3-CUSTOM(expbkt3): a retained execution snapshot can compatibility-write
      // `running` after the provider already became ready. Only a confirmed live
      // ready runtime without a turn overrides that stale projection; unknown
      // inspection remains safely busy.
      const confirmedIdleProvider = projectedBusy
        ? yield* providerService.inspectSession(event.payload.threadId).pipe(
            Effect.map(
              (inspection) =>
                inspection !== null &&
                inspection.runtimeAlive &&
                inspection.state === "ready" &&
                inspection.activeProviderTurnId === null,
            ),
            Effect.catch(() => Effect.succeed(false)),
          )
        : false;
      if (
        compactingThreadIds.has(event.payload.threadId) ||
        turnsAfterCompaction.has(event.payload.threadId) ||
        (projectedBusy && !confirmedIdleProvider)
      ) {
        yield* appendTurnStartFailure(
          "Context compaction failed",
          "Context compaction is unavailable while a provider turn is running.",
        );
        yield* executionSupervisor.releaseTurnAdmission(
          event.payload.threadId,
          executionId,
          event.sequence,
        );
        return { handledCommand: true, turnId: null } as const;
      }
      compactingThreadIds.add(event.payload.threadId);
      const clearCompacting = Effect.sync(
        () => void compactingThreadIds.delete(event.payload.threadId),
      );
      const compact = Effect.gen(function* () {
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
        Effect.ensuring(clearCompacting),
      );
      // T3-CUSTOM(expbkt3): the durable dispatch scope must own compaction until
      // it finishes; a scoped child would be interrupted as dispatch returns.
      if (claimGuard !== undefined) {
        yield* compact;
      } else {
        yield* compact.pipe(Effect.forkScoped);
      }
      yield* executionSupervisor.releaseTurnAdmission(
        event.payload.threadId,
        executionId,
        event.sequence,
      );
      return { handledCommand: true, turnId: null } as const;
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
      messageText: projectComposerContextForProvider({
        text: recovery?.messageText ?? message.text,
        records: message.context?.records ?? [],
      }),
      ...((recovery === undefined || recovery.useOriginalAttachments) &&
      message.attachments !== undefined
        ? { attachments: message.attachments }
        : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      actorUserId: message.sentByUserId ?? thread.ownerUserId,
      messageSenderUserId: message.sentByUserId ?? null,
      createdAt: event.payload.createdAt,
    }).pipe(
      // T3-CUSTOM(expbkt3): record the failure for the user, then re-fail with
      // the original cause so the durable dispatcher can classify it. Swallowing
      // it here reported every session-start failure as a retryable missing
      // acknowledgement, which burned all recovery attempts on permanent errors
      // like a deleted worktree.
      Effect.catchCause((cause) =>
        recoverTurnStartFailure(cause).pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    );

    const sessionExecutionOptions = yield* resolveSessionExecutionOptions(
      thread,
      "thread.turn.start",
      message.sentByUserId ?? null,
    );

    if (!(yield* executionSupervisor.canContinueExecution(event.payload.threadId, executionId))) {
      // A stop may arrive while the provider process is starting. Ensure a
      // process spawned during that window cannot survive or receive a turn.
      yield* providerService
        .terminateSession({ threadId: event.payload.threadId })
        .pipe(Effect.catchCause(Effect.logWarning));
      return undefined;
    }

    if (claimGuard !== undefined) yield* claimGuard;

    // T3-CUSTOM(expbkt3): the fork awaits the send so turn association can be
    // persisted, so it settles the compaction-resume waiter here rather than in
    // upstream's forked send.
    if (resumed && event.commandId !== null) resumedTurnStarts.delete(event.commandId);
    return yield* executionSupervisor
      .canContinueExecution(event.payload.threadId, executionId)
      .pipe(
        Effect.flatMap((canContinue) =>
          canContinue
            ? providerService.sendTurn(
                { ...sendTurnRequest, clientExecutionId: executionId },
                sessionExecutionOptions,
              )
            : Effect.succeed(undefined),
        ),
        Effect.catchCause((cause) =>
          recoverTurnStartFailure(cause).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
        Effect.ensuring(resumed ? Deferred.succeed(resumed.sent, undefined) : Effect.void),
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
          // T3-CUSTOM(expbkt3): END
          return recoverInterruptFailure(cause);
        }),
      );
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

  // T3-CUSTOM(expbkt3): upper bound on a provider stop holding the reactor lane.
  const SESSION_STOP_TIMEOUT = "15 seconds";

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
    // T3-CUSTOM(expbkt3): a setup is a one-shot command owned by the durable
    // bootstrap operation. Stopping the thread must unblock that exact waiter,
    // without closing unrelated terminals in the same project.
    const stopOwnedSetup =
      Option.isSome(durableIntentRepository) && Option.isSome(terminalManager)
        ? Effect.gen(function* () {
            const items = yield* durableIntentRepository.value.listByThreadId({
              threadId: thread.id,
            });
            // T3-CUSTOM(expbkt3): Stop is projected before this reactor sees
            // its event, so the operation's owning intent is usually already
            // stopped. Its stop-fenced state and sequence prove ownership;
            // a later accepted setup is deliberately ignored.
            for (const item of items.toReversed()) {
              if (!isSetupOwnedByStop(item, event.sequence)) continue;
              const operation = yield* durableIntentRepository.value.getBootstrapOperation({
                workItemId: item.workItemId,
              });
              if (Option.isNone(operation) || operation.value.setupPhase !== "running") continue;
              yield* terminalManager.value
                .stopCommand({ threadId: thread.id, terminalId: operation.value.setupTerminalId })
                .pipe(Effect.catch(() => Effect.void));
              return;
            }
          })
        : Effect.void;
    yield* cancelTurnsAfterCompaction(
      thread.id,
      "The session was stopped during context compaction. Send this message again to continue.",
    )
      .pipe(Effect.andThen(stopOwnedSetup))
      .pipe(
        Effect.andThen(
          // T3-CUSTOM(expbkt3): stop whenever a session record exists, even one
          // already projected as stopped. The projection can lag or lie about
          // a provider process that is still alive; the adapter's stop is the
          // ground truth and is a no-op for a session it does not hold.
          thread.session
            ? providerService.stopSession({ threadId: thread.id }).pipe(
                // T3-CUSTOM(expbkt3): a hung stop cannot hold the shared command lane.
                Effect.timeoutOption(SESSION_STOP_TIMEOUT),
                Effect.tap((stopped) =>
                  Option.isNone(stopped)
                    ? Effect.logWarning("provider session stop timed out on the reactor lane", {
                        threadId: thread.id,
                        timeout: SESSION_STOP_TIMEOUT,
                      })
                    : Effect.void,
                ),
                Effect.asVoid,
              )
            : Effect.void,
        ),
      )
      .pipe(
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
                // T3-CUSTOM(expbkt3): retain conversation identity for reconnect.
                providerThreadId: thread.session?.providerThreadId ?? null,
                runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
                activeTurnId: null,
                lastError: thread.session?.lastError ?? null,
                updatedAt: now,
              },
              createdAt: now,
            }),
        }),
        Effect.tap(() => Effect.sync(() => threadCredentialActors.delete(thread.id))),
        Effect.ensuring(clearStopping),
      );
  });

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

  // T3-CUSTOM(expbkt3): New-thread preparation runs only after the accepted
  // turn and its exact bootstrap specification are durable. Each external
  // step has a persisted uncertainty boundary so a restart never launches a
  // worktree or setup script twice merely because the acknowledgement was lost.
  const prepareDurableBootstrap = Effect.fn("prepareDurableBootstrap")(function* (input: {
    readonly intent: import("../../execution/DurableExecutionIntentRepository.ts").DurableExecutionIntent;
    readonly event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>;
    readonly owner: string;
    readonly generation: number;
  }) {
    const bootstrap = input.event.payload.bootstrap;
    // T3-CUSTOM(expbkt3): atomic create precedes this turn event; waiting here also
    // covers recovery, before setup terminals or providers can reuse the thread id.
    if (bootstrap?.createThread) yield* threadDeletionReactor.drainThrough(input.event.sequence);
    if (bootstrap === undefined || Option.isNone(durableIntentRepository)) return;
    const resolvedBootstrapRequest = bootstrap.resolvedRequest;
    const resolvedBootstrapWorkspace = resolvedBootstrapRequest?.workspace;
    const resolvedBootstrapCwd =
      resolvedBootstrapWorkspace?.mode === "new-worktree"
        ? resolvedBootstrapWorkspace.projectCwd
        : resolvedBootstrapWorkspace?.path;
    const repository = durableIntentRepository.value;
    const operation = yield* repository.getBootstrapOperation({
      workItemId: input.intent.workItemId,
    });
    if (Option.isNone(operation)) {
      return yield* new DurableExecutionDispatchError({
        failureType: "bootstrap-state-missing",
        detail: "The accepted bootstrap specification has no durable operation record.",
        retryable: false,
      });
    }
    const fail = (failureType: string, detail: string, retryable: boolean, cause?: unknown) =>
      new DurableExecutionDispatchError({
        failureType,
        detail,
        retryable,
        ...(cause === undefined ? {} : { cause }),
      });
    const currentTime = () => Effect.map(DateTime.now, DateTime.formatIso);
    let thread = yield* resolveThreadDetail(input.intent.threadId);
    if (!thread) {
      return yield* fail(
        "bootstrap-thread-missing",
        "The thread committed with this durable work item is no longer available.",
        false,
      );
    }
    let worktreePath = thread.worktreePath ?? operation.value.worktreePath;

    const worktreeStep = yield* repository.beginBootstrapStep({
      workItemId: input.intent.workItemId,
      owner: input.owner,
      generation: input.generation,
      step: "worktree",
      at: yield* currentTime(),
    });
    if (Option.isNone(worktreeStep)) {
      return yield* fail(
        "bootstrap-claim-fenced",
        "Bootstrap preparation lost its execution claim before worktree reconciliation.",
        false,
      );
    }

    if (worktreeStep.value !== "acknowledged" && worktreeStep.value !== "not-required") {
      const prepare = bootstrap.prepareWorktree;
      const resolvedPrepare =
        resolvedBootstrapWorkspace?.mode === "new-worktree"
          ? resolvedBootstrapWorkspace
          : undefined;
      if (prepare === undefined && resolvedPrepare === undefined) {
        return yield* fail(
          "bootstrap-worktree-spec-missing",
          "Durable worktree state requires preparation but the accepted specification is absent.",
          false,
        );
      }
      const projectCwd = prepare?.projectCwd ?? resolvedPrepare!.projectCwd;
      const targetBranch = prepare?.branch ?? prepare?.baseBranch ?? resolvedPrepare?.newBranch;
      if (targetBranch === undefined) {
        return yield* fail(
          "bootstrap-worktree-branch-missing",
          "The durable bootstrap has no deterministic worktree branch identity.",
          false,
        );
      }
      const deterministicPath =
        resolvedPrepare?.intendedPath ??
        path.join(
          serverConfig.worktreesDir,
          path.basename(projectCwd),
          targetBranch.replace(/\//g, "-"),
        );
      const candidatePath = worktreePath ?? deterministicPath;
      const candidateExists = yield* fileSystem
        .exists(candidatePath)
        .pipe(
          Effect.mapError((cause) =>
            fail(
              "bootstrap-worktree-inspection-failed",
              `Could not inspect deterministic worktree path '${candidatePath}'.`,
              true,
              cause,
            ),
          ),
        );
      if (candidateExists) {
        const status = yield* gitWorkflow
          .localStatus({ cwd: candidatePath })
          .pipe(
            Effect.mapError((cause) =>
              fail(
                "bootstrap-worktree-inspection-failed",
                `Could not reconcile the existing worktree '${candidatePath}'.`,
                true,
                cause,
              ),
            ),
          );
        if (!status.isRepo || status.refName !== targetBranch) {
          return yield* fail(
            "bootstrap-worktree-conflict",
            `The deterministic path '${candidatePath}' exists but is not worktree branch '${targetBranch}'.`,
            false,
          );
        }
        worktreePath = candidatePath;
      } else {
        if (worktreeStep.value === "running") {
          yield* repository.markBootstrapStepFailed({
            workItemId: input.intent.workItemId,
            owner: input.owner,
            generation: input.generation,
            step: "worktree",
            phase: "uncertain",
            detail:
              "The server restarted during worktree creation and no matching deterministic worktree can be proven.",
            at: yield* currentTime(),
          });
          return yield* fail(
            "bootstrap-worktree-uncertain",
            "The server restarted during worktree creation and no matching deterministic worktree can be proven.",
            false,
          );
        }
        if (
          !(yield* repository.isClaimCurrent({
            workItemId: input.intent.workItemId,
            owner: input.owner,
            generation: input.generation,
            now: yield* currentTime(),
          }))
        ) {
          return yield* fail(
            "bootstrap-claim-fenced",
            "Bootstrap preparation was stopped before worktree creation.",
            false,
          );
        }
        let baseBranch = prepare?.baseBranch ?? null;
        // "Start from origin" is a stored default; repos without an origin
        // remote fall back to the local base branch instead of failing the
        // whole bootstrap on `git fetch origin`. Upstream applies this in
        // ws.ts; the fork relocated this block here, so it carries the guard.
        const legacyOriginExists = yield* gitWorkflow
          .remoteExists({ cwd: projectCwd, remoteName: "origin" })
          .pipe(Effect.orElseSucceed(() => false));
        // T3-CUSTOM(expbkt3): legacy mobile carries the effective origin
        // default separately from user provenance, matching durable bootstrap.
        if (
          prepare?.startFromOrigin === true &&
          !legacyOriginExists &&
          prepare.baseRefExplicit === true
        ) {
          return yield* fail(
            "bootstrap-worktree-base-unavailable",
            "The selected origin worktree base is unavailable because this repository has no origin remote.",
            false,
          );
        }
        let startFromOrigin = prepare?.startFromOrigin === true && legacyOriginExists;
        if (resolvedPrepare !== undefined) {
          const explicitlyRequestedOrigin = resolvedPrepare.originBaseExplicitlyRequested === true;
          const originExists =
            resolvedPrepare.baseRef.source !== "origin" ||
            (yield* gitWorkflow
              .remoteExists({ cwd: projectCwd, remoteName: "origin" })
              .pipe(Effect.orElseSucceed(() => false)));
          if (
            resolvedPrepare.baseRef.source === "origin" &&
            !originExists &&
            explicitlyRequestedOrigin
          ) {
            return yield* fail(
              "bootstrap-worktree-base-unavailable",
              "The selected origin worktree base is unavailable because this repository has no origin remote.",
              false,
            );
          }
          // A resolved origin base inherited from defaults is a preference, not
          // an explicit remote selection. Preserve the local default fallback
          // used by the legacy path when this repository has no origin.
          const baseRef =
            resolvedPrepare.baseRef.source === "origin" && !originExists
              ? { kind: "repository-default" as const, source: "local" as const }
              : resolvedPrepare.baseRef;
          startFromOrigin = baseRef.source === "origin";
          if (startFromOrigin) {
            yield* gitWorkflow
              .fetchRemote({ cwd: projectCwd, remoteName: "origin" })
              .pipe(
                Effect.mapError((cause) =>
                  fail(
                    "bootstrap-worktree-fetch-failed",
                    `Could not fetch the configured base for '${targetBranch}'.`,
                    true,
                    cause,
                  ),
                ),
              );
          }
          const exactBaseRef = yield* resolveAvailableWorktreeBase({
            cwd: projectCwd,
            baseRef,
            listRefs: gitWorkflow.listRefs,
            resolveRemoteTrackingCommit: gitWorkflow.resolveRemoteTrackingCommit,
          }).pipe(
            Effect.mapError((cause) =>
              fail(
                "bootstrap-worktree-base-unavailable",
                "Could not inspect the configured worktree base.",
                true,
                cause,
              ),
            ),
          );
          if (exactBaseRef === null || exactBaseRef.kind !== "branch") {
            return yield* fail(
              "bootstrap-worktree-base-unavailable",
              "The configured worktree base is no longer available.",
              false,
            );
          }
          baseBranch = exactBaseRef.branch;
          startFromOrigin = exactBaseRef.source === "origin";
        }
        if (baseBranch === null) {
          return yield* fail(
            "bootstrap-worktree-base-unavailable",
            "The accepted worktree specification has no base branch.",
            false,
          );
        }
        let worktreeBaseRef = baseBranch;
        if (startFromOrigin) {
          if (resolvedPrepare === undefined) {
            yield* gitWorkflow
              .fetchRemote({ cwd: projectCwd, remoteName: "origin" })
              .pipe(
                Effect.mapError((cause) =>
                  fail(
                    "bootstrap-worktree-fetch-failed",
                    `Could not fetch the base for '${targetBranch}'.`,
                    true,
                    cause,
                  ),
                ),
              );
          }
          // T3-CUSTOM(expbkt3): port upstream's legacy "start from origin"
          // fallback when origin exists but the selected remote branch does not.
          const remoteBaseExists =
            resolvedPrepare !== undefined ||
            (yield* gitWorkflow
              .remoteBranchExists({
                cwd: projectCwd,
                refName: baseBranch,
                remoteName: "origin",
              })
              .pipe(
                Effect.mapError((cause) =>
                  fail(
                    "bootstrap-worktree-base-unavailable",
                    "Could not inspect the remote base branch.",
                    true,
                    cause,
                  ),
                ),
              ));
          if (remoteBaseExists) {
            const resolved = yield* gitWorkflow
              .resolveRemoteTrackingCommit({
                cwd: projectCwd,
                refName: baseBranch,
                fallbackRemoteName: "origin",
              })
              .pipe(
                Effect.mapError((cause) =>
                  fail(
                    "bootstrap-worktree-base-unavailable",
                    `Could not resolve base branch '${baseBranch}'.`,
                    false,
                    cause,
                  ),
                ),
              );
            worktreeBaseRef = resolved.commitSha;
          }
        }
        if (
          !(yield* repository.beginWorktreeCreation({
            workItemId: input.intent.workItemId,
            owner: input.owner,
            generation: input.generation,
            at: yield* currentTime(),
          }))
        ) {
          return yield* fail(
            "bootstrap-claim-fenced",
            "Bootstrap preparation lost its execution claim before worktree creation.",
            false,
          );
        }
        // T3-CUSTOM(expbkt3): BEGIN — one worktree per (parent, repository).
        // Sibling sessions that share a parent's worktree for a repository are
        // handed the same branch and the same deterministic path, so creation
        // is serialised on that path and the sibling arriving second adopts
        // what the first built instead of failing on a path that now exists.
        const created = yield* withWorktreeCreationPermit(
          deterministicPath,
          Effect.gen(function* () {
            const builtWhileWaiting = yield* fileSystem
              .exists(deterministicPath)
              .pipe(Effect.orElseSucceed(() => false));
            if (builtWhileWaiting) return null;
            return yield* gitWorkflow.createWorktree({
              cwd: projectCwd,
              refName: worktreeBaseRef,
              ...(resolvedPrepare !== undefined || prepare?.branch !== undefined
                ? { newRefName: targetBranch }
                : {}),
              baseRefName: baseBranch,
              path: deterministicPath,
            });
          }),
        ).pipe(
          Effect.mapError((cause) =>
            fail(
              "bootstrap-worktree-create-failed",
              `Could not create worktree branch '${targetBranch}'.`,
              true,
              cause,
            ),
          ),
        );
        worktreePath = created === null ? deterministicPath : created.worktree.path;
        // T3-CUSTOM(expbkt3): END
      }

      yield* orchestrationEngine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`durable-bootstrap:worktree:${input.intent.workItemId}`),
          threadId: input.intent.threadId,
          branch: targetBranch,
          worktreePath,
        })
        .pipe(
          Effect.mapError((cause) =>
            fail(
              "bootstrap-worktree-record-failed",
              "The worktree exists but its durable thread metadata could not be recorded.",
              true,
              cause,
            ),
          ),
        );
      if (
        !(yield* repository.acknowledgeBootstrapStep({
          workItemId: input.intent.workItemId,
          owner: input.owner,
          generation: input.generation,
          step: "worktree",
          worktreePath,
          at: yield* currentTime(),
        }))
      ) {
        return yield* fail(
          "bootstrap-claim-fenced",
          "Worktree preparation completed after the execution claim was fenced.",
          false,
        );
      }
      yield* vcsStatusBroadcaster
        .refreshStatus(worktreePath)
        .pipe(Effect.ignoreCause({ log: true }));
      thread = (yield* resolveThreadDetail(input.intent.threadId)) ?? thread;
    }

    const setupStep = yield* repository.beginBootstrapStep({
      workItemId: input.intent.workItemId,
      owner: input.owner,
      generation: input.generation,
      step: "setup",
      at: yield* currentTime(),
    });
    if (Option.isNone(setupStep)) {
      return yield* fail(
        "bootstrap-claim-fenced",
        "Bootstrap preparation lost its execution claim before setup reconciliation.",
        false,
      );
    }
    // T3-CUSTOM(expbkt3): publish "worktree done, setup running" to clients; step
    // changes inside one preparation pass are not intent transitions of their own.
    if (setupStep.value === "pending") {
      yield* executionSupervisor
        .refreshIntent(input.intent.threadId)
        .pipe(Effect.ignoreCause({ log: true }));
    }
    if (setupStep.value === "acknowledged" || setupStep.value === "not-required") return;
    const terminalId = operation.value.setupTerminalId;
    if (setupStep.value === "running") {
      const adopted = thread.activities.some(
        (activity) =>
          activity.kind === "setup-script.started" &&
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          "terminalId" in activity.payload &&
          activity.payload.terminalId === terminalId,
      );
      const detail = adopted
        ? "Setup launch was recorded before restart, but its completion cannot be proven. Automatic relaunch is disabled."
        : "Setup launch may have started before restart; automatic relaunch is disabled.";
      yield* repository.markBootstrapStepFailed({
        workItemId: input.intent.workItemId,
        owner: input.owner,
        generation: input.generation,
        step: "setup",
        phase: "uncertain",
        detail,
        at: yield* currentTime(),
      });
      return yield* fail("bootstrap-setup-uncertain", detail, false);
    } else if (setupStep.value === "uncertain") {
      return yield* fail(
        "bootstrap-setup-uncertain",
        operation.value.lastFailureDetail ??
          "Setup delivery is uncertain and cannot be launched again automatically.",
        false,
      );
    } else if (setupStep.value === "failed") {
      return yield* fail(
        "bootstrap-setup-failed",
        operation.value.lastFailureDetail ?? "Setup failed and requires an explicit retry.",
        false,
      );
    } else {
      if (Option.isNone(projectSetupScriptRunner)) {
        return yield* fail(
          "bootstrap-setup-runner-unavailable",
          "The durable setup runner is unavailable in this server environment.",
          false,
        );
      }
      const setupPath =
        worktreePath ??
        thread.worktreePath ??
        bootstrap.prepareWorktree?.projectCwd ??
        resolvedBootstrapCwd;
      if (setupPath === undefined || setupPath === null) {
        return yield* fail(
          "bootstrap-setup-path-missing",
          "The setup script has no durable workspace path.",
          false,
        );
      }
      if (
        !(yield* repository.isClaimCurrent({
          workItemId: input.intent.workItemId,
          owner: input.owner,
          generation: input.generation,
          now: yield* currentTime(),
        }))
      ) {
        return yield* fail(
          "bootstrap-claim-fenced",
          "Bootstrap preparation was stopped before setup launch.",
          false,
        );
      }
      const projectId = bootstrap.createThread?.projectId ?? resolvedBootstrapRequest?.projectId;
      const projectCwd = bootstrap.prepareWorktree?.projectCwd ?? resolvedBootstrapCwd;
      const resultExit = yield* Effect.exit(
        projectSetupScriptRunner.value.runForThread({
          threadId: input.intent.threadId,
          ...(projectId === undefined ? {} : { projectId }),
          ...(projectCwd === undefined ? {} : { projectCwd }),
          worktreePath: setupPath,
          preferredTerminalId: terminalId,
        }),
      );
      if (Exit.isFailure(resultExit)) {
        const setupFailure = Cause.squash(resultExit.cause);
        const failedBeforeLaunch =
          isProjectSetupScriptProjectNotFoundError(setupFailure) ||
          (isProjectSetupScriptOperationError(setupFailure) &&
            setupFailure.operation === "resolveProject");
        const knownCompletedFailure = isProjectSetupScriptCommandError(setupFailure);
        const safeToRetry = failedBeforeLaunch || knownCompletedFailure;
        const detail = knownCompletedFailure
          ? "The setup script completed with a failure."
          : failedBeforeLaunch
            ? "Setup could not start because its project configuration is unavailable."
            : "Setup launch or completion could not be proven.";
        yield* repository.markBootstrapStepFailed({
          workItemId: input.intent.workItemId,
          owner: input.owner,
          generation: input.generation,
          step: "setup",
          phase: safeToRetry ? "failed" : "uncertain",
          detail,
          at: yield* currentTime(),
        });
        return yield* fail(
          safeToRetry ? "bootstrap-setup-failed" : "bootstrap-setup-uncertain",
          detail,
          false,
          setupFailure,
        );
      }
    }
    if (
      !(yield* repository.acknowledgeBootstrapStep({
        workItemId: input.intent.workItemId,
        owner: input.owner,
        generation: input.generation,
        step: "setup",
        at: yield* currentTime(),
      }))
    ) {
      return yield* fail(
        "bootstrap-claim-fenced",
        "Setup preparation completed after the execution claim was fenced.",
        false,
      );
    }
  });

  const assertDurableClaimCurrent = (
    intent: import("../../execution/DurableExecutionIntentRepository.ts").DurableExecutionIntent,
    boundary: string,
  ): Effect.Effect<void, DurableExecutionDispatchError> => {
    const owner = intent.claimOwner;
    const repository = Option.getOrNull(durableIntentRepository);
    if (repository === null || owner === null) {
      return Effect.fail(
        new DurableExecutionDispatchError({
          failureType: "execution-claim-missing",
          detail: `Durable execution claim is unavailable at '${boundary}'.`,
          retryable: false,
        }),
      );
    }
    return Effect.gen(function* () {
      const current = yield* repository
        .isClaimCurrent({
          workItemId: intent.workItemId,
          owner,
          generation: intent.claimGeneration,
          now: yield* Effect.map(DateTime.now, DateTime.formatIso),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DurableExecutionDispatchError({
                failureType: "execution-claim-check-failed",
                detail: `Durable execution claim could not be checked at '${boundary}'.`,
                retryable: true,
                cause,
              }),
          ),
        );
      if (!current) {
        return yield* new DurableExecutionDispatchError({
          failureType: "execution-claim-fenced",
          detail: `Durable execution was fenced before '${boundary}'.`,
          retryable: false,
        });
      }
    });
  };

  const dispatchTurnAdoption = (input: {
    readonly intent: import("../../execution/DurableExecutionIntentRepository.ts").DurableExecutionIntent;
    readonly expectedActiveTurnId: TurnId;
    readonly providerTurnId: TurnId;
  }) =>
    Effect.gen(function* () {
      return yield* orchestrationEngine.dispatch({
        type: "thread.turn.adopt",
        commandId: CommandId.make(`server:provider-turn-adopt:${input.intent.workItemId}`),
        threadId: input.intent.threadId,
        messageId: MessageId.make(input.intent.messageId),
        expectedActiveTurnId: input.expectedActiveTurnId,
        providerTurnId: input.providerTurnId,
        createdAt: yield* Effect.map(DateTime.now, DateTime.formatIso),
      });
    });

  const dispatchDurableOriginal = Effect.fn("dispatchDurableOriginal")(function* (input: {
    readonly intent: import("../../execution/DurableExecutionIntentRepository.ts").DurableExecutionIntent;
    readonly event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>;
  }) {
    const thread = yield* resolveThreadDetail(input.intent.threadId);
    if (!thread) {
      return yield* new DurableExecutionDispatchError({
        failureType: "thread-missing",
        detail: `Thread '${input.intent.threadId}' no longer exists.`,
        retryable: false,
      });
    }
    // T3-CUSTOM(expbkt3): the provider side effect was already acknowledged,
    // but its visible same-turn association was not. This durable retry must
    // issue only the idempotent association command after a restart.
    if (
      input.intent.lastFailureType === "turn-association-pending" &&
      input.intent.providerTurnId !== null &&
      input.intent.adoptedExecutionId !== null
    ) {
      const providerTurnId = TurnId.make(input.intent.providerTurnId);
      const association = yield* Effect.exit(
        dispatchTurnAdoption({
          intent: input.intent,
          expectedActiveTurnId: providerTurnId,
          providerTurnId,
        }),
      );
      if (Exit.isFailure(association)) {
        if (Cause.hasInterruptsOnly(association.cause)) {
          return yield* Effect.failCause(association.cause);
        }
        return {
          providerTurnId: input.intent.providerTurnId,
          providerInstanceId: input.intent.providerInstanceId,
          adoptedExecutionId: input.intent.adoptedExecutionId,
          associationPending: {
            providerTurnId: input.intent.providerTurnId,
            providerInstanceId: input.intent.providerInstanceId,
            adoptedExecutionId: input.intent.adoptedExecutionId,
          },
        };
      }
      const terminalSession =
        thread.session != null &&
        (thread.session.status === "ready" ||
          thread.session.status === "stopped" ||
          thread.session.status === "error" ||
          thread.session.status === "interrupted") &&
        thread.session.activeTurnId === null;
      return {
        providerTurnId: input.intent.providerTurnId,
        providerInstanceId: input.intent.providerInstanceId,
        adoptedExecutionId: input.intent.adoptedExecutionId,
        associationAcknowledged: true,
        ...(terminalSession ? { completed: true } : {}),
      };
    }
    const acceptedMessage = thread.messages.find(
      (message) => message.id === input.intent.messageId,
    );
    // T3-CUSTOM(expbkt3): compaction is admitted from the projected provider session,
    // which is authoritative after a completed turn. The supervisor consumes that
    // lifecycle stream asynchronously and can briefly retain the previous turn.
    if (acceptedMessage && isCompactCommandMessage(acceptedMessage)) {
      const result = yield* processTurnStartRequested(
        input.event,
        undefined,
        assertDurableClaimCurrent(input.intent, "provider-compaction"),
      ).pipe(
        Effect.mapError((cause) => durableRecoveryFailure(cause, "provider-compaction-failed")),
      );
      if (result === undefined) {
        return yield* new DurableExecutionDispatchError({
          failureType: "compaction-not-acknowledged",
          detail: "Context compaction completed without a handled-command acknowledgement.",
          retryable: true,
        });
      }
      return {
        providerTurnId: null,
        providerInstanceId:
          thread.session?.providerInstanceId ?? input.intent.modelSelection?.instanceId ?? null,
        adoptedExecutionId: input.intent.workItemId,
        completed: true,
        handledCommand: true,
      };
    }
    const snapshot = yield* executionSupervisor.getSnapshot(input.intent.threadId);
    const supervisorProviderTurnId =
      (snapshot.activity === "active" || snapshot.activity === "blocked") &&
      snapshot.turn?.providerTurnId
        ? snapshot.turn.providerTurnId
        : null;
    // T3-CUSTOM(expbkt3): provider acknowledgement can supply its turn id to
    // the session projection before the supervisor observes that runtime event.
    // Accept that id only while the supervisor independently confirms a live
    // execution, so a stale ready/stopped session cannot create a steer route.
    const activeProviderTurnId =
      supervisorProviderTurnId ??
      ((snapshot.activity === "active" || snapshot.activity === "blocked") &&
      thread.session?.status === "running"
        ? thread.session.activeTurnId
        : null);
    if (activeProviderTurnId !== null && acceptedMessage) {
      yield* assertDurableClaimCurrent(input.intent, "native-command");
      const handled = yield* processNativeAuthCommand(thread, input.event, acceptedMessage).pipe(
        Effect.mapError(
          (cause) =>
            new DurableExecutionDispatchError({
              failureType: "native-auth-command-failed",
              detail: String(cause),
              retryable: false,
              cause,
            }),
        ),
      );
      if (handled) {
        yield* executionSupervisor.releaseTurnAdmission(
          input.intent.threadId,
          input.intent.workItemId,
          input.event.sequence,
        );
        return {
          providerTurnId: null,
          providerInstanceId:
            thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
          adoptedExecutionId: input.intent.workItemId,
          completed: true,
          handledCommand: true,
        };
      }
    }
    if (activeProviderTurnId !== null) {
      const providerInstanceId =
        thread.session?.providerInstanceId ?? input.intent.modelSelection?.instanceId;
      if (providerInstanceId === undefined) {
        return yield* new DurableExecutionDispatchError({
          failureType: "provider-instance-missing",
          detail: "The active turn has no provider instance for busy-message delivery.",
          retryable: false,
        });
      }
      const capabilities = yield* providerService.getCapabilities(providerInstanceId).pipe(
        Effect.mapError(
          (cause) =>
            new DurableExecutionDispatchError({
              failureType: "provider-instance-unavailable",
              detail: String(cause),
              retryable: false,
              cause,
            }),
        ),
      );
      if (capabilities.activeTurnInput === "queue") {
        return {
          providerTurnId: null,
          providerInstanceId,
          deferred: true,
        } as const;
      }
      const message = thread.messages.find((candidate) => candidate.id === input.intent.messageId);
      if (!message || message.role !== "user") {
        return yield* new DurableExecutionDispatchError({
          failureType: "accepted-message-missing",
          detail: `Accepted message '${input.intent.messageId}' is unavailable for steering.`,
          retryable: false,
        });
      }
      const request = yield* buildSendTurnRequestForThread({
        threadId: input.intent.threadId,
        messageText: input.intent.messageText ?? message.text,
        ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
        ...(input.intent.modelSelection === null
          ? {}
          : { modelSelection: input.intent.modelSelection }),
        interactionMode: input.event.payload.interactionMode,
        actorUserId: input.intent.actingUserId ?? thread.ownerUserId,
        messageSenderUserId: input.intent.actingUserId ?? null,
        createdAt: input.event.payload.createdAt,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DurableExecutionDispatchError({
              failureType: "provider-steer-prepare-failed",
              detail: String(cause),
              retryable: true,
              cause,
            }),
        ),
      );
      const executionOptions = yield* resolveSessionExecutionOptions(
        thread,
        "thread.turn.start",
        input.intent.actingUserId ?? null,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new DurableExecutionDispatchError({
              failureType: "provider-steer-options-failed",
              detail: String(cause),
              retryable: true,
              cause,
            }),
        ),
      );
      yield* assertDurableClaimCurrent(input.intent, "provider-steer");
      const steered = yield* providerService
        .sendTurn({ ...request, clientExecutionId: input.intent.workItemId }, executionOptions)
        .pipe(
          Effect.mapError(
            (cause) =>
              new DurableExecutionDispatchError({
                failureType: "provider-steer-failed",
                detail: String(cause),
                retryable: true,
                cause,
              }),
          ),
        );
      if (steered.turnId === undefined || steered.turnId === activeProviderTurnId) {
        // T3-CUSTOM(expbkt3): a same-turn steer has no lifecycle transition to
        // consume its pending row. Record only the message-to-live-turn
        // association; its projection rechecks that exact turn remains running
        // and cannot resurrect a terminal session with a stale session write.
        // T3-CUSTOM(expbkt3): retry this idempotent association in the same
        // accepted-steer dispatch. Its stable receipt key means a persistence
        // retry cannot resend the provider input or create a second event.
        const association = yield* Effect.exit(
          dispatchTurnAdoption({
            intent: input.intent,
            expectedActiveTurnId: activeProviderTurnId,
            providerTurnId: activeProviderTurnId,
          }),
        );
        if (Exit.isFailure(association)) {
          if (Cause.hasInterruptsOnly(association.cause)) {
            return yield* Effect.failCause(association.cause);
          }
          return {
            providerTurnId: activeProviderTurnId,
            providerInstanceId,
            adoptedExecutionId: snapshot.turn?.executionId ?? input.intent.workItemId,
            associationPending: {
              providerTurnId: activeProviderTurnId,
              providerInstanceId,
              adoptedExecutionId: snapshot.turn?.executionId ?? input.intent.workItemId,
            },
          };
        }
      }
      return {
        providerTurnId: steered.turnId ?? activeProviderTurnId,
        providerInstanceId,
        adoptedExecutionId: snapshot.turn?.executionId ?? input.intent.workItemId,
        associationAcknowledged:
          steered.turnId === undefined || steered.turnId === activeProviderTurnId,
      };
    }

    const result = yield* processTurnStartRequested(
      input.event,
      undefined,
      assertDurableClaimCurrent(input.intent, "provider-turn-start"),
    ).pipe(
      Effect.mapError((cause) => durableRecoveryFailure(cause, "provider-turn-dispatch-failed")),
    );
    if (result === undefined) {
      return yield* new DurableExecutionDispatchError({
        failureType: "provider-turn-not-acknowledged",
        detail: "Provider turn dispatch completed without a turn acknowledgement.",
        retryable: true,
      });
    }
    return {
      providerTurnId: result.turnId,
      providerInstanceId: input.intent.modelSelection?.instanceId ?? null,
      adoptedExecutionId: input.intent.workItemId,
      ...("handledCommand" in result ? { completed: true, handledCommand: true } : {}),
    };
  });

  const appendDurableRecoveryActivity = Effect.fn("appendDurableRecoveryActivity")(
    function* (input: {
      readonly intent: import("../../execution/DurableExecutionIntentRepository.ts").DurableExecutionIntent;
      readonly kind: "started" | "recovered" | "paused" | "exhausted";
      readonly attempt: number;
      readonly detail?: string;
    }) {
      const createdAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
      const presentation =
        input.kind === "started"
          ? { tone: "info" as const, summary: "Recovering interrupted agent work" }
          : input.kind === "recovered"
            ? { tone: "info" as const, summary: "Agent work recovered" }
            : input.kind === "paused"
              ? { tone: "approval" as const, summary: "Recovery paused for attention" }
              : { tone: "error" as const, summary: "Automatic recovery exhausted" };
      yield* orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(
            `durable-recovery:${input.kind}:${input.intent.workItemId}:${input.attempt}`,
          ),
          threadId: input.intent.threadId,
          activity: {
            id: yield* serverEventId(),
            tone: presentation.tone,
            kind: `recovery.${input.kind}`,
            summary: presentation.summary,
            payload: {
              workItemId: input.intent.workItemId,
              attempt: input.attempt,
              maximumAttempts: input.intent.maximumRecoveryAttempts,
              ...(input.detail === undefined ? {} : { detail: input.detail }),
            },
            turnId: null,
            createdAt,
          },
          createdAt,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to append durable recovery activity", {
              threadId: input.intent.threadId,
              workItemId: input.intent.workItemId,
              kind: input.kind,
              attempt: input.attempt,
              cause: Cause.pretty(cause),
            }),
          ),
        );
    },
  );

  // T3-CUSTOM(expbkt3): BEGIN — the coordinator owns every normal/recovery
  // provider turn in production, while this reactor remains the adapter seam.
  const refreshDurablePhaseMetrics = Option.isSome(durableIntentRepository)
    ? Effect.gen(function* () {
        const counts = yield* durableIntentRepository.value.countVisibleByPhase;
        for (const phase of [
          "queued",
          "preparing",
          "starting",
          "running",
          "waiting-for-approval",
          "waiting-for-input",
          "recovering",
          "retry-wait",
          "stopping",
          "recovery-exhausted",
        ]) {
          yield* setMetric(durableExecutions, { phase }, counts[phase] ?? 0);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to refresh durable execution phase metrics", {
            cause: Cause.pretty(cause),
          }),
        ),
      )
    : Effect.void;
  const durableCoordinator = Option.isSome(durableIntentRepository)
    ? yield* makeDurableExecutionCoordinator({
        ownerId: executionSupervisor.authorityEpoch,
        // T3-CUSTOM(expbkt3): intent phases are part of the execution snapshot stream.
        onTransition: ({ intent, threadId }) =>
          Effect.gen(function* () {
            // T3-CUSTOM(expbkt3): `/compact` has no execution snapshot. Its
            // coordinator claim must not republish a retained active snapshot
            // into the legacy session projection before the compact guard runs.
            if (!isCompactCommandText(intent.messageText)) {
              yield* executionSupervisor.refreshIntent(threadId);
            }
            yield* refreshDurablePhaseMetrics;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to publish durable execution transition", {
                threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        onRecoveryActivity: (input) =>
          appendDurableRecoveryActivity(input).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to publish durable recovery activity", {
                threadId: input.intent.threadId,
                workItemId: input.intent.workItemId,
                kind: input.kind,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        terminateObserved: (intent) =>
          providerService.terminateSession({ threadId: intent.threadId }).pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to terminate durable execution provider session", {
                threadId: intent.threadId,
                workItemId: intent.workItemId,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        loadEvent: (intent) =>
          Stream.runHead(
            orchestrationEngine.readEvents((intent.requestEventSequence ?? 1) - 1, 1),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new DurableExecutionDispatchError({
                  failureType: "persisted-event-unavailable",
                  detail: String(cause),
                  retryable: false,
                  cause,
                }),
            ),
            Effect.flatMap((loaded) => {
              const event = Option.getOrNull(loaded);
              return event?.type === "thread.turn-start-requested"
                ? Effect.succeed(event)
                : Effect.fail(
                    new DurableExecutionDispatchError({
                      failureType: "persisted-event-unavailable",
                      detail: `Turn request event sequence '${intent.requestEventSequence}' is unavailable.`,
                      retryable: false,
                    }),
                  );
            }),
          ),
        prepare: (input) =>
          prepareDurableBootstrap(input).pipe(
            Effect.mapError((cause) =>
              normalizeDurableDispatchError(cause, "bootstrap-preparation-failed"),
            ),
          ),
        dispatchOriginal: (input) =>
          dispatchDurableOriginal(input).pipe(
            Effect.mapError((cause) =>
              normalizeDurableDispatchError(cause, "provider-turn-dispatch-failed"),
            ),
          ),
        recover: ({ intent, event, mode }) =>
          Effect.gen(function* () {
            let effectiveMode = mode;
            const inspection = yield* providerService.inspectSession(intent.threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new DurableExecutionDispatchError({
                    failureType: "provider-inspection-failed",
                    detail: String(cause),
                    retryable: true,
                    cause,
                  }),
              ),
            );
            const execution = yield* executionSupervisor.getSnapshot(intent.threadId);
            const activeProviderTurnId = inspection?.activeProviderTurnId ?? null;
            const activeTurnMatches =
              activeProviderTurnId !== null &&
              (activeProviderTurnId === intent.providerTurnId ||
                execution.turn?.executionId === intent.workItemId);
            if (activeTurnMatches) {
              return {
                providerTurnId: activeProviderTurnId,
                providerInstanceId:
                  execution.providerSession.providerInstanceId ??
                  intent.modelSelection?.instanceId ??
                  null,
                adoptedExecutionId: execution.turn?.executionId ?? intent.workItemId,
              };
            }
            if (activeProviderTurnId !== null) {
              const knownEarlierOwner = Option.isSome(durableIntentRepository)
                ? (yield* durableIntentRepository.value.listByThreadId({
                    threadId: intent.threadId,
                  })).some(
                    (item) =>
                      item.workItemId !== intent.workItemId &&
                      item.requestEventSequence !== null &&
                      (intent.requestEventSequence === null ||
                        item.requestEventSequence < intent.requestEventSequence) &&
                      item.providerTurnId === activeProviderTurnId &&
                      item.desiredState === "running",
                  )
                : false;
              if (knownEarlierOwner) {
                // T3-CUSTOM(expbkt3): a provider turn owned by an earlier
                // durable item is normal per-thread queueing. It is neither an
                // ownership breach nor a recovery failure, so release this
                // claim without spending the recovery budget.
                return { providerTurnId: null, providerInstanceId: null, deferred: true };
              }
              return yield* new DurableExecutionDispatchError({
                failureType: "provider-active-turn-mismatch",
                detail: `Provider turn '${activeProviderTurnId}' is active, but it cannot be correlated with work item '${intent.workItemId}'.`,
                retryable: true,
              });
            }
            const thread = yield* resolveThreadDetail(intent.threadId);
            if (!thread) {
              return yield* new DurableExecutionDispatchError({
                failureType: "thread-missing",
                detail: `Thread '${intent.threadId}' no longer exists.`,
                retryable: false,
              });
            }
            const providerInstanceId =
              thread.session?.providerInstanceId ?? intent.modelSelection?.instanceId;
            if (providerInstanceId === undefined) {
              return yield* new DurableExecutionDispatchError({
                failureType: "provider-instance-missing",
                detail: "The durable work item no longer resolves to a provider instance.",
                retryable: false,
              });
            }
            const capabilities = yield* providerService.getCapabilities(providerInstanceId).pipe(
              Effect.mapError(
                (cause) =>
                  new DurableExecutionDispatchError({
                    failureType: "provider-instance-unavailable",
                    detail: String(cause),
                    retryable: false,
                    cause,
                  }),
              ),
            );
            const readProviderThread = providerService.readThread;
            if (mode === "inspect-or-continue" && readProviderThread === undefined) {
              return yield* new DurableExecutionDispatchError({
                failureType: "provider-history-unavailable",
                detail: `Provider instance '${providerInstanceId}' cannot inspect persisted history before guarded continuation.`,
                retryable: false,
              });
            }
            if (
              readProviderThread !== undefined &&
              (mode === "inspect-or-continue" || intent.providerTurnId !== null)
            ) {
              const executionOptions = yield* resolveSessionExecutionOptions(
                thread,
                "thread.turn.start",
                undefined,
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new DurableExecutionDispatchError({
                      failureType: "provider-history-options-failed",
                      detail: String(cause),
                      retryable: true,
                      cause,
                    }),
                ),
              );
              yield* assertDurableClaimCurrent(intent, "provider-history-resume");
              const providerHistoryExit = yield* Effect.exit(
                readProviderThread(intent.threadId, executionOptions),
              );
              if (Exit.isFailure(providerHistoryExit)) {
                const cause = Cause.squash(providerHistoryExit.cause);
                if (intent.providerTurnId === null && providerHistoryReadProvesUndelivered(cause)) {
                  effectiveMode = "exact-undelivered";
                } else {
                  return yield* durableRecoveryFailure(cause, "provider-history-read-failed");
                }
              } else if (
                intent.providerTurnId !== null &&
                providerHistoryProvesCompletion(
                  providerHistoryExit.value,
                  TurnId.make(intent.providerTurnId),
                )
              ) {
                return {
                  providerTurnId: intent.providerTurnId,
                  providerInstanceId,
                  completed: true,
                };
              }
            }
            if (
              effectiveMode === "inspect-or-continue" &&
              capabilities.durableResume === "unsupported"
            ) {
              return yield* new DurableExecutionDispatchError({
                failureType: "durable-resume-unsupported",
                detail: `Provider instance '${providerInstanceId}' cannot safely resume uncertain delivery.`,
                retryable: false,
              });
            }
            const messageText =
              effectiveMode === "exact-undelivered"
                ? (intent.messageText ?? "")
                : buildGuardedContinuationPrompt(intent.messageText);
            if (effectiveMode === "inspect-or-continue") {
              yield* increment(durableExecutionGuardedContinuationsTotal, {
                threadId: intent.threadId,
                workItemId: intent.workItemId,
                providerInstanceId,
              });
            }
            const result = yield* processTurnStartRequested(
              event,
              {
                messageText,
                useOriginalAttachments: effectiveMode === "exact-undelivered",
              },
              assertDurableClaimCurrent(intent, "provider-recovery-turn-start"),
            ).pipe(
              Effect.mapError((cause) =>
                durableRecoveryFailure(cause, "provider-recovery-dispatch-failed"),
              ),
            );
            if (result === undefined) {
              return yield* new DurableExecutionDispatchError({
                failureType: "provider-recovery-not-acknowledged",
                detail: "Guarded recovery completed without provider-turn evidence.",
                retryable: true,
              });
            }
            return {
              providerTurnId: result.turnId,
              providerInstanceId,
              adoptedExecutionId: intent.workItemId,
              ...("handledCommand" in result ? { completed: true, handledCommand: true } : {}),
            };
          }).pipe(
            Effect.mapError((cause) =>
              normalizeDurableDispatchError(cause, "provider-recovery-failed"),
            ),
          ),
      }).pipe(
        Effect.provideService(DurableExecutionIntentRepository, durableIntentRepository.value),
      )
    : null;
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
        yield* threadTitleRegenerationWorker.enqueue(event);
        return;
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThreadShell(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.turn-start-requested":
        if (durableCoordinator !== null && event.commandId !== null) {
          yield* durableCoordinator.wake(event.commandId);
        } else {
          yield* processTurnStartRequested(event);
        }
        return;
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
      case "thread.session-restart-requested":
        if (durableCoordinator !== null && Option.isSome(durableIntentRepository)) {
          // T3-CUSTOM(expbkt3): Retry resets an exhausted work item; it is not
          // a blind provider reconnect and works even when no session remains.
          const items = yield* durableIntentRepository.value.listByThreadId({
            threadId: event.payload.threadId,
          });
          const retried = items.findLast(
            (item) =>
              item.desiredState === "running" &&
              item.phase === "recovering" &&
              item.recoveryAttempts === 0,
          );
          if (retried !== undefined) {
            yield* durableCoordinator.wake(retried.workItemId);
            return;
          }
        }
        yield* processSessionRestartRequested(event);
        // T3-CUSTOM(expbkt3): wake the coordinator instead of dispatching here.
        // Dispatching inline runs the provider start under this bounded,
        // short-lived command fiber; the coordinator's own fiber is the one
        // place a turn start may run from.
        if (durableCoordinator !== null) yield* durableCoordinator.wake("");
        return;
      case "thread.archived":
        // T3-CUSTOM(expbkt3): archive fences the durable item transactionally
        // and also terminates any provider process observed after that fence.
        yield* providerService
          .terminateSession({ threadId: event.payload.threadId })
          .pipe(Effect.catchCause(Effect.logWarning), Effect.asVoid);
        return;
      case "thread.session-set":
        // T3-CUSTOM(expbkt3): see session-restart-requested above.
        if (durableCoordinator !== null) yield* durableCoordinator.wake("");
        return;
      case "thread.settled": {
        const thread = yield* projectionSnapshotQuery.getThreadShellById(event.payload.threadId);
        if (
          Option.isNone(thread) ||
          thread.value.session == null ||
          thread.value.session.status === "stopped"
        ) {
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
    // T3-CUSTOM(expbkt3): bound the one global lane without replacing it.
    runProviderCommandWithinLaneDeadline(processDomainEvent(event), {
      eventType: event.type,
      threadId: event.payload.threadId,
      commandId: event.commandId,
    }).pipe(
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
    const interruptedTitleRegenerations = yield* findInterruptedThreadTitleRegenerations().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to find interrupted title regenerations",
          { cause: Cause.pretty(cause) },
        ).pipe(Effect.as([]));
      }),
    );
    const staleProviderSessions = yield* providerSessionRestartSweep.findStaleProviderSessions();
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        (event.type === "thread.meta-updated" && event.payload.regenerateTitle === true) ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested" ||
        event.type === "thread.session-restart-requested" ||
        event.type === "thread.archived" ||
        event.type === "thread.session-set" ||
        event.type === "thread.settled"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    // Subscribe before returning, even while event handling waits for server activation.
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(domainEvents, processEvent));

    // The domain event stream is hot, so work pending before this reactor
    // starts cannot be resumed. Correlated completions only clear the request
    // captured here, leaving any newer request untouched.
    const clearInterrupted = clearInterruptedThreadTitleRegenerations(
      interruptedTitleRegenerations,
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to clear interrupted title regenerations",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );
    // Provider processes die with the server, so any session the projection
    // still calls live is restart debris. Sweeping it here (after the event
    // stream is attached, so the sweep's own dispatches are processed) is
    // what makes a deploy recoverable without user intervention.
    const sweepStaleSessions =
      providerSessionRestartSweep.sweepStaleProviderSessions(staleProviderSessions);
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* clearInterrupted;
      yield* sweepStaleSessions;
    } else {
      yield* forkParked(clearInterrupted);
      yield* forkParked(sweepStaleSessions);
    }
  });

  return {
    start,
    // T3-CUSTOM(expbkt3): startup invokes this after stale-session reconciliation.
    startDurableRecovery: () =>
      durableCoordinator === null
        ? Effect.void
        : refreshDurablePhaseMetrics.pipe(Effect.andThen(durableCoordinator.start())),
    drain: Effect.gen(function* () {
      yield* worker.drain;
      yield* threadTitleRegenerationWorker.drain;
    }),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
