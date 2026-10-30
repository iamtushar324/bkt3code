import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadWorkspaceGroups from "../persistence/ThreadWorkspaceGroups.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as TurnStartBootstrap from "./turnStartBootstrap.expbkt3.ts";

const projectId = ProjectId.make("project:bootstrap");
const otherProjectId = ProjectId.make("project:other");
const threadId = ThreadId.make("thread:bootstrap");
const turnCommandId = CommandId.make("bridge:turn-start");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const bootstrapTurnStart: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
  type: "thread.turn.start",
  commandId: turnCommandId,
  threadId,
  message: {
    messageId: MessageId.make("message:bootstrap"),
    role: "user",
    text: "Work the ticket",
    attachments: [],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  bootstrap: {
    createThread: {
      projectId,
      title: "Ticket session",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      sourceControlProfileId: null,
      createdAt: "2026-10-30T00:00:00.000Z",
    },
    prepareWorktree: {
      projectCwd: "/repos/bk-docs",
      baseBranch: "main",
      branch: "t3/ticket",
    },
    runSetupScript: true,
  },
  createdAt: "2026-10-30T00:00:00.000Z",
};

interface FakeThread {
  readonly projectId: ProjectId;
  worktreePath: string | null;
  turns: number;
}

interface HarnessOptions {
  /** Hold `git worktree add` until the test releases it. */
  readonly holdWorktree?: boolean;
  readonly seedThread?: FakeThread;
  /** A turn start that already landed under this command id. */
  readonly seedTurnReceipt?: boolean;
}

/**
 * The real bootstrap service over an in-memory engine: `thread.create` fails
 * on an existing thread like the orchestrator's invariant, and a repeated
 * command id replays its receipt.
 */
const makeHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const threads = new Map<ThreadId, FakeThread>();
    if (options.seedThread) threads.set(threadId, options.seedThread);
    const receipts = new Map<
      CommandId,
      { readonly sequence: number; readonly threadId: ThreadId }
    >();
    if (options.seedTurnReceipt) receipts.set(turnCommandId, { sequence: 7, threadId });
    let sequence = 10;
    const commands: Array<OrchestrationCommand> = [];
    const createdWorktrees: Array<string> = [];
    const setupWorktrees: Array<string> = [];
    const worktreeEntered = yield* Deferred.make<void>();
    const worktreeGate = yield* Deferred.make<void>();
    const turnStarted = yield* Deferred.make<void>();
    if (!options.holdWorktree) yield* Deferred.succeed(worktreeGate, undefined);

    const dispatch = (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        commands.push(command);
        const replay = receipts.get(command.commandId);
        if (replay !== undefined) return { sequence: replay.sequence };
        if (command.type === "thread.create") {
          if (threads.has(command.threadId)) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: "thread.create",
              detail: `Thread '${command.threadId}' already exists.`,
            });
          }
          threads.set(command.threadId, {
            projectId: command.projectId,
            worktreePath: command.worktreePath,
            turns: 0,
          });
        }
        if (command.type === "thread.meta.update" && command.worktreePath !== undefined) {
          const thread = threads.get(command.threadId);
          if (thread) thread.worktreePath = command.worktreePath;
        }
        sequence += 1;
        if (command.type === "thread.turn.start") {
          const thread = threads.get(command.threadId);
          if (thread) thread.turns += 1;
          receipts.set(command.commandId, { sequence, threadId: command.threadId });
          yield* Deferred.succeed(turnStarted, undefined);
        }
        return { sequence };
      });

    const service = yield* TurnStartBootstrap.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          Layer.mock(OrchestrationEngine.OrchestrationEngineService)({ dispatch }),
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            isRepository: () => Effect.succeed(true),
            hasCommit: () => Effect.succeed(true),
            createWorktree: (input) =>
              Effect.gen(function* () {
                const path = `/worktrees/${input.newRefName ?? "detached"}`;
                createdWorktrees.push(path);
                yield* Deferred.succeed(worktreeEntered, undefined);
                yield* Deferred.await(worktreeGate);
                return { worktree: { path, refName: input.newRefName ?? "detached" } };
              }),
          }),
          Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
            runForThread: (input) =>
              Effect.sync(() => {
                setupWorktrees.push(input.worktreePath);
                return { status: "no-script" as const };
              }),
          }),
          Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
            enqueueCommand: (effect) => effect,
          }),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
            refreshStatus: () => Effect.die("git status is not part of these tests"),
          }),
          Layer.mock(OrchestrationEffectWorkerV2)({ drain: () => Effect.succeed(0) }),
          Layer.mock(ThreadWorkspaceGroups.ThreadWorkspaceGroupRepository)({}),
          Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
            getByCommandId: (commandId) =>
              Effect.sync(() => {
                const receipt = receipts.get(commandId);
                return receipt === undefined
                  ? Option.none()
                  : Option.some({
                      commandId,
                      threadId: receipt.threadId,
                      commandType: "thread.turn.start",
                      acceptedAt: DateTime.makeUnsafe(0),
                      resultSequence: receipt.sequence,
                      status: "accepted" as const,
                      error: null,
                    });
              }),
          }),
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadShellById: (id) =>
              Effect.sync(() => {
                const thread = threads.get(id);
                if (thread === undefined) return Option.none();
                // Only the fields the resume check reads.
                const shell = {
                  id,
                  projectId: thread.projectId,
                  worktreePath: thread.worktreePath,
                  latestTurn: thread.turns === 0 ? null : { turnId: "run:earlier" },
                  latestUserMessageAt: thread.turns === 0 ? null : "2026-10-30T00:00:00.000Z",
                  ownerUserId: null,
                  memberUserIds: [],
                };
                return Option.some(shell as unknown as OrchestrationThreadShell);
              }),
          }),
        ),
      ),
    );

    const countCommands = (type: OrchestrationCommand["type"]) =>
      commands.filter((command) => command.type === type).length;

    return {
      service,
      threads,
      createdWorktrees,
      setupWorktrees,
      worktreeEntered,
      worktreeGate,
      turnStarted,
      countCommands,
    };
  });

