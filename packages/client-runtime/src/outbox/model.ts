// T3-CUSTOM(expbkt3): durable client outbox shared by web, desktop, and mobile.
import { isTransportConnectionErrorMessage } from "../errors/transport.ts";
import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
} from "../state/attachments.ts";
import type { EnvironmentShellStatus } from "../state/shell.ts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  PlanId,
  ModelSelection,
  OrchestrationMessageContext,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  RunId,
  OrchestrationV2CreationSource,
  SourceControlProfileId,
  SnapShotSource,
  PastedTextAttachmentSource,
  ThreadId,
  ThreadTurnStartBootstrap,
  type EnvironmentId as EnvironmentIdType,
  type MessageId as MessageIdType,
  type ModelSelection as ModelSelectionType,
  type OrchestrationMessageContext as OrchestrationMessageContextType,
  type ProjectId as ProjectIdType,
  type ProviderInteractionMode as ProviderInteractionModeType,
  type RuntimeMode as RuntimeModeType,
  type SourceControlProfileId as SourceControlProfileIdType,
  type ThreadId as ThreadIdType,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const THREAD_OUTBOX_SCHEMA_VERSION = 7;
const THREAD_OUTBOX_MAX_RETRY_DELAY_MS = 16_000;
export const ANONYMOUS_OUTBOX_IDENTITY = "anonymous";

export class ThreadOutboxPersistenceError extends Schema.TaggedError<ThreadOutboxPersistenceError>()(
  "ThreadOutboxPersistenceError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Message could not be saved locally, so it was not sent.";
  }
}

type ClientTurnStartCommand = import("../operations/commands.ts").StartThreadTurnInput;

const QueuedThreadCreationSchema = Schema.Struct({
  projectId: ProjectId,
  projectTitle: Schema.optional(Schema.String),
  projectCwd: Schema.optional(Schema.String),
  workspaceMode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
  sourceControlProfileId: Schema.optional(SourceControlProfileId),
});

export const QueuedThreadImageAttachmentSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  source: Schema.optional(SnapShotSource),
  // T3-CUSTOM(expbkt3): BEGIN — upstream (#8048) uploads images before send, so a
  // queued attachment may carry only the uploaded asset id. The inline data url
  // (and the preview derived from it) stays optional for locally-held images and
  // for queue entries written by older clients.
  previewUri: Schema.optional(Schema.String),
  dataUrl: Schema.optional(Schema.String),
  fileUri: Schema.optional(Schema.String),
  uploadedAttachmentId: Schema.optional(Schema.String),
  uploadEnvironmentId: Schema.optional(EnvironmentId),
  // T3-CUSTOM(expbkt3): END
});

export const QueuedThreadFileAttachmentSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("file"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  source: Schema.optional(PastedTextAttachmentSource),
  dataUrl: Schema.optional(Schema.String),
  fileUri: Schema.optional(Schema.String),
  uploadedAttachmentId: Schema.optional(Schema.String),
  uploadEnvironmentId: Schema.optional(EnvironmentId),
});

// T3-CUSTOM(expbkt3): retain newer uploaded attachment types across durable replay.
export const QueuedThreadUnknownAttachmentSchema = Schema.Struct({
  ...QueuedThreadImageAttachmentSchema.fields,
  type: Schema.String.check(Schema.isPattern(/^(?!(?:image|file)$)/)),
});

export const QueuedThreadAttachmentSchema = Schema.Union([
  QueuedThreadImageAttachmentSchema,
  QueuedThreadFileAttachmentSchema,
  QueuedThreadUnknownAttachmentSchema,
]);

export const QueuedThreadMessageSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2, 3, 4, 5, 6, THREAD_OUTBOX_SCHEMA_VERSION]),
  environmentId: EnvironmentId,
  identityKey: Schema.optional(Schema.String),
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  context: Schema.optional(OrchestrationMessageContext),
  manualContinuationOfRunId: Schema.optional(RunId),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
  attachments: Schema.Array(QueuedThreadAttachmentSchema),
  modelSelection: Schema.optional(ModelSelection),
  dispatchMode: Schema.optional(Schema.Literals(["auto", "queue", "steer", "restart", "start"])),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(Schema.Struct({ threadId: ThreadId, planId: PlanId })),
  titleSeed: Schema.optional(Schema.String),
  creation: Schema.optional(QueuedThreadCreationSchema),
  deliveryState: Schema.optional(Schema.Literals(["pending", "failed"])),
  failureDetail: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});

const decodeStoredQueuedThreadMessage = Schema.decodeUnknownSync(QueuedThreadMessageSchema);
const encodeStoredQueuedThreadMessage = Schema.encodeUnknownSync(QueuedThreadMessageSchema);

export interface QueuedThreadCreation {
  readonly projectId: ProjectIdType;
  readonly projectTitle?: string | undefined;
  readonly projectCwd?: string | undefined;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin?: boolean | undefined;
  readonly sourceControlProfileId?: SourceControlProfileIdType | undefined;
}

