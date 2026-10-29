// T3-CUSTOM(expbkt3): TEC-1819 — lifecycle actions are safe to retry, and an
// orchestrator refusal reaches the agent as its own reason, not the generic
// "The V2 command could not complete." text.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  OrchestrationDispatchCommandError,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as CommandReceiptStore from "../../../orchestration-v2/CommandReceiptStore.ts";
import { OrchestrationCommandInvariantError } from "../../../orchestration-v2/Errors.ts";
import { OrchestratorDispatchError } from "../../../orchestration-v2/Orchestrator.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import { TurnStartBootstrap } from "../../../orchestration-v2/turnStartBootstrap.expbkt3.ts";
import { rejectionReason, runSessionLifecycle } from "./handlers.ts";

const threadId = ThreadId.make("thread-lifecycle");
const ARCHIVED_AT = "2026-10-28T10:00:00.000Z";

/** The refusal chain the V2 engine produces, with the orchestrator's reason. */
const refusal = (commandType: string, reason: string) =>
  new OrchestrationDispatchCommandError({
    message: `Orchestration command invariant failed (${commandType}): The V2 command could not complete.`,
    cause: new OrchestrationCommandInvariantError({
      commandType,
      detail: "The V2 command could not complete.",
      cause: new OrchestratorDispatchError({
        commandId: CommandId.make("mcp:session-lifecycle:refused"),
        commandType,
        cause: reason,
      }),
    }),
  });

type Action = "archive" | "unarchive" | "stop";