it.effect("finishes the bootstrap and starts the turn after the caller is interrupted", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ holdWorktree: true });
    const caller = yield* harness.service.dispatch(bootstrapTurnStart).pipe(Effect.forkChild);
    yield* Deferred.await(harness.worktreeEntered);

    yield* Fiber.interrupt(caller);
    yield* Deferred.succeed(harness.worktreeGate, undefined);
    yield* Deferred.await(harness.turnStarted);

    assert.deepEqual(harness.createdWorktrees, ["/worktrees/t3/ticket"]);
    assert.deepEqual(harness.setupWorktrees, ["/worktrees/t3/ticket"]);
    assert.equal(harness.threads.get(threadId)?.turns, 1);
    assert.equal(harness.countCommands("thread.delete"), 0);
  }),
);

it.effect("resumes a thread an interrupted bootstrap left without a turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      seedThread: { projectId, worktreePath: null, turns: 0 },
    });

    yield* harness.service.dispatch(bootstrapTurnStart);

    assert.equal(harness.countCommands("thread.create"), 0);
    assert.deepEqual(harness.createdWorktrees, ["/worktrees/t3/ticket"]);
    assert.equal(harness.threads.get(threadId)?.worktreePath, "/worktrees/t3/ticket");
    assert.equal(harness.threads.get(threadId)?.turns, 1);
  }),
);

it.effect("reuses the worktree an earlier attempt already recorded", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      seedThread: { projectId, worktreePath: "/worktrees/earlier", turns: 0 },
    });

    yield* harness.service.dispatch(bootstrapTurnStart);

    assert.deepEqual(harness.createdWorktrees, []);
    assert.deepEqual(harness.setupWorktrees, ["/worktrees/earlier"]);
    assert.equal(harness.threads.get(threadId)?.turns, 1);
  }),
);

it.effect("joins a retry that arrives while the first bootstrap is still running", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ holdWorktree: true });
    const first = yield* harness.service.dispatch(bootstrapTurnStart).pipe(Effect.forkChild);
    yield* Deferred.await(harness.worktreeEntered);
    const retry = yield* harness.service
      .dispatch(bootstrapTurnStart)
      .pipe(Effect.forkChild({ startImmediately: true }));

    yield* Deferred.succeed(harness.worktreeGate, undefined);
    const firstResult = yield* Fiber.join(first);
    const retryResult = yield* Fiber.join(retry);

    assert.deepEqual(retryResult, firstResult);
    assert.deepEqual(harness.createdWorktrees, ["/worktrees/t3/ticket"]);
    assert.equal(harness.countCommands("thread.create"), 1);
    assert.equal(harness.countCommands("thread.turn.start"), 1);
  }),
);

it.effect("answers a retry after the turn landed with the original result", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      seedThread: { projectId, worktreePath: "/worktrees/t3/ticket", turns: 1 },
      seedTurnReceipt: true,
    });

    const result = yield* harness.service.dispatch(bootstrapTurnStart);

    assert.equal(result.sequence, 7);
    assert.equal(harness.countCommands("thread.create"), 0);
    assert.deepEqual(harness.createdWorktrees, []);
    assert.equal(harness.threads.get(threadId)?.turns, 1);
  }),
);

it.effect("still rejects a thread that belongs to another project", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      seedThread: { projectId: otherProjectId, worktreePath: null, turns: 0 },
    });

    const exit = yield* harness.service.dispatch(bootstrapTurnStart).pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(exit));
    assert.deepEqual(harness.createdWorktrees, []);
    assert.equal(harness.countCommands("thread.delete"), 0);
    assert.equal(harness.threads.get(threadId)?.turns, 0);
  }),
);

it.effect("still rejects a thread that already has other turns", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      seedThread: { projectId, worktreePath: null, turns: 1 },
    });

    const exit = yield* harness.service.dispatch(bootstrapTurnStart).pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(exit));
    assert.deepEqual(harness.createdWorktrees, []);
    assert.equal(harness.threads.get(threadId)?.turns, 1);
  }),
);