// T3-CUSTOM(expbkt3): mirrors QueuedThreadImageAttachmentSchema. Deliberately not
// extending UploadChatImageAttachment: since upstream #8048 an attachment can be
// uploaded ahead of the send, in which case only its asset id is queued.
export interface QueuedThreadImageAttachment {
  readonly type: "image";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly source?: typeof SnapShotSource.Type | undefined;
  readonly dataUrl?: string | undefined;
  readonly previewUri?: string | undefined;
  readonly fileUri?: string | undefined;
  readonly uploadedAttachmentId?: string | undefined;
  readonly uploadEnvironmentId?: EnvironmentIdType | undefined;
}

export type QueuedThreadFileAttachment = typeof QueuedThreadFileAttachmentSchema.Type;
export type QueuedThreadAttachment =
  | QueuedThreadImageAttachment
  | QueuedThreadFileAttachment
  | typeof QueuedThreadUnknownAttachmentSchema.Type;

export interface QueuedThreadMessage {
  readonly environmentId: EnvironmentIdType;
  /** Authenticated account id. Legacy/local-only entries omit it and use an isolated fallback. */
  readonly identityKey?: string | undefined;
  readonly threadId: ThreadIdType;
  readonly messageId: MessageIdType;
  readonly commandId: CommandId;
  readonly text: string;
  readonly context?: OrchestrationMessageContextType | undefined;
  readonly manualContinuationOfRunId?:
    | ClientTurnStartCommand["manualContinuationOfRunId"]
    | undefined;
  readonly creationSource?: ClientTurnStartCommand["creationSource"] | undefined;
  readonly attachments: ReadonlyArray<QueuedThreadAttachment>;
  readonly modelSelection?: ModelSelectionType | undefined;
  readonly dispatchMode?: "auto" | "queue" | "steer" | "restart" | "start" | undefined;
  readonly runtimeMode?: RuntimeModeType | undefined;
  readonly interactionMode?: ProviderInteractionModeType | undefined;
  readonly bootstrap?: ClientTurnStartCommand["bootstrap"] | undefined;
  readonly sourceProposedPlan?: ClientTurnStartCommand["sourceProposedPlan"] | undefined;
  readonly titleSeed?: string | undefined;
  readonly creation?: QueuedThreadCreation | undefined;
  readonly deliveryState?: "pending" | "failed" | undefined;
  readonly failureDetail?: string | undefined;
  readonly createdAt: string;
}

export interface ThreadSettingsSnapshot {
  readonly modelSelection: ModelSelectionType;
  readonly runtimeMode: RuntimeModeType;
  readonly interactionMode: ProviderInteractionModeType;
}

export function resolveQueuedThreadSettings(
  message: QueuedThreadMessage,
  thread: ThreadSettingsSnapshot,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "showInteractionModeToggle">> = [],
): ThreadSettingsSnapshot {
  const modelSelection = message.modelSelection ?? thread.modelSelection;
  const provider = providers.find(
    (candidate) => candidate.instanceId === modelSelection.instanceId,
  );
  return {
    modelSelection,
    runtimeMode: message.runtimeMode ?? thread.runtimeMode,
    interactionMode:
      provider?.showInteractionModeToggle === false
        ? DEFAULT_PROVIDER_INTERACTION_MODE
        : (message.interactionMode ?? thread.interactionMode),
  };
}

export function modelSelectionsEqual(left: ModelSelectionType, right: ModelSelectionType): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

export function encodeQueuedThreadMessage(message: QueuedThreadMessage): unknown {
  return encodeStoredQueuedThreadMessage({
    schemaVersion: THREAD_OUTBOX_SCHEMA_VERSION,
    ...message,
  });
}

export function decodeQueuedThreadMessage(value: unknown): QueuedThreadMessage {
  const { schemaVersion: _, ...message } = decodeStoredQueuedThreadMessage(value);
  return message;
}

export function outboxIdentityNamespace(
  message: Pick<QueuedThreadMessage, "environmentId" | "identityKey">,
): string {
  return `${message.environmentId}:${encodeURIComponent(message.identityKey ?? ANONYMOUS_OUTBOX_IDENTITY)}`;
}

/** A user-requested retry is distinct from transport replay of the same command. */
export function retryQueuedThreadMessage<Message extends QueuedThreadMessage>(
  message: Message,
  commandId: CommandId,
): Omit<Message, "deliveryState" | "failureDetail"> & { readonly deliveryState: "pending" } {
  const { failureDetail: _failureDetail, deliveryState: _deliveryState, ...pending } = message;
  return { ...pending, commandId, deliveryState: "pending" };
}

export function scopedOutboxThreadKey(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
): string {
  return `${environmentId}:${threadId}`;
}

