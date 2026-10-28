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
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationCommandInvariantError } from "../../../orchestration-v2/Errors.ts";
import { OrchestratorDispatchError } from "../../../orchestration-v2/Orchestrator.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import { TurnStartBootstrap } from "../../../orchestration-v2/turnStartBootstrap.expbkt3.ts";
import { rejectionReason, runSessionLifecycle } from "./handlers.ts";

const threadId = ThreadId.make("thread-lifecycle");
const ARCHIVED_AT = "2026-10-28T10:00:00.000Z";

/** The refusal chain the V2 engine produces for a second archive. */
const alreadyArchivedFailure = () =>
  new OrchestrationDispatchCommandError({
    message:
      "Orchestration command invariant failed (thread.archive): The V2 command could not complete.",
    cause: new OrchestrationCommandInvariantError({
      commandType: "thread.archive",
      detail: "The V2 command could not complete.",
      cause: new OrchestratorDispatchError({
        commandId: CommandId.make("mcp:session-archive:race"),
        commandType: "thread.archive",
        cause: `Thread ${threadId} is already archived.`,
      }),
    }),
  });

it.layer(NodeServices.layer)("runSessionLifecycle", (it) => {
  let archivedAt: string | null = null;
  let shellReads = 0;
  let failNextDispatch = false;
  const dispatched: OrchestrationCommand[] = [];
  const query = {
    getThreadShellById: (id: ThreadId) =>
      Effect.sync(() => {
        shellReads += 1;
        return id === threadId ? Option.some({ id, archivedAt }) : Option.none();
      }),
  } as unknown as ProjectionSnapshotQuery["Service"];
  const dispatcher = TurnStartBootstrap.of({
    dispatch: (command) =>
      failNextDispatch
        ? Effect.fail(alreadyArchivedFailure())
        : Effect.sync(() => {
            dispatched.push(command);
            if (command.type === "thread.archive") archivedAt = ARCHIVED_AT;
            if (command.type === "thread.unarchive") archivedAt = null;
            return { sequence: dispatched.length };
          }),
    createThread: () => Effect.die("createThread should not be called"),
  });
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(TurnStartBootstrap, dispatcher),
      Effect.provideService(ProjectionSnapshotQuery, query),
    );
  const reset = (state: { archivedAt: string | null }) => {
    archivedAt = state.archivedAt;
    shellReads = 0;
    failNextDispatch = false;
    dispatched.length = 0;
  };
  const run = (action: "archive" | "unarchive" | "stop") =>
    runSessionLifecycle({ operation: `session-${action}`, sessionId: threadId, action }).pipe(
      provide,
    );

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

  it.effect("a refusal surfaces the orchestrator's own reason", () =>
    Effect.gen(function* () {
      // The read saw it active, but another archive won the race.
      reset({ archivedAt: null });
      failNextDispatch = true;
      const error = yield* Effect.flip(run("archive"));
      expect(error._tag).toBe("T3ControlToolError");
      expect(error.message).toBe(`Thread ${threadId} is already archived.`);
    }),
  );
});

it("rejectionReason finds a string cause through nested errors, and nothing otherwise", () => {
  expect(rejectionReason(alreadyArchivedFailure())).toBe(`Thread ${threadId} is already archived.`);
  expect(rejectionReason(new Error("plain"))).toBeUndefined();
  expect(rejectionReason({ cause: "   " })).toBeUndefined();
  expect(rejectionReason("text")).toBeUndefined();
});
