// T3-CUSTOM(expbkt3): TEC-1819 — t3_session_lifecycle, the agent toolkit's
// archive/stop/snooze/delete tool for clients on the OAuth tool list, which
// does not include the control toolkit's t3_session_action.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Tool } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { OrchestrationAccessControl } from "../../../orchestration-v2/Services/AccessControl.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import { TurnStartBootstrap } from "../../../orchestration-v2/turnStartBootstrap.expbkt3.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { __testing } from "./handlers.ts";
import { AGENT_TOOL_NAMES, SessionLifecycleTool } from "./tools.ts";

const sessionId = ThreadId.make("thread-agent-lifecycle");
const ownSessionId = ThreadId.make("thread-agent-lifecycle-own");
const ARCHIVED_AT = "2026-10-28T10:00:00.000Z";

/** An approved OAuth client with no session of its own. */
const scope: McpInvocationContext.McpInvocationScope = {
  principal: "external-user",
  actorUserId: null,
  environmentId: EnvironmentId.make("environment-agent-lifecycle"),
  requestNamespace: "external-user:agent-lifecycle",
  thread: undefined,
  client: {
    sessionId: "external-user:agent-lifecycle",
    label: "OAuth client",
    access: "full-access",
  },
  capabilities: new Set(["orchestration", "t3.read", "t3.control"]),
  issuedAt: 1,
};

/** A provider session's credential: its own thread, no user-wide scope. */
const providerScope: McpInvocationContext.McpInvocationScope = {
  principal: "provider-session",
  actorUserId: null,
  environmentId: EnvironmentId.make("environment-agent-lifecycle"),
  requestNamespace: "provider-session-agent-lifecycle",
  thread: {
    threadId: ownSessionId,
    providerSessionId: "provider-session-agent-lifecycle",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "t3.read", "t3.control"]),
  issuedAt: 1,
};

const accessControl = OrchestrationAccessControl.of({
  actorFor: () => Option.none(),
  canAccessThread: () => Effect.succeed(true),
  canAccessProject: () => Effect.succeed(true),
  canTransferThreadOwnership: () => Effect.succeed(false),
  canTransferProjectOwnership: () => Effect.succeed(false),
});

it("is in the agent tool list and marked destructive", () => {
  expect(AGENT_TOOL_NAMES).toContain("t3_session_lifecycle");
  expect(Context.get(SessionLifecycleTool.annotations, Tool.Destructive)).toBe(true);
  expect(Tool.getDescription(SessionLifecycleTool)).toContain("DESTRUCTIVE");
});

it.layer(NodeServices.layer)("t3_session_lifecycle", (it) => {
  let archivedAt: string | null = null;
  const dispatched: OrchestrationCommand[] = [];
  const threads = {
    getThreadShell: (id: ThreadId) =>
      Effect.sync(() =>
        id === sessionId || id === ownSessionId
          ? {
              ...liveThreadShell(id, { activeRunId: null }),
              ...(archivedAt === null ? {} : { archivedAt: DateTime.makeUnsafe(archivedAt) }),
            }
          : null,
      ),
  } as unknown as ThreadManagement.ThreadManagementService["Service"];
  const query = {
    getThreadShellById: (id: ThreadId) =>
      Effect.sync(() =>
        id === sessionId || id === ownSessionId ? Option.some({ id, archivedAt }) : Option.none(),
      ),
  } as unknown as ProjectionSnapshotQuery["Service"];
  const dispatcher = TurnStartBootstrap.of({
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        if (command.type === "thread.archive") archivedAt = ARCHIVED_AT;
        if (command.type === "thread.unarchive") archivedAt = null;
        return { sequence: dispatched.length };
      }),
    createThread: () => Effect.die("createThread should not be called"),
  });
  const provideAs =
    (caller: McpInvocationContext.McpInvocationScope) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, threads),
        Effect.provideService(ProjectionSnapshotQuery, query),
        Effect.provideService(TurnStartBootstrap, dispatcher),
        Effect.provideService(OrchestrationAccessControl, accessControl),
        Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
      );
  const provide = provideAs(scope);
  const reset = () => {
    archivedAt = null;
    dispatched.length = 0;
  };

  it.effect("archives, and a retry is a success that dispatches nothing", () =>
    Effect.gen(function* () {
      reset();
      const first = yield* __testing
        .sessionLifecycle({ session: sessionId, action: "archive" })
        .pipe(provide);
      expect(first.markdown.split("\n")[0]).toBe(`Session id: ${sessionId}`);
      expect(first.data).toMatchObject({ changed: true, action: "archive" });
      expect(dispatched.map((command) => command.type)).toEqual(["thread.archive"]);

      const retry = yield* __testing
        .sessionLifecycle({ session: sessionId, action: "archive" })
        .pipe(provide);
      expect(retry.markdown).toContain("Nothing to do");
      expect(retry.markdown).toContain("already archived");
      expect(retry.data).toMatchObject({ changed: false });
      expect(dispatched).toHaveLength(1);
    }),
  );

  it.effect("a retry with the same clientRequestId sends the same command id", () =>
    Effect.gen(function* () {
      reset();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        yield* __testing
          .sessionLifecycle({ session: sessionId, action: "stop", clientRequestId: "stop-1" })
          .pipe(provide);
      }
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.session.stop",
        "thread.session.stop",
      ]);
      expect(dispatched[0]?.commandId).toBe(dispatched[1]?.commandId);
    }),
  );

  it.effect("deletes, and asks for snoozedUntil before a snooze", () =>
    Effect.gen(function* () {
      reset();
      yield* __testing.sessionLifecycle({ session: sessionId, action: "delete" }).pipe(provide);
      expect(dispatched.map((command) => command.type)).toEqual(["thread.delete"]);

      const refused = yield* Effect.flip(
        __testing.sessionLifecycle({ session: sessionId, action: "snooze" }).pipe(provide),
      );
      expect(refused).toMatchObject({ code: "snoozed_until_required" });
      expect(dispatched).toHaveLength(1);
    }),
  );

  it.effect("a provider credential acts on its own session only, like t3_session_action", () =>
    Effect.gen(function* () {
      reset();
      const refused = yield* Effect.flip(
        __testing
          .sessionLifecycle({ session: sessionId, action: "delete" })
          .pipe(provideAs(providerScope)),
      );
      expect(refused).toMatchObject({ code: "own_session_only" });
      expect(dispatched).toHaveLength(0);

      const own = yield* __testing
        .sessionLifecycle({ session: "me", action: "archive" })
        .pipe(provideAs(providerScope));
      expect(own.data).toMatchObject({ sessionId: ownSessionId, changed: true });
      expect(dispatched.map((command) => command.threadId)).toEqual([ownSessionId]);
    }),
  );
});
