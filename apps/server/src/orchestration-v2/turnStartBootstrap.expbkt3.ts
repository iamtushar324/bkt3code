/**
 * T3-CUSTOM(expbkt3): server-side `thread.turn.start` bootstrap for callers
 * outside the WebSocket layer.
 *
 * Upstream handles a turn start's `bootstrap` (createThread, prepareWorktree,
 * runSetupScript) inline in `ws.ts`, as a per-connection closure
 * (`dispatchBootstrapTurnStart`). Two fork callers need the same behaviour
 * without a WebSocket connection: the HTTP dispatch route (the Linear bridge
 * creates sessions there) and the MCP control toolkit (`t3_create_session`).
 * This service mirrors upstream's closure step for step — when merging
 * upstream, diff the two — and adds the one fork extension: a child session
 * may share its parent's worktree group (see `../workspace-groups/`).
 *
 * Bootstraps also outlive their caller. The Linear bridge gives up on an HTTP
 * dispatch after 20 s, while `git worktree add` plus a setup script can take
 * longer; an interrupted bootstrap used to leave a thread with no turn, and
 * every retry then failed on the `thread.create` invariant. So the work runs
 * in a detached fiber the caller only waits on, a retry of the same command
 * joins the running bootstrap, and a retry after a lost bootstrap resumes the
 * thread it left behind.
 */
import {
  CommandId,
  EventId,
  OrchestrationDispatchCommandError,
  type OrchestrationClientOrigin,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ProjectId,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadWorkspaceGroups from "../persistence/ThreadWorkspaceGroups.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { withWorktreeCreationPermit } from "../workspace-groups/parentWorkspaceInheritance.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** Preserve the setup runner's broader pre-refactor message normalization. */
function setupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return setupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    default:
      return String(error);
  }
}

function toDispatchCommandError(cause: unknown, fallbackMessage: string) {
  return isOrchestrationDispatchCommandError(cause)
    ? cause
    : new OrchestrationDispatchCommandError({
        message: cause instanceof Error ? cause.message : fallbackMessage,
        cause,
      });
}

/**
 * Runs each keyed bootstrap once, in a fiber detached from the caller. The
 * caller only awaits the result, so its interruption (an HTTP client that gave
 * up) never stops a half-done bootstrap. A caller that arrives with the same
 * key and token while the work runs joins it; a different token for the same
 * key fails, because two bootstraps of one thread would race on its worktree.
 */
function makeDetachedSingleFlight<A>() {
  const running = new Map<
    string,
    {
      readonly token: string;
      readonly result: Deferred.Deferred<A, OrchestrationDispatchCommandError>;
    }
  >();
  return (
    key: string,
    token: string,
    work: Effect.Effect<A, OrchestrationDispatchCommandError>,
  ): Effect.Effect<A, OrchestrationDispatchCommandError> =>
    // Reservation and fork are one uninterruptible step: a caller interrupted
    // between them would leave a registered result no worker ever completes,
    // and every retry would wait on it forever. Only the wait is interruptible.
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const existing = running.get(key);
        if (existing !== undefined) {
          return existing.token === token
            ? restore(Deferred.await(existing.result))
            : Effect.fail(
                new OrchestrationDispatchCommandError({
                  message: `Another bootstrap for ${key} is still running.`,
                }),
              );
        }
        // Map writes stay synchronous, so no other fiber can slip in between the
        // lookup above and this registration.
        const entry = {
          token,
          result: Deferred.makeUnsafe<A, OrchestrationDispatchCommandError>(),
        };
        running.set(key, entry);
        const release = Effect.sync(() => {
          if (running.get(key) === entry) running.delete(key);
        });
        // forkDetach starts the worker interruptible regardless of this mask.
        return work.pipe(
          Effect.ensuring(release),
          Deferred.into(entry.result),
          Effect.forkDetach,
          Effect.flatMap(() => restore(Deferred.await(entry.result))),
        );
      }),
    );
}

/** Team mode: an unrestricted caller, or the thread's owner or a member. */
function isVisibleToActor(
  thread: OrchestrationThreadShell,
  options: TurnStartBootstrapDispatchOptions | undefined,
): boolean {
  const actor = options?.actorUserId ?? null;
  return actor === null || thread.ownerUserId === actor || thread.memberUserIds.includes(actor);
}

