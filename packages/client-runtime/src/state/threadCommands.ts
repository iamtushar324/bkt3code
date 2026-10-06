// T3-CUSTOM(expbkt3): persisted V2 sends keep one command id across reconnects.
import { CommandId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import type { AtomRegistry } from "effect/reactivity";
import { createRuntimeCommand } from "./runtime.ts";
import {
  addThreadMember,
  removeThreadMember,
  transferThreadOwnership,
  restartThreadSession,
  type AddThreadMemberInput,
  type RemoveThreadMemberInput,
  type TransferThreadOwnershipInput,
  type RestartThreadSessionInput,
} from "../operations/commandsFork.ts";
import type { ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import {
  WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";

import { createOptimisticThreadLifecycle } from "./threadLifecycle.ts";
import * as DateTime from "effect/DateTime";

import {
  // T3-CUSTOM(expbkt3): dispatch follows local durable persistence.
  runInEnvironment,
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
} from "./runtime.ts";
import {
  type ThreadCommandInput,
  type ArchiveThreadInput,
  type CancelQueuedRunInput,
  type RetryWorkspacePreparationInput,
  type CreateThreadInput,
  type DeleteThreadInput,
  type EditQueuedRunInput,
  type InterruptThreadTurnInput,
  type MarkThreadUnreadInput,
  type ForkThreadFromRunInput,
  type MergeThreadBackInput,
  type PromoteQueuedRunInput,
  type ReorderQueuedRunInput,
  type LinkThreadPullRequestInput,
  type RespondToThreadApprovalInput,
  type RespondToThreadUserInputInput,
  type DismissThreadUserInputInput,
  type RevertThreadCheckpointInput,
  type SetThreadInteractionModeInput,
  type SetThreadRuntimeModeInput,
  type PinThreadInput,
  type ReorderPinnedThreadInput,
  type ReorderActiveThreadInput,
  type SetThreadAutoSettleInput,
  type SettleThreadInput,
  type SnoozeThreadInput,
  type StartThreadTurnInput,
  type StopThreadSessionInput,
  type UnarchiveThreadInput,
  type UnlinkThreadPullRequestInput,
  type UnpinThreadInput,
  type WatchThreadPullRequestInput,
  type UnsettleThreadInput,
  type UnsnoozeThreadInput,
  type UpdateThreadMetadataInput,
  type VisitThreadInput,
  archiveThread,
  cancelQueuedRun,
  createThread,
  deleteThread,
  editQueuedRun,
  interruptThreadTurn,
  forkThreadFromRun,
  markThreadUnread,
  mergeThreadBack,
  promoteQueuedRun,
  reorderQueuedRun,
  resumeThreadQueue,
  retryWorkspacePreparation,
  linkThreadPullRequest,
  respondToThreadApproval,
  respondToThreadUserInput,
  dismissThreadUserInput,
  revertThreadCheckpoint,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  pinThread,
  reorderPinnedThread,
  reorderActiveThread,
  setThreadAutoSettle,
  settleThread,
  snoozeThread,
  startThreadTurn,
  stopThreadSession,
  unarchiveThread,
  unlinkThreadPullRequest,
  unpinThread,
  unsettleThread,
  unsnoozeThread,
  updateThreadMetadata,
  visitThread,
  watchThreadPullRequest,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";

// T3-CUSTOM(expbkt3): every client persists the exact turn before dispatch.
import {
  ANONYMOUS_OUTBOX_IDENTITY,
  beginThreadOutboxDelivery,
  recordThreadOutboxFailure,
  settleThreadOutboxDelivery,
  shouldRetryThreadOutboxDelivery,
  threadOutboxDeliveryKey,
  ThreadOutboxPersistenceError,
  type QueuedThreadMessage,
} from "../outbox/index.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { bumpOutboxRevision } from "./outbox.ts";

export type DurableStartThreadTurnInput = StartThreadTurnInput & {
  /** T3-CUSTOM(expbkt3): local-only account namespace; never crosses the wire. */
  readonly outboxIdentityKey?: string;
};

export type DiscardDurableOutboxInput = Pick<
  QueuedThreadMessage,
  "environmentId" | "identityKey" | "messageId"
>;

// T3-CUSTOM(expbkt3): preserve one command id across timeout, reconnect, and reload.
const startThreadTurnDurably = Effect.fn("ThreadCommands.startThreadTurnDurably")(function* (
  environmentId: QueuedThreadMessage["environmentId"],
  input: DurableStartThreadTurnInput,
  registry: AtomRegistry.AtomRegistry,
) {
  const { outboxIdentityKey = ANONYMOUS_OUTBOX_IDENTITY, ...serverInput } = input;
  const cacheOption = yield* Effect.serviceOption(EnvironmentCacheStore);
  const cache = Option.getOrUndefined(cacheOption);
  const commandId =
    serverInput.commandId ??
    (yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie, Effect.map(CommandId.make)));
  const createdAt =
    serverInput.createdAt ?? (yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)));
  const queuedMessage: QueuedThreadMessage = {
    environmentId,
    identityKey: outboxIdentityKey,
    threadId: serverInput.threadId,
    messageId: serverInput.message.messageId,
    commandId,
    text: serverInput.message.text,
    // T3-CUSTOM(expbkt3): retain citation, comment, and context payloads on replay.
    ...(serverInput.message.context === undefined ? {} : { context: serverInput.message.context }),
    ...(serverInput.manualContinuationOfRunId === undefined
      ? {}
      : { manualContinuationOfRunId: serverInput.manualContinuationOfRunId }),
    ...(serverInput.creationSource === undefined
      ? {}
      : { creationSource: serverInput.creationSource }),
    // T3-CUSTOM(expbkt3): an uploaded attachment already has its asset id and no
    // inline data url; a locally-held one supplies the data url and its preview.
    attachments: serverInput.message.attachments.map(
      (attachment, index): QueuedThreadMessage["attachments"][number] => {
        const dataUrl = "dataUrl" in attachment ? attachment.dataUrl : undefined;
        // T3-CUSTOM(expbkt3): upstream's attachment `id` is optional, so `"id" in
        // attachment` no longer proves it is a string. A queued attachment always
        // needs a definite id, hence the explicit undefined check and the fallback.
        const uploadedId =
          "id" in attachment && attachment.id !== undefined ? attachment.id : undefined;
        const persisted = {
          type: attachment.type,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          id: uploadedId ?? `${serverInput.message.messageId}-${index}`,
          ...(dataUrl === undefined ? {} : { dataUrl, previewUri: dataUrl }),
          ...(uploadedId === undefined
            ? {}
            : { uploadedAttachmentId: uploadedId, uploadEnvironmentId: environmentId }),
        };
        const source = "source" in attachment ? attachment.source : undefined;
        if (attachment.type === "image")
          return { ...persisted, type: "image", ...(source && "kind" in source ? { source } : {}) };
        if (attachment.type === "file")
          return { ...persisted, type: "file", ...(source && "_tag" in source ? { source } : {}) };
        return persisted;
      },
    ),
    ...(serverInput.modelSelection === undefined
      ? {}
      : { modelSelection: serverInput.modelSelection }),
    ...(serverInput.runtimeMode === undefined ? {} : { runtimeMode: serverInput.runtimeMode }),
    ...(serverInput.interactionMode === undefined
      ? {}
      : { interactionMode: serverInput.interactionMode }),
    ...(serverInput.bootstrap === undefined ? {} : { bootstrap: serverInput.bootstrap }),
    ...(serverInput.sourceProposedPlan === undefined
      ? {}
      : { sourceProposedPlan: serverInput.sourceProposedPlan }),
    ...(serverInput.titleSeed === undefined ? {} : { titleSeed: serverInput.titleSeed }),
    deliveryState: "pending",
    // T3-CUSTOM(expbkt3): preserve upstream queue/steer/restart intent across reloads.
    ...(serverInput.dispatchMode === undefined ? {} : { dispatchMode: serverInput.dispatchMode }),
    ...(serverInput.manualContinuationOfRunId === undefined
      ? {}
      : { manualContinuationOfRunId: serverInput.manualContinuationOfRunId }),
    ...(serverInput.creationSource === undefined
      ? {}
      : { creationSource: serverInput.creationSource }),
    createdAt,
  };
  const dispatch = runInEnvironment(
    environmentId,
    startThreadTurn({ ...serverInput, commandId, createdAt }),
  );

  if (cache?.saveOutbox === undefined || cache.removeOutbox === undefined) {
    return yield* dispatch;
  }
  yield* cache.saveOutbox(queuedMessage).pipe(
    Effect.mapError(
      (cause) => new ThreadOutboxPersistenceError({ operation: "save-before-send", cause }),
    ),
    Effect.tap(() =>
      Effect.sync(() => bumpOutboxRevision(registry, environmentId, outboxIdentityKey)),
    ),
    Effect.tapError(() =>
      recordThreadOutboxFailure({
        kind: "persistence",
        operation: "save-before-send",
        outcome: "failed",
      }),
    ),
  );
  // T3-CUSTOM(expbkt3): a replay loop must not send this turn again while it is
  // on the wire, or after it lands — an uploaded attachment is released on the
  // first acknowledgement and the duplicate would fail as "attachment not
  // found". Settling inside `ensuring` also covers interruption.
  const deliveryKey = threadOutboxDeliveryKey({
    environmentId,
    identityKey: outboxIdentityKey,
    messageId: queuedMessage.messageId,
  });
  beginThreadOutboxDelivery(deliveryKey);
  let deliveredExit = false;
  const dispatched = yield* Effect.exit(dispatch).pipe(
    Effect.tap((exit) =>
      Effect.sync(() => {
        deliveredExit = Exit.isSuccess(exit);
      }),
    ),
    Effect.ensuring(Effect.sync(() => settleThreadOutboxDelivery(deliveryKey, deliveredExit))),
  );
  if (Exit.isFailure(dispatched)) {
    const error = Cause.squash(dispatched.cause);
    const retrying = shouldRetryThreadOutboxDelivery(error);
    yield* recordThreadOutboxFailure({
      kind: "delivery",
      operation: "start-turn",
      outcome: retrying ? "retrying" : "failed",
    });
    if (!retrying) {
      yield* cache
        .saveOutbox({
          ...queuedMessage,
          deliveryState: "failed",
          failureDetail: error instanceof Error ? error.message : Cause.pretty(dispatched.cause),
        })
        .pipe(
          Effect.tapError(() =>
            recordThreadOutboxFailure({
              kind: "persistence",
              operation: "save-failure-state",
              outcome: "failed",
            }),
          ),
        );
    }
    // T3-CUSTOM(expbkt3): direct-send failures must wake route-independent replay,
    // including transport failures that keep the saved payload unchanged.
    bumpOutboxRevision(registry, environmentId, outboxIdentityKey);
    return yield* Effect.failCause(dispatched.cause);
  }
  yield* cache.removeOutbox(queuedMessage).pipe(
    Effect.tap(() =>
      Effect.sync(() => bumpOutboxRevision(registry, environmentId, outboxIdentityKey)),
    ),
    Effect.catch(() =>
      recordThreadOutboxFailure({
        kind: "persistence",
        operation: "remove-after-ack",
        outcome: "failed",
      }),
    ),
  );
  return dispatched.value;
});

export type LoadEarlierThreadHistoryInput = {
  readonly threadId: ThreadId;
};

export type {
  ArchiveThreadInput,
  CancelQueuedRunInput,
  CreateThreadInput,
  DeleteThreadInput,
  EditQueuedRunInput,
  InterruptThreadTurnInput,
  MarkThreadUnreadInput,
  ForkThreadFromRunInput,
  MergeThreadBackInput,
  PromoteQueuedRunInput,
  ReorderQueuedRunInput,
  LinkThreadPullRequestInput,
  RespondToThreadApprovalInput,
  RespondToThreadUserInputInput,
  DismissThreadUserInputInput,
  RevertThreadCheckpointInput,
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  PinThreadInput,
  ReorderPinnedThreadInput,
  ReorderActiveThreadInput,
  SetThreadAutoSettleInput,
  SettleThreadInput,
  SnoozeThreadInput,
  StartThreadTurnInput,
  StopThreadSessionInput,
  ThreadCommandInput,
  UnarchiveThreadInput,
  UnlinkThreadPullRequestInput,
  UnpinThreadInput,
  UnsettleThreadInput,
  UnsnoozeThreadInput,
  UpdateThreadMetadataInput,
  VisitThreadInput,
  WatchThreadPullRequestInput,
} from "../operations/commands.ts";

export function createThreadEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
  snapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  const commands = {
    // T3-CUSTOM(expbkt3): BEGIN — durable outbox: let a client drop a pending turn
    // that was persisted before send (see startThreadTurnDurably above).
    queueOutbox: createRuntimeCommand(runtime, {
      label: "environment-data:commands:thread:queue-outbox",
      execute: (message: QueuedThreadMessage, registry) =>
        Effect.gen(function* () {
          const cacheOption = yield* Effect.serviceOption(EnvironmentCacheStore);
          if (Option.isNone(cacheOption) || cacheOption.value.saveOutbox === undefined) {
            return yield* Effect.fail(
              new ThreadOutboxPersistenceError({
                operation: "save-before-send",
                cause: "Outbox storage unavailable",
              }),
            );
          }
          yield* cacheOption.value.saveOutbox(message);
          bumpOutboxRevision(
            registry,
            message.environmentId,
            message.identityKey ?? ANONYMOUS_OUTBOX_IDENTITY,
          );
        }),
    }),
    discardOutbox: createRuntimeCommand(runtime, {
      label: "environment-data:commands:thread:discard-outbox",
      execute: (message: DiscardDurableOutboxInput, registry) =>
        Effect.gen(function* () {
          const cacheOption = yield* Effect.serviceOption(EnvironmentCacheStore);
          if (Option.isNone(cacheOption) || cacheOption.value.removeOutbox === undefined) return;
          yield* cacheOption.value.removeOutbox(message);
          bumpOutboxRevision(
            registry,
            message.environmentId,
            message.identityKey ?? ANONYMOUS_OUTBOX_IDENTITY,
          );
        }),
    }),
    // T3-CUSTOM(expbkt3): END
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:create",
      execute: (input: CreateThreadInput) => createThread(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:delete",
      execute: (input: DeleteThreadInput) => deleteThread(input),
      scheduler,
      concurrency,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:archive",
      execute: (input: ArchiveThreadInput) => archiveThread(input),
      scheduler,
      concurrency,
    }),
    unarchive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unarchive",
      execute: (input: UnarchiveThreadInput) => unarchiveThread(input),
      scheduler,
      concurrency,
    }),
    settle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:settle",
      execute: (input: SettleThreadInput) => settleThread(input),
      scheduler,
      concurrency,
    }),
    unsettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsettle",
      execute: (input: UnsettleThreadInput) => unsettleThread(input),
      scheduler,
      concurrency,
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:snooze",
      execute: (input: SnoozeThreadInput) => snoozeThread(input),
      scheduler,
      concurrency,
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsnooze",
      execute: (input: UnsnoozeThreadInput) => unsnoozeThread(input),
      scheduler,
      concurrency,
    }),
    pin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:pin",
      execute: (input: PinThreadInput) => pinThread(input),
      scheduler,
      concurrency,
    }),
    unpin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unpin",
      execute: (input: UnpinThreadInput) => unpinThread(input),
      scheduler,
      concurrency,
    }),
    reorderPin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-pin",
      execute: (input: ReorderPinnedThreadInput) => reorderPinnedThread(input),
      scheduler,
      concurrency,
    }),
    setAutoSettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-auto-settle",
      execute: (input: SetThreadAutoSettleInput) => setThreadAutoSettle(input),
      scheduler,
      concurrency,
    }),
    reorderActive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-active",
      execute: (input: ReorderActiveThreadInput) => reorderActiveThread(input),
      scheduler,
      concurrency,
    }),
    visit: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:visit",
      execute: (input: VisitThreadInput) => visitThread(input),
      scheduler,
      concurrency,
    }),
    markUnread: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:mark-unread",
      execute: (input: MarkThreadUnreadInput) => markThreadUnread(input),
      scheduler,
      concurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:update-metadata",
      execute: (input: UpdateThreadMetadataInput) => updateThreadMetadata(input),
      scheduler,
      concurrency,
    }),
    linkPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:link-pull-request",
      execute: (input: LinkThreadPullRequestInput) => linkThreadPullRequest(input),
      scheduler,
      concurrency,
    }),
    unlinkPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unlink-pull-request",
      execute: (input: UnlinkThreadPullRequestInput) => unlinkThreadPullRequest(input),
      scheduler,
      concurrency,
    }),
    watchPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:watch-pull-request",
      execute: (input: WatchThreadPullRequestInput) => watchThreadPullRequest(input),
      scheduler,
      concurrency,
    }),
    setRuntimeMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-runtime-mode",
      execute: (input: SetThreadRuntimeModeInput) => setThreadRuntimeMode(input),
      scheduler,
      concurrency,
    }),
    setInteractionMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-interaction-mode",
      execute: (input: SetThreadInteractionModeInput) => setThreadInteractionMode(input),
      scheduler,
      concurrency,
    }),
    // T3-CUSTOM(expbkt3): persist before the environment connection gate.
    startTurn: createRuntimeCommand(runtime, {
      label: "environment-data:commands:thread:start-turn",
      // T3-CUSTOM(expbkt3): durable offline delivery wraps native V2 message dispatch.
      execute: (
        target: {
          readonly environmentId: EnvironmentId;
          readonly input: DurableStartThreadTurnInput;
        },
        registry,
      ) => startThreadTurnDurably(target.environmentId, target.input, registry),
      scheduler,
      concurrency,
    }),
    interruptTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:interrupt-turn",
      execute: (input: InterruptThreadTurnInput) => interruptThreadTurn(input),
      scheduler,
      concurrency,
    }),
    respondToApproval: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-approval",
      execute: (input: RespondToThreadApprovalInput) => respondToThreadApproval(input),
      scheduler,
      concurrency,
    }),
    respondToUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-user-input",
      execute: (input: RespondToThreadUserInputInput) => respondToThreadUserInput(input),
      scheduler,
      concurrency,
    }),
    dismissUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:dismiss-user-input",
      execute: (input: DismissThreadUserInputInput) => dismissThreadUserInput(input),
      scheduler,
      concurrency,
    }),
    revertCheckpoint: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:revert-checkpoint",
      execute: (input: RevertThreadCheckpointInput) => revertThreadCheckpoint(input),
      scheduler,
      concurrency,
    }),
    stopSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:stop-session",
      execute: (input: StopThreadSessionInput) => stopThreadSession(input),
      scheduler,
      concurrency,
    }),
    // T3-CUSTOM(expbkt3): BEGIN — session restart and thread membership commands.
    restartSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:restart-session",
      execute: (input: RestartThreadSessionInput) => restartThreadSession(input),
      scheduler,
      concurrency,
    }),
    addMember: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:add-member",
      execute: (input: AddThreadMemberInput) => addThreadMember(input),
      scheduler,
      concurrency,
    }),
    removeMember: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:remove-member",
      execute: (input: RemoveThreadMemberInput) => removeThreadMember(input),
      scheduler,
      concurrency,
    }),
    transferOwnership: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:transfer-ownership",
      execute: (input: TransferThreadOwnershipInput) => transferThreadOwnership(input),
      scheduler,
      concurrency,
    }),
    // T3-CUSTOM(expbkt3): END
    forkFromRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:fork-from-run",
      execute: (input: ForkThreadFromRunInput) => forkThreadFromRun(input),
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sourceThreadId]),
      },
    }),
    mergeBack: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:merge-back",
      execute: (input: MergeThreadBackInput) => mergeThreadBack(input),
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.sourceThreadId, input.targetThreadId]),
      },
    }),
    resumeThreadQueue: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:resume-queue",
      execute: (input: ThreadCommandInput) => resumeThreadQueue(input),
      scheduler,
      concurrency,
    }),
    reorderQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-queued-run",
      execute: (input: ReorderQueuedRunInput) => reorderQueuedRun(input),
      scheduler,
      concurrency,
    }),
    promoteQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:promote-queued-run",
      execute: (input: PromoteQueuedRunInput) => promoteQueuedRun(input),
      scheduler,
      concurrency,
    }),
    cancelQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:cancel-queued-run",
      execute: (input: CancelQueuedRunInput) => cancelQueuedRun(input),
      scheduler,
      concurrency,
    }),
    retryWorkspacePreparation: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:retry-workspace-preparation",
      execute: (input: RetryWorkspacePreparationInput) => retryWorkspacePreparation(input),
      scheduler,
      concurrency,
    }),
    editQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:edit-queued-run",
      execute: (input: EditQueuedRunInput) => editQueuedRun(input),
      scheduler,
      concurrency,
    }),
    loadEarlierHistory: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:load-earlier-history",
      execute: (input: LoadEarlierThreadHistoryInput) =>
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
          const controller = yield* Effect.serviceOption(
            ThreadHistoryController.ThreadHistoryController,
          );
          if (Option.isNone(controller)) {
            return {
              _tag: "noop",
            } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
          }
          return yield* controller.value.loadEarlier(
            supervisor.target.environmentId,
            input.threadId,
          );
        }),
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
    }),
    uploadFeedback: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:upload-feedback",
      tag: WS_METHODS.providerUploadFeedback,
      scheduler,
      concurrency,
    }),
  };
  const optimistic = createOptimisticThreadLifecycle(snapshotAtom);
  return {
    ...commands,
    snapshotAtom: optimistic.snapshotAtom,
    settle: optimistic.wrap(commands.settle, (thread, _input, now, accepted) =>
      !accepted &&
      (thread.pendingRuntimeRequest !== null ||
        ["preparing", "queued", "starting", "running", "waiting"].includes(thread.status))
        ? thread
        : {
            ...thread,
            pendingRuntimeRequest: null,
            settledOverride: "settled",
            settledAt: thread.settledOverride === "settled" ? (thread.settledAt ?? now) : now,
            unsettledAt: null,
            activeOrderKey: null,
            pinnedAt: null,
            pinOrderKey: null,
            snoozedAt: null,
            snoozedUntil: null,
          },
    ),
    unsettle: optimistic.wrap(commands.unsettle, (thread, input, now) => ({
      ...thread,
      settledOverride: input.reason === "user" ? "active" : null,
      settledAt: null,
      unsettledAt: thread.settledOverride === "active" ? (thread.unsettledAt ?? null) : now,
    })),
    snooze: optimistic.wrap(commands.snooze, (thread, input, now, accepted) =>
      (!accepted &&
        (thread.pendingRuntimeRequest !== null ||
          ["preparing", "queued", "starting"].includes(thread.status))) ||
      !(Date.parse(input.snoozedUntil) > DateTime.toEpochMillis(now))
        ? thread
        : {
            ...thread,
            pendingRuntimeRequest: null,
            snoozedUntil: DateTime.makeUnsafe(input.snoozedUntil),
            snoozedAt:
              thread.snoozedUntil != null &&
              DateTime.formatIso(thread.snoozedUntil) === input.snoozedUntil
                ? (thread.snoozedAt ?? now)
                : now,
          },
    ),
    unsnooze: optimistic.wrap(commands.unsnooze, (thread) => ({
      ...thread,
      snoozedUntil: null,
      snoozedAt: null,
    })),
    setAutoSettle: optimistic.wrap(commands.setAutoSettle, (thread, input, now) => ({
      ...thread,
      autoSettleDisabledAt: input.enabled ? null : (thread.autoSettleDisabledAt ?? now),
    })),
    pin: optimistic.wrap(commands.pin, (thread, input, now) => ({
      ...thread,
      pinnedAt: thread.pinnedAt ?? now,
      pinOrderKey: thread.pinnedAt == null ? (input.orderKey ?? null) : thread.pinOrderKey,
      ...(thread.settledOverride === "settled"
        ? {
            settledOverride: "active" as const,
            settledAt: null,
            unsettledAt: now,
          }
        : {}),
      snoozedUntil: null,
      snoozedAt: null,
    })),
    unpin: optimistic.wrap(commands.unpin, (thread) => ({
      ...thread,
      pinnedAt: null,
      pinOrderKey: null,
    })),
    reorderPin: optimistic.wrap(commands.reorderPin, (thread, input) => ({
      ...thread,
      pinOrderKey: input.orderKey,
    })),
    reorderActive: optimistic.wrap(commands.reorderActive, (thread, input) => ({
      ...thread,
      activeOrderKey: input.orderKey,
    })),
  };
}
