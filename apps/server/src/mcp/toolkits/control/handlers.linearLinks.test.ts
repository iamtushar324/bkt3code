// T3-CUSTOM(expbkt3): Linear tags through t3_link_linear / t3_unlink_linear.
//
// Covers what an agent relies on: its own session is the default even with a
// user-wide credential (the case t3_update_session refuses), each URL is
// checked before anything is dispatched, and the result reads the stored list
// back and says which tags were new, already there, left out, or never there.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  THREAD_LINEAR_LINKS_MAX,
  ThreadId,
  UserId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  applyLinearLinkChanges,
  threadLinearLinks,
  type StoredLinearLink,
} from "@t3tools/shared/linearIssue";

import { OrchestrationAccessControl } from "../../../orchestration-v2/Services/AccessControl.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import { TurnStartBootstrap } from "../../../orchestration-v2/turnStartBootstrap.expbkt3.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { T3ControlToolError } from "./tools.ts";
import { __testing } from "./handlers.ts";

const actorUserId = UserId.make("user-linear-tagger");
const ownThreadId = ThreadId.make("thread-linear-own");
const ISSUE_42 = "https://linear.app/acme/issue/ENG-42";
const ISSUE_43 = "https://linear.app/acme/issue/ENG-43";
const PROJECT = "https://linear.app/acme/project/checkout-revamp-0a1b2c3d4e5f";

/** A user-bound agent credential: user-wide, yet minted for its own thread. */
const agent: McpInvocationContext.McpInvocationScope = {
  principal: "provider-session",
  actorUserId,
  environmentId: EnvironmentId.make("environment-linear"),
  requestNamespace: "provider-session-linear",
  thread: {
    threadId: ownThreadId,
    providerSessionId: "provider-session-linear",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  capabilities: new Set(["t3.read", "t3.control", "t3.plan", "t3.session.create"]),
  issuedAt: 1,
};

const accessControl = OrchestrationAccessControl.of({
  actorFor: () => Option.some(actorUserId),
  canAccessThread: () => Effect.succeed(true),
  canAccessProject: () => Effect.succeed(true),
  canTransferThreadOwnership: () => Effect.succeed(false),
  canTransferProjectOwnership: () => Effect.succeed(false),
});

// The stored thread. It starts tagged the pre-multi-tag way (single-tag field
// only), and the fake dispatcher applies each update the way the decider does.
let stored: { linearIssueUrl: string | null; linearLinks?: ReadonlyArray<StoredLinearLink> } = {
  linearIssueUrl: ISSUE_42,
};
const query = {
  getThreadShellById: (threadId: ThreadId) =>
    Effect.sync(() =>
      threadId === ownThreadId ? Option.some({ id: ownThreadId, ...stored }) : Option.none(),
    ),
} as unknown as ProjectionSnapshotQuery["Service"];

it.layer(NodeServices.layer)("t3_link_linear and t3_unlink_linear", (it) => {
  const dispatched: OrchestrationCommand[] = [];
  const dispatcher = TurnStartBootstrap.of({
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        if (command.type === "thread.meta.update") {
          stored = applyLinearLinkChanges(threadLinearLinks(stored), command);
        }
        return { sequence: dispatched.length };
      }),
    createThread: () => Effect.die("createThread should not be called"),
  });
  const provide =
    (scope: McpInvocationContext.McpInvocationScope = agent) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(TurnStartBootstrap, dispatcher),
        Effect.provideService(ProjectionSnapshotQuery, query),
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(OrchestrationAccessControl, accessControl),
      );
  const reset = () => {
    dispatched.length = 0;
    stored = { linearIssueUrl: ISSUE_42 };
  };
  const metaUpdates = () =>
    dispatched.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.meta.update" }> =>
        command.type === "thread.meta.update",
    );

  it.effect("tags the agent's own session when sessionId is omitted", () =>
    Effect.gen(function* () {
      reset();
      const result = yield* __testing
        .linkLinear({ urls: [`${ISSUE_42}/slug`, PROJECT, ISSUE_43, ISSUE_43] })
        .pipe(provide());
      expect(result).toEqual({
        sessionId: ownThreadId,
        linearLinks: [
          { url: ISSUE_42, kind: "issue" },
          { url: PROJECT, kind: "project" },
          { url: ISSUE_43, kind: "issue" },
        ],
        added: [PROJECT, ISSUE_43],
        alreadyLinked: [ISSUE_42],
        notAdded: [],
        sequence: 1,
      });
      const [command] = metaUpdates();
      expect(command?.threadId).toBe(ownThreadId);
      expect(command?.linearLinksAdd).toEqual([
        { url: ISSUE_42, kind: "issue" },
        { url: PROJECT, kind: "project" },
        { url: ISSUE_43, kind: "issue" },
      ]);
    }),
  );

  it.effect("reports an already-linked item and leaves the list as it was", () =>
    Effect.gen(function* () {
      reset();
      const result = yield* __testing.linkLinear({ urls: [ISSUE_42] }).pipe(provide());
      expect(result.added).toEqual([]);
      expect(result.alreadyLinked).toEqual([ISSUE_42]);
      expect(result.linearLinks).toEqual([{ url: ISSUE_42, kind: "issue" }]);
    }),
  );

  it.effect("reports items left out once the session holds the maximum", () =>
    Effect.gen(function* () {
      reset();
      stored = {
        linearIssueUrl: null,
        linearLinks: Array.from({ length: THREAD_LINEAR_LINKS_MAX }, (_, index) => ({
          url: `https://linear.app/acme/issue/ENG-${1000 + index}`,
          kind: "issue" as const,
        })),
      };
      const result = yield* __testing.linkLinear({ urls: [ISSUE_43] }).pipe(provide());
      expect(result.added).toEqual([]);
      expect(result.notAdded).toEqual([ISSUE_43]);
      expect(result.linearLinks).toHaveLength(THREAD_LINEAR_LINKS_MAX);
    }),
  );

  it.effect("rejects a URL that is not a Linear issue or project before dispatching", () =>
    Effect.gen(function* () {
      reset();
      const error = yield* __testing
        .linkLinear({ urls: [ISSUE_43, "https://example.com/ENG-1"] })
        .pipe(provide(), Effect.flip);
      expect(error).toBeInstanceOf(T3ControlToolError);
      expect(error.message).toContain("https://example.com/ENG-1 is not a Linear issue");
      expect(dispatched).toHaveLength(0);
    }),
  );

  it.effect("removes only the tags the session has and reports the rest", () =>
    Effect.gen(function* () {
      reset();
      const result = yield* __testing
        .unlinkLinear({ urls: ["https://linear.app/acme/issue/eng-42", PROJECT] })
        .pipe(provide());
      expect(result).toEqual({
        sessionId: ownThreadId,
        linearLinks: [],
        removed: [ISSUE_42],
        notLinked: [PROJECT],
        sequence: 1,
      });
      expect(metaUpdates()[0]?.linearLinksRemove).toEqual([ISSUE_42, PROJECT]);
    }),
  );

  it.effect("still needs a sessionId from a caller with no session of its own", () =>
    Effect.gen(function* () {
      reset();
      const external: McpInvocationContext.McpInvocationScope = {
        ...agent,
        principal: "external-user",
        requestNamespace: "external-user:linear",
        thread: undefined,
      };
      const error = yield* __testing
        .linkLinear({ urls: [ISSUE_43] })
        .pipe(provide(external), Effect.flip);
      expect(error.message).toBe("sessionId is required for a user-wide MCP call.");
      expect(dispatched).toHaveLength(0);
    }),
  );
});
