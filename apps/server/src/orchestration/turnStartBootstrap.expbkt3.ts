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
 */
import {
  CommandId,
  EventId,
  OrchestrationDispatchCommandError,
  type OrchestrationClientOrigin,
  type OrchestrationCommand,
  type ProjectId,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadWorkspaceGroups from "../persistence/ThreadWorkspaceGroups.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { withWorktreeCreationPermit } from "../workspace-groups/parentWorkspaceInheritance.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "./Services/ThreadDeletionReactor.ts";

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
>()("t3/orchestration/TurnStartBootstrap") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const workspaceGroups = yield* ThreadWorkspaceGroups.ThreadWorkspaceGroupRepository;

  const randomUUID = crypto.randomUUIDv4.pipe(
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

  const runSetupProgram = (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId | undefined;
    readonly projectCwd: string | undefined;
    readonly worktreePath: string;
  }) =>
    Effect.gen(function* () {
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
  const resolveWorktreeBase = (
    prepareWorktree: NonNullable<NonNullable<TurnStartCommand["bootstrap"]>["prepareWorktree"]>,
  ) =>
    Effect.gen(function* () {
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
  const prepareWorktreeFor = (input: {
    readonly threadId: ThreadId;
    readonly prepareWorktree: NonNullable<TurnStartCommand["bootstrap"]>["prepareWorktree"];
    readonly options: TurnStartBootstrapDispatchOptions | undefined;
  }) =>
    Effect.gen(function* () {
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

  const withThreadCleanup = <A>(
    threadId: ThreadId,
    createdThread: () => boolean,
    program: Effect.Effect<A, unknown>,
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

  const dispatchBootstrapTurnStart = (
    command: TurnStartCommand,
    options: TurnStartBootstrapDispatchOptions | undefined,
  ) =>
    Effect.gen(function* () {
      const bootstrap = command.bootstrap;
      const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
      let createdThread = false;
      const targetProjectId = bootstrap?.createThread?.projectId;
      const targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
      let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

      const bootstrapProgram = Effect.gen(function* () {
        if (bootstrap?.createThread) {
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
          yield* threadDeletionReactor.drainThrough(created.sequence);
          createdThread = true;
        }

        const preparedPath = yield* prepareWorktreeFor({
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
    });

  const dispatch: TurnStartBootstrap["Service"]["dispatch"] = (command, options) => {
    const dispatchEffect =
      command.type === "thread.turn.start" && command.bootstrap
        ? dispatchBootstrapTurnStart(command, options)
        : dispatchWithOptions(command, options).pipe(
            Effect.tap(({ sequence }) =>
              command.type === "thread.create"
                ? threadDeletionReactor.drainThrough(sequence)
                : Effect.void,
            ),
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
    return startup
      .enqueueCommand(dispatchEffect)
      .pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
        ),
      );
  };

  const createThread: TurnStartBootstrap["Service"]["createThread"] = (input, options) => {
    let createdThread = false;
    const program = Effect.gen(function* () {
      const created = yield* dispatchWithOptions(input.create, options);
      yield* threadDeletionReactor.drainThrough(created.sequence);
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
    return startup
      .enqueueCommand(withThreadCleanup(input.create.threadId, () => createdThread, program))
      .pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
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

/** Needs `ThreadWorkspaceGroups.layer` (shared child worktrees) from the caller. */
export const layer = Layer.effect(TurnStartBootstrap, make);