export interface TurnStartBootstrapDispatchOptions {
  readonly origin?: OrchestrationClientOrigin;
  /** Acting operator for ownership + audit trail (team mode); null when unrestricted. */
  readonly actorUserId?: UserId | null;
  /**
   * When set, a `prepareWorktree` step joins this parent's worktree for the
   * target repository instead of creating a fresh checkout: the first child to
   * arrive creates and registers the worktree, later siblings reuse it.
   */
  readonly workspaceGroup?: {
    readonly ownerThreadId: ThreadId;
    readonly projectId: ProjectId;
  };
}

type TurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
type ThreadCreateCommand = Extract<OrchestrationCommand, { type: "thread.create" }>;

export interface CreateThreadBootstrapInput {
  readonly create: ThreadCreateCommand;
  readonly prepareWorktree?: NonNullable<TurnStartCommand["bootstrap"]>["prepareWorktree"];
  readonly runSetupScript?: boolean;
}

export class TurnStartBootstrap extends Context.Service<
  TurnStartBootstrap,
  {
    /**
     * Upstream's `dispatchNormalizedCommand` semantics: a turn start carrying
     * `bootstrap` creates the thread, prepares its worktree and launches the
     * setup script before the turn itself; everything else dispatches directly.
     */
    readonly dispatch: (
      command: OrchestrationCommand,
      options?: TurnStartBootstrapDispatchOptions,
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
    /**
     * The same bootstrap without a first turn: `thread.create`, optional
     * worktree preparation and setup script. Used by session creators that have
     * no prompt to send yet.
     */
    readonly createThread: (
      input: CreateThreadBootstrapInput,
      options?: TurnStartBootstrapDispatchOptions,
    ) => Effect.Effect<
      { readonly sequence: number; readonly worktreePath: string | null },
      OrchestrationDispatchCommandError
    >;
  }
>()("t3/orchestration-v2/turnStartBootstrap.expbkt3/TurnStartBootstrap") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const effectWorker = yield* OrchestrationEffectWorkerV2;
  const workspaceGroups = yield* ThreadWorkspaceGroups.ThreadWorkspaceGroupRepository;
  const commandReceipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const projectionQuery = yield* ProjectionSnapshotQuery;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
  const runTurnStartBootstrap = makeDetachedSingleFlight<{ readonly sequence: number }>();
  const runCreateThreadBootstrap = makeDetachedSingleFlight<{
    readonly sequence: number;
    readonly worktreePath: string | null;
  }>();

  const randomUUID = crypto
    .randomUUIDv4()
    .pipe(
      Effect.mapError((cause) =>
        toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
      ),
    );
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const refreshGitStatus = (cwd: string) =>
    vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  const dispatchWithOptions = (
    command: OrchestrationCommand,
    options: TurnStartBootstrapDispatchOptions | undefined,
  ) =>
    orchestrationEngine.dispatch(command, {
      ...(options?.origin !== undefined ? { origin: options.origin } : {}),
      actorUserId: options?.actorUserId ?? null,
    });

  const appendSetupScriptActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) =>
    Effect.all({
      commandId: serverCommandId("setup-script-activity"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const runSetupProgram = Effect.fn("TurnStartBootstrap.runSetupProgram")(function* (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId | undefined;
    readonly projectCwd: string | undefined;
    readonly worktreePath: string;
  }) {
    const requestedAt = yield* nowIso;
    yield* projectSetupScriptRunner
      .runForThread({
        threadId: input.threadId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.projectCwd ? { projectCwd: input.projectCwd } : {}),
        worktreePath: input.worktreePath,
      })
      .pipe(
        Effect.matchEffect({
          onFailure: (error) => {
            const detail = projectSetupScriptCompatibilityDetail(error);
            return appendSetupScriptActivity({
              threadId: input.threadId,
              kind: "setup-script.failed",
              summary: "Setup script failed to start",
              createdAt: requestedAt,
              payload: { detail, worktreePath: input.worktreePath },
              tone: "error",
            }).pipe(
              Effect.ignoreCause({ log: false }),
              Effect.flatMap(() =>
                Effect.logWarning("bootstrap turn start failed to launch setup script", {
                  threadId: input.threadId,
                  worktreePath: input.worktreePath,
                  detail,
                }),
              ),
            );
          },
          onSuccess: (setupResult) =>
            Effect.gen(function* () {
              if (setupResult.status !== "started") {
                return;
              }
              const startedAt = yield* nowIso;
              const payload = {
                scriptId: setupResult.scriptId,
                scriptName: setupResult.scriptName,
                terminalId: setupResult.terminalId,
                worktreePath: input.worktreePath,
              };
              yield* Effect.all([
                appendSetupScriptActivity({
                  threadId: input.threadId,
                  kind: "setup-script.requested",
                  summary: "Starting setup script",
                  createdAt: requestedAt,
                  payload,
                  tone: "info",
                }),
                appendSetupScriptActivity({
                  threadId: input.threadId,
                  kind: "setup-script.started",
                  summary: "Setup script started",
                  createdAt: startedAt,
                  payload,
                  tone: "info",
                }),
              ]).pipe(
                Effect.asVoid,
                Effect.catch((error) =>
                  Effect.logWarning(
                    "bootstrap turn start launched setup script but failed to record setup activity",
                    {
                      threadId: input.threadId,
                      worktreePath: input.worktreePath,
                      scriptId: setupResult.scriptId,
                      terminalId: setupResult.terminalId,
                      detail: error.message,
                    },
                  ),
                ),
              );
            }),
        }),
      );
  });

  /**
   * Resolve the base ref exactly like upstream's ws.ts: "start from origin" is
   * a stored default, and repos without the requested remote branch fall back
   * to the local base branch. Returns null when the base cannot be resolved,
   * which upstream treats as "do not prepare a worktree".
   */
  const resolveWorktreeBase = Effect.fn("TurnStartBootstrap.resolveWorktreeBase")(function* (
    prepareWorktree: NonNullable<NonNullable<TurnStartCommand["bootstrap"]>["prepareWorktree"]>,
  ) {
    const isRepository = yield* gitWorkflow.isRepository(prepareWorktree.projectCwd);
    if (!isRepository) return null;
    let worktreeBaseRef: string = prepareWorktree.baseBranch;
    const startFromOrigin =
      prepareWorktree.startFromOrigin === true &&
      (yield* gitWorkflow.remoteExists({
        cwd: prepareWorktree.projectCwd,
        remoteName: "origin",
      }));
    if (startFromOrigin) {
      yield* gitWorkflow.fetchRemote({ cwd: prepareWorktree.projectCwd, remoteName: "origin" });
      const remoteBaseExists = yield* gitWorkflow.remoteBranchExists({
        cwd: prepareWorktree.projectCwd,
        refName: prepareWorktree.baseBranch,
        remoteName: "origin",
      });
      if (remoteBaseExists) {
        const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
          cwd: prepareWorktree.projectCwd,
          refName: prepareWorktree.baseBranch,
          fallbackRemoteName: "origin",
        });
        worktreeBaseRef = resolvedRemoteBase.commitSha;
      }
    }
    const hasCommit = yield* gitWorkflow.hasCommit({
      cwd: prepareWorktree.projectCwd,
      refName: worktreeBaseRef,
    });
    return hasCommit ? worktreeBaseRef : null;
  });

  /**
   * Create the worktree, or join the parent's shared one when a workspace
   * group is named. Records the new worktree on the thread and refreshes its
   * git status. Returns the worktree path, or null when nothing was prepared.
   */
  const prepareWorktreeFor = Effect.fn("TurnStartBootstrap.prepareWorktree")(function* (input: {
    readonly threadId: ThreadId;
    readonly prepareWorktree: NonNullable<TurnStartCommand["bootstrap"]>["prepareWorktree"];
    readonly options: TurnStartBootstrapDispatchOptions | undefined;
  }) {
    const prepareWorktree = input.prepareWorktree;
    if (!prepareWorktree) return null;
    const group = input.options?.workspaceGroup;

    const createWorktree = Effect.gen(function* () {
      const worktreeBaseRef = yield* resolveWorktreeBase(prepareWorktree);
      if (worktreeBaseRef === null) return null;
      const worktree = yield* gitWorkflow.createWorktree({
        cwd: prepareWorktree.projectCwd,
        refName: worktreeBaseRef,
        newRefName: prepareWorktree.branch,
        baseRefName: prepareWorktree.baseBranch,
        path: null,
      });
      return { path: worktree.worktree.path, branch: worktree.worktree.refName };
    });

    // One worktree per (parent, repository): siblings created together must
    // not race `git worktree add`, so the get-or-create runs under a permit.
    const createOrJoin =
      group === undefined
        ? createWorktree
        : withWorktreeCreationPermit(
            `${group.ownerThreadId}:${group.projectId}`,
            Effect.gen(function* () {
              const existing = yield* workspaceGroups
                .get({ ownerThreadId: group.ownerThreadId, projectId: group.projectId })
                .pipe(Effect.option, Effect.map(Option.flatten));
              if (Option.isSome(existing) && existing.value.isReady) {
                return {
                  path: existing.value.worktreePath,
                  branch: existing.value.branch,
                };
              }
              const created = yield* createWorktree;
              if (created === null) return null;
              // A reservation we cannot write must not block the session. The
              // cost of falling back is one extra worktree, not a failed creation.
              yield* workspaceGroups
                .claim({
                  ownerThreadId: group.ownerThreadId,
                  projectId: group.projectId,
                  branch: created.branch,
                  worktreePath: created.path,
                  createdAt: yield* nowIso,
                })
                .pipe(
                  Effect.flatMap(() =>
                    workspaceGroups.markReady({
                      ownerThreadId: group.ownerThreadId,
                      projectId: group.projectId,
                      worktreePath: created.path,
                    }),
                  ),
                  Effect.ignoreCause({ log: true }),
                );
              return created;
            }),
          );

    const worktree = yield* createOrJoin;
    if (worktree === null) return null;
    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
      threadId: input.threadId,
      branch: worktree.branch,
      worktreePath: worktree.path,
    });
    yield* refreshGitStatus(worktree.path);
    return worktree.path;
  });

  const cleanupCreatedThread = (threadId: ThreadId) =>
    serverCommandId("bootstrap-thread-delete").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({ type: "thread.delete", commandId, threadId }),
      ),
      Effect.asVoid,
    );

  const readThread = (threadId: ThreadId) =>
    projectionQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map((thread) => Option.getOrNull(thread)));

  const withThreadCleanup = <A, E>(
    threadId: ThreadId,
    createdThread: () => boolean,
    program: Effect.Effect<A, E>,
  ): Effect.Effect<A, OrchestrationDispatchCommandError> =>
    program.pipe(
      Effect.catchCause((cause) => {
        const dispatchError = toDispatchCommandError(
          Cause.squash(cause),
          "Failed to bootstrap thread turn start.",
        );
        if (Cause.hasInterruptsOnly(cause) || !createdThread()) {
          return Effect.fail(dispatchError);
        }
        return Effect.uninterruptible(cleanupCreatedThread(threadId)).pipe(
          Effect.matchCauseEffect({
            onFailure: (cleanupCause) =>
              Effect.logWarning("bootstrap thread cleanup failed", {
                threadId,
                detail: Cause.pretty(cleanupCause),
              }).pipe(Effect.flatMap(() => Effect.fail(dispatchError))),
            onSuccess: () =>
              Effect.fail(
                new OrchestrationDispatchCommandError({
                  message: dispatchError.message,
                  ...(dispatchError.cause !== undefined ? { cause: dispatchError.cause } : {}),
                  bootstrapThreadDisposition: "deleted",
                }),
              ),
          }),
        );
      }),
    );

  /**
   * Whether an existing thread is the one an earlier, lost attempt of this
   * bootstrap created: same project, no turn yet, and visible to the actor.
   * When it is not, the caller dispatches `thread.create`, which still fails
   * for a thread that exists.
   */
  const isResumable = (
    thread: OrchestrationThreadShell | null,
    projectId: ProjectId,
    options: TurnStartBootstrapDispatchOptions | undefined,
  ): thread is OrchestrationThreadShell =>
    thread !== null &&
    thread.projectId === projectId &&
    thread.latestTurn === null &&
    thread.latestUserMessageAt === null &&
    isVisibleToActor(thread, options);

  const realPathOf = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));

  /**
   * A worktree an interrupted attempt added for this exact branch but never
   * recorded on the thread. `git worktree add -b <branch>` would fail on every
   * retry, so the resume adopts it — but only a checkout that sits where
   * createWorktree puts new ones (`<managed worktrees folder>/<repo>/<dir>`,
   * compared by real path) and is not the project's own checkout under any
   * spelling. A temporary branch is never on disk under its own name: the
   * worktree takes a generated codename branch, so a retry allocates a fresh
   * one instead of failing, and there is nothing to match here.
   */
  const findUnrecordedWorktree = Effect.fn("TurnStartBootstrap.findUnrecordedWorktree")(
    function* (projectCwd: string, branch: string) {
      if (isTemporaryWorktreeBranch(branch)) return null;
      const listed = yield* gitWorkflow.listRefs({
        cwd: projectCwd,
        query: branch,
        refKind: "local",
        refresh: true,
      });
      const candidate = listed.refs.find(
        (ref) => !ref.isRemote && ref.name === branch && ref.worktreePath !== null,
      )?.worktreePath;
      if (candidate == null) return null;
      const repoName = path.basename(path.resolve(projectCwd));
      if (path.basename(path.dirname(path.resolve(candidate))) !== repoName) return null;
      if ((yield* realPathOf(candidate)) === (yield* realPathOf(projectCwd))) return null;
      return (yield* isManagedWorktreePath(candidate)) ? candidate : null;
    },
  );

  const dispatchBootstrapTurnStart = Effect.fn("TurnStartBootstrap.dispatchBootstrapTurnStart")(
    function* (command: TurnStartCommand, options: TurnStartBootstrapDispatchOptions | undefined) {
      const bootstrap = command.bootstrap;
      const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
      let createdThread = false;
      const targetProjectId = bootstrap?.createThread?.projectId;
      const targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
      let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

      const bootstrapProgram = Effect.gen(function* () {
        const existingThread = yield* readThread(command.threadId);

        // A retry whose turn already landed (the first attempt finished after
        // its caller gave up): the engine replays the stored receipt. Only this
        // thread's own turn message, and only for an actor who may see the thread;
        // any other receipt falls through and fails as before.
        const priorTurn = yield* commandReceipts.getByCommandId(command.commandId);
        if (
          Option.isSome(priorTurn) &&
          priorTurn.value.threadId === command.threadId &&
          // The compatibility engine (Layers/OrchestrationEngine.ts) runs a turn
          // start as a native `message.dispatch` under the same command id, and
          // the receipt carries that native type.
          priorTurn.value.commandType === "message.dispatch" &&
          existingThread !== null &&
          isVisibleToActor(existingThread, options)
        ) {
          return yield* dispatchWithOptions(finalTurnStartCommand, options);
        }

        const resumable =
          bootstrap?.createThread &&
          isResumable(existingThread, bootstrap.createThread.projectId, options)
            ? existingThread
            : null;
        if (resumable !== null) {
          yield* Effect.logInfo("bootstrap turn start resumed a thread left without a turn", {
            threadId: command.threadId,
            worktreePath: resumable.worktreePath,
          });
        }
        // A worktree path other than the one the create asked for was recorded
        // by an earlier attempt's prepare step: reuse it, never add a second one.
        const recordedWorktreePath =
          resumable !== null &&
          resumable.worktreePath !== null &&
          resumable.worktreePath !== (bootstrap?.createThread?.worktreePath ?? null)
            ? resumable.worktreePath
            : null;
        if (recordedWorktreePath !== null) targetWorktreePath = recordedWorktreePath;

        const leftoverBranch = bootstrap?.prepareWorktree?.branch;
        const adoptedWorktreePath =
          resumable !== null &&
          recordedWorktreePath === null &&
          bootstrap?.prepareWorktree !== undefined &&
          leftoverBranch !== undefined &&
          options?.workspaceGroup === undefined
            ? yield* findUnrecordedWorktree(bootstrap.prepareWorktree.projectCwd, leftoverBranch)
            : null;
        if (adoptedWorktreePath !== null && leftoverBranch !== undefined) {
          yield* Effect.logInfo("bootstrap turn start adopted an unrecorded worktree", {
            threadId: command.threadId,
            worktreePath: adoptedWorktreePath,
          });
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
            threadId: command.threadId,
            branch: leftoverBranch,
            worktreePath: adoptedWorktreePath,
          });
          yield* refreshGitStatus(adoptedWorktreePath);
          targetWorktreePath = adoptedWorktreePath;
        }

        if (bootstrap?.createThread && resumable === null) {
          const created = yield* dispatchWithOptions(
            {
              type: "thread.create",
              commandId: yield* serverCommandId("bootstrap-thread-create"),
              threadId: command.threadId,
              ...bootstrap.createThread,
            },
            options,
          );
          // The successful create is a fence in the engine command queue:
          // every delete for the prior incarnation committed before it.
          yield* effectWorker.drain();
          createdThread = true;
        }

        const preparedPath =
          recordedWorktreePath !== null || adoptedWorktreePath !== null
            ? null
            : yield* prepareWorktreeFor({
                threadId: command.threadId,
                prepareWorktree: bootstrap?.prepareWorktree,
                options,
              });
        if (preparedPath !== null) targetWorktreePath = preparedPath;

        if (bootstrap?.runSetupScript && targetWorktreePath) {
          yield* runSetupProgram({
            threadId: command.threadId,
            projectId: targetProjectId,
            projectCwd: targetProjectCwd,
            worktreePath: targetWorktreePath,
          });
        }

        return yield* dispatchWithOptions(finalTurnStartCommand, options);
      });

      return yield* withThreadCleanup(command.threadId, () => createdThread, bootstrapProgram);
    },
  );

  const dispatch: TurnStartBootstrap["Service"]["dispatch"] = (command, options) => {
    const dispatchEffect =
      command.type === "thread.turn.start" && command.bootstrap
        ? dispatchBootstrapTurnStart(command, options)
        : dispatchWithOptions(command, options).pipe(
            Effect.tap(({ sequence }) =>
              command.type === "thread.create" ? effectWorker.drain() : Effect.void,
            ),
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
    const queued = startup
      .enqueueCommand(dispatchEffect)
      .pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
        ),
      );
    return command.type === "thread.turn.start" && command.bootstrap
      ? runTurnStartBootstrap(`thread ${command.threadId}`, command.commandId, queued)
      : queued;
  };

  const createThread: TurnStartBootstrap["Service"]["createThread"] = (input, options) => {
    let createdThread = false;
    const program = Effect.gen(function* () {
      const created = yield* dispatchWithOptions(input.create, options);
      yield* effectWorker.drain();
      createdThread = true;
      const preparedPath = yield* prepareWorktreeFor({
        threadId: input.create.threadId,
        prepareWorktree: input.prepareWorktree,
        options,
      });
      const worktreePath = preparedPath ?? input.create.worktreePath ?? null;
      if (input.runSetupScript && worktreePath) {
        yield* runSetupProgram({
          threadId: input.create.threadId,
          projectId: input.create.projectId,
          projectCwd: input.prepareWorktree?.projectCwd,
          worktreePath,
        });
      }
      return { sequence: created.sequence, worktreePath };
    });
    return runCreateThreadBootstrap(
      `thread ${input.create.threadId}`,
      input.create.commandId,
      startup
        .enqueueCommand(withThreadCleanup(input.create.threadId, () => createdThread, program))
        .pipe(
          Effect.mapError((cause) =>
            toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
          ),
        ),
    );
  };

  return TurnStartBootstrap.of({ dispatch, createThread });
});

/** Test double: dispatches straight to the engine, no bootstrap side effects. */
export const passthroughLayer = Layer.effect(
  TurnStartBootstrap,
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
    return TurnStartBootstrap.of({
      dispatch: (command, options) =>
        orchestrationEngine
          .dispatch(command, { actorUserId: options?.actorUserId ?? null })
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          ),
      createThread: () => Effect.die("TurnStartBootstrap.createThread is not available here"),
    });
  }),
);

/**
 * Needs `ThreadWorkspaceGroups.layer` (shared child worktrees) and the
 * projection query from the caller. The production runtime exposes the shared
 * application receipt repository, not its V2 adapter, so adapt it here.
 */
export const layer = Layer.effect(TurnStartBootstrap, make).pipe(
  Layer.provide(CommandReceiptStore.layerFromApplicationReceipts),
);