export function groupQueuedThreadMessages<Message extends QueuedThreadMessage>(
  messages: ReadonlyArray<Message>,
): Record<string, ReadonlyArray<Message>> {
  const deduplicated = new Map<MessageIdType, Message>();
  for (const message of messages) deduplicated.set(message.messageId, message);

  const grouped: Record<string, Array<Message>> = {};
  for (const message of deduplicated.values()) {
    const threadKey = scopedOutboxThreadKey(message.environmentId, message.threadId);
    (grouped[threadKey] ??= []).push(message);
  }
  for (const queue of Object.values(grouped)) {
    queue.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return grouped;
}

export function flattenQueuedThreadMessages<Message extends QueuedThreadMessage>(
  queues: Record<string, ReadonlyArray<Message>>,
): ReadonlyArray<Message> {
  return Object.values(queues).flat();
}

export function threadOutboxRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), THREAD_OUTBOX_MAX_RETRY_DELAY_MS);
}

export type ThreadOutboxDeliveryAction = "wait" | "remove" | "send";

export function resolveThreadOutboxDeliveryAction(input: {
  readonly isCreation: boolean;
  readonly threadExists: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  readonly environmentConnected: boolean;
  readonly threadBusy: boolean;
}): ThreadOutboxDeliveryAction {
  if (input.isCreation) {
    if (input.threadExists) return "remove";
    return input.environmentConnected && input.shellStatus === "live" ? "send" : "wait";
  }
  if (!input.threadExists) return input.shellStatus === "live" ? "remove" : "wait";
  // T3-CUSTOM(expbkt3): relocated from apps/mobile thread-outbox-model.ts; follows
  // upstream #6543 (steer active turns by default) — `threadBusy` no longer gates sends.
  return input.environmentConnected ? "send" : "wait";
}

export type ThreadOutboxDispatchStep =
  | { readonly step: "wait" }
  | { readonly step: "remove" }
  | { readonly step: "retry" }
  | { readonly step: "restore"; readonly reason: string }
  | { readonly step: "send" };

/**
 * Wait for provider and file capabilities before sending. Cleanup does not
 * need config: a creation whose thread exists, or a message whose thread is
 * gone, can still be removed while config loads.
 */
export function resolveThreadOutboxDispatchStep(input: {
  readonly deliveryAction: ThreadOutboxDeliveryAction;
  readonly fileAttachments: ReadonlyArray<{ readonly name: string; readonly sizeBytes: number }>;
  /** Null while the environment's server config has not synced yet. */
  readonly serverConfig: { readonly maxFileUploadBytes: number | undefined } | null;
}): ThreadOutboxDispatchStep {
  if (input.deliveryAction !== "send") {
    return { step: input.deliveryAction };
  }
  if (input.serverConfig === null) {
    return { step: "retry" };
  }
  if (input.fileAttachments.length === 0) {
    return { step: "send" };
  }
  const maxBytes = input.serverConfig.maxFileUploadBytes;
  if (maxBytes === undefined) {
    return { step: "restore", reason: "This server does not support file attachments." };
  }
  const effectiveMaxBytes = clampFileAttachmentUploadBytes(maxBytes);
  const oversized = input.fileAttachments.find(
    (attachment) => attachment.sizeBytes > effectiveMaxBytes,
  );
  return oversized
    ? { step: "restore", reason: fileAttachmentTooLargeMessage(oversized.name, effectiveMaxBytes) }
    : { step: "send" };
}

export function isQueuedThreadCreationSendable(message: QueuedThreadMessage): boolean {
  if (!message.creation) return false;
  if (message.text.trim().length === 0 || message.modelSelection === undefined) return false;
  return message.creation.workspaceMode !== "worktree" || Boolean(message.creation.branch);
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return typeof error.message === "string" ? error.message : null;
  }
  return typeof error === "string" ? error : null;
}

/**
 * Only a failure the server actually decided (`OrchestrationDispatchCommandError`,
 * or an authorization rejection) means the payload itself is bad. The other
 * typed failures a queued send can hit are transport-shaped: a socket that
 * dropped mid-request (`RpcClientError` wrapping a Socket read/write/close
 * reason), or an environment that is not connected or not registered. Those
 * are matched by tag, not by message text, because a `SocketReadError` message
 * is just "An error occurred during Read". A wrong answer here restores the
 * pending task into a draft and it disappears from the list.
 */
export function shouldRetryThreadOutboxDelivery(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "OrchestrationDispatchCommandError":
      case "EnvironmentAuthorizationError":
        return false;
      case "ConnectionTransientError":
      case "RpcClientError":
      case "EnvironmentRpcUnavailableError":
      case "EnvironmentNotRegisteredError":
        return true;
      default:
        break;
    }
  }
  return isTransportConnectionErrorMessage(errorMessage(error));
}

export type ThreadOutboxCommandStage = "settings-sync" | "start-turn";
export type ThreadOutboxFailureAction = "retry" | "fail";

export function resolveThreadOutboxFailureAction(input: {
  readonly stage: ThreadOutboxCommandStage;
  readonly error: unknown;
  readonly interrupted: boolean;
}): ThreadOutboxFailureAction {
  return input.stage === "settings-sync" ||
    input.interrupted ||
    shouldRetryThreadOutboxDelivery(input.error)
    ? "retry"
    : "fail";
}