it.layer(NodeServices.layer)("runSessionLifecycle", (it) => {
  let archivedAt: string | null = null;
  let shellReads = 0;
  // A read that lags the writes, as when two calls race past the pre-check.
  let staleView: { readonly archivedAt: string | null } | undefined;
  let failWith: OrchestrationDispatchCommandError | undefined;
  const dispatched: OrchestrationCommand[] = [];
  const receipts = new Map<string, CommandReceiptStore.CommandReceiptV2>();
  const query = {
    getThreadShellById: (id: ThreadId) =>
      Effect.sync(() => {
        shellReads += 1;
        return id === threadId
          ? Option.some({ id, archivedAt: (staleView ?? { archivedAt }).archivedAt })
          : Option.none();
      }),
  } as unknown as ProjectionSnapshotQuery["Service"];
  /** As the V2 orchestrator does: a refused command leaves a rejected receipt. */
  const refuse = (command: OrchestrationCommand, reason: string) => {
    receipts.set(command.commandId, {
      commandId: command.commandId,
      threadId,
      commandType: command.type,
      acceptedAt: DateTime.makeUnsafe(ARCHIVED_AT),
      resultSequence: dispatched.length,
      status: "rejected",
      error: `Failed to dispatch orchestration command ${command.type} (${command.commandId}).`,
    });
    return Effect.fail(refusal(command.type, reason));
  };
  // Behaves like the V2 orchestrator: a known command id replays its receipt
  // (a rejected one fails again), and archive/unarchive refuse a session
  // already in the target state.
  const dispatcher = TurnStartBootstrap.of({
    dispatch: (command) =>
      Effect.suspend(() => {
        const receipt = receipts.get(command.commandId);
        if (receipt?.status === "rejected") {
          return Effect.fail(refusal(command.type, "Previously rejected."));
        }
        if (receipt !== undefined) return Effect.succeed({ sequence: receipt.resultSequence });
        if (failWith !== undefined) return Effect.fail(failWith);
        if (command.type === "thread.archive" && archivedAt !== null) {
          return refuse(command, `Thread ${threadId} is already archived.`);
        }
        if (command.type === "thread.unarchive" && archivedAt === null) {
          return refuse(command, `Thread ${threadId} is not archived.`);
        }
        dispatched.push(command);
        if (command.type === "thread.archive") archivedAt = ARCHIVED_AT;
        if (command.type === "thread.unarchive") archivedAt = null;
        return Effect.succeed({ sequence: dispatched.length });
      }),
    createThread: () => Effect.die("createThread should not be called"),
  });
  const receiptStore = {
    insertIfAbsent: (receipt: CommandReceiptStore.CommandReceiptV2) =>
      Effect.sync(() => {
        if (receipts.has(receipt.commandId)) return false;
        receipts.set(receipt.commandId, receipt);
        return true;
      }),
    upsert: (receipt: CommandReceiptStore.CommandReceiptV2) =>
      Effect.sync(() => {
        receipts.set(receipt.commandId, receipt);
      }),
    getByCommandId: (commandId: CommandId) =>
      Effect.sync(() => Option.fromNullishOr(receipts.get(commandId))),
  } as unknown as CommandReceiptStore.CommandReceiptStoreV2["Service"];
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(TurnStartBootstrap, dispatcher),
      Effect.provideService(ProjectionSnapshotQuery, query),
      Effect.provideService(CommandReceiptStore.CommandReceiptStoreV2, receiptStore),
    );
  const reset = (state: { archivedAt: string | null }) => {
    archivedAt = state.archivedAt;
    shellReads = 0;
    staleView = undefined;
    failWith = undefined;
    dispatched.length = 0;
    receipts.clear();
  };
  const run = (action: Action, commandId?: string) =>
    runSessionLifecycle({
      operation: `session-${action}`,
      sessionId: threadId,
      action,
      commandId: commandId === undefined ? undefined : CommandId.make(commandId),
    }).pipe(provide);

  it.effect("archives an active session, then a retry succeeds without a dispatch", () =>
    Effect.gen(function* () {
      reset({ archivedAt: null });
      const first = yield* run("archive");
      expect(first).toMatchObject({ accepted: true, changed: true, action: "archive" });
      expect(dispatched.map((command) => command.type)).toEqual(["thread.archive"]);

      const retry = yield* run("archive");
      expect(retry).toMatchObject({ accepted: true, changed: false, action: "archive" });
      expect("message" in retry ? retry.message : "").toContain("already archived");
      // The retry read one row and dispatched nothing.
      expect(dispatched).toHaveLength(1);
      expect(shellReads).toBe(2);
    }),
  );

  it.effect("unarchive of an active session is a success with nothing dispatched", () =>
    Effect.gen(function* () {
      reset({ archivedAt: null });
      const outcome = yield* run("unarchive");
      expect(outcome).toMatchObject({ accepted: true, changed: false });
      expect("message" in outcome ? outcome.message : "").toContain("already active");
      expect(dispatched).toHaveLength(0);
    }),
  );

  it.effect("other actions dispatch without reading the session first", () =>
    Effect.gen(function* () {
      reset({ archivedAt: null });
      const outcome = yield* run("stop");
      expect(outcome).toMatchObject({ changed: true });
      expect(dispatched.map((command) => command.type)).toEqual(["thread.session.stop"]);
      expect(shellReads).toBe(0);
    }),
  );

  it.effect("a retried no-op command id replays its outcome after the state changed", () =>
    Effect.gen(function* () {
      reset({ archivedAt: ARCHIVED_AT });
      const first = yield* run("archive", "mcp:agent:archive:x");
      expect(first).toMatchObject({ changed: false });
      expect(receipts.get("mcp:agent:archive:x")).toMatchObject({
        status: "accepted",
        resultSequence: 0,
      });

      // Someone unarchives the session between the call and its retry.
      archivedAt = null;
      const retry = yield* run("archive", "mcp:agent:archive:x");
      expect(retry).toMatchObject({ changed: false });
      expect(archivedAt).toBeNull();
      expect(dispatched).toHaveLength(0);
    }),
  );

  it.effect("two archives that race past the read both succeed", () =>
    Effect.gen(function* () {
      reset({ archivedAt: null });
      staleView = { archivedAt: null };
      const outcomes = yield* Effect.all([run("archive"), run("archive")], {
        concurrency: "unbounded",
      });
      expect(outcomes.map((outcome) => outcome.changed).toSorted()).toEqual([false, true]);
      expect(dispatched.map((command) => command.type)).toEqual(["thread.archive"]);

      // Unarchive has the same race.
      staleView = { archivedAt: ARCHIVED_AT };
      const back = yield* Effect.all([run("unarchive"), run("unarchive")], {
        concurrency: "unbounded",
      });
      expect(back.map((outcome) => outcome.changed).toSorted()).toEqual([false, true]);
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.archive",
        "thread.unarchive",
      ]);
    }),
  );

  it.effect("a race refusal with a caller's id replays as a no-op after the inverse action", () =>
    Effect.gen(function* () {
      reset({ archivedAt: ARCHIVED_AT });
      // The read saw it active; the orchestrator refuses and records a rejection.
      staleView = { archivedAt: null };
      const first = yield* run("archive", "mcp:agent:archive:race");
      expect(first).toMatchObject({ changed: false });
      expect(receipts.get("mcp:agent:archive:race")).toMatchObject({
        status: "accepted",
        resultSequence: 0,
      });

      // Someone unarchives; the same request retries.
      archivedAt = null;
      staleView = undefined;
      const retry = yield* run("archive", "mcp:agent:archive:race");
      expect(retry).toMatchObject({ changed: false });
      expect(archivedAt).toBeNull();
      expect(dispatched).toHaveLength(0);
    }),
  );

  it.effect("an unrelated refusal stays a failure with the orchestrator's own reason", () =>
    Effect.gen(function* () {
      reset({ archivedAt: null });
      failWith = refusal("thread.archive", `Thread ${threadId} is no longer empty.`);
      const error = yield* Effect.flip(run("archive"));
      expect(error._tag).toBe("T3ControlToolError");
      expect(error.message).toBe(`Thread ${threadId} is no longer empty.`);
    }),
  );
});

it("rejectionReason finds a string cause through nested errors, and nothing otherwise", () => {
  expect(rejectionReason(refusal("thread.archive", "Thread t is already archived."))).toBe(
    "Thread t is already archived.",
  );
  expect(rejectionReason(new Error("plain"))).toBeUndefined();
  expect(rejectionReason({ cause: "   " })).toBeUndefined();
  expect(rejectionReason("text")).toBeUndefined();
});
