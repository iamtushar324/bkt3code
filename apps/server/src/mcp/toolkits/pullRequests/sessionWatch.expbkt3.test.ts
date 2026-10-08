// T3-CUSTOM(expbkt3): upstream PR watches must retain named-session access rules.
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  UserId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { OrchestrationAccessControl } from "../../../orchestration-v2/Services/AccessControl.ts";
import { v2PullRequestThread } from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PullRequestsHandlers from "./handlers.ts";
import { PullRequestsToolkit, type PullRequestTargetInput } from "./tools.ts";

const SELF = ThreadId.make("self");
const TARGET = ThreadId.make("target");
const ACTOR = UserId.make("user-one");
const PROJECT = ProjectId.make("project-one");

const makeHarness = Effect.fn("makeForkWatchHarness")(function* (
  principal: McpInvocationContext.McpInvocationScope["principal"],
  allowed = true,
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const reads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const dependencies = Layer.mergeAll(
    Layer.mock(OrchestrationAccessControl)({
      actorFor: () => Option.none(),
      canAccessThread: (actor, target) =>
        Effect.succeed(actor === ACTOR && target === TARGET && allowed),
    }),
    Layer.mock(ProjectService.ProjectService)({ getShell: () => Effect.succeed(Option.none()) }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) =>
        Effect.gen(function* () {
          yield* Ref.update(reads, (current) => [...current, id]);
          return v2PullRequestThread({
            id,
            projectId: PROJECT,
            title: "Watch target",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            pullRequests: [],
            latestUserMessageAt: null,
            createdAt: "2026-10-03T00:00:00.000Z",
            updatedAt: "2026-10-03T00:00:00.000Z",
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
          });
        }),
      dispatch: (command) =>
        Ref.update(commands, (current) => [...current, command]).pipe(
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
    }),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(7),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );
  const toolkit = yield* PullRequestsToolkit.pipe(
    Effect.provide(PullRequestsHandlers.layer.pipe(Layer.provide(dependencies))),
  );
  const scope: McpInvocationContext.McpInvocationScope = {
    principal,
    actorUserId: principal === "external-user" ? ACTOR : null,
    environmentId: EnvironmentId.make("environment-one"),
    requestNamespace:
      principal === "provider-session"
        ? "provider-one"
        : principal === "external-user"
          ? `external-user:${ACTOR}`
          : "external-operator",
    // Only a provider session has a thread; external principals are client callers.
    thread:
      principal === "provider-session"
        ? {
            threadId: SELF,
            providerSessionId: "provider-one",
            providerInstanceId: ProviderInstanceId.make("codex"),
          }
        : undefined,
    client:
      principal === "provider-session"
        ? undefined
        : { sessionId: principal, label: principal, access: "full-access" },
    capabilities: new Set(["pull-requests"]),
    issuedAt: 1,
  };
  const call = (
    name: "watch_pull_request" | "unwatch_pull_request",
    input: PullRequestTargetInput,
  ) =>
    toolkit
      .handle(name, input)
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provide(dependencies),
      );
  return { call, commands, reads };
});

describe.each(["watch_pull_request", "unwatch_pull_request"] as const)("%s fork access", (name) => {
  const input = { url: "https://github.com/example/repository/pull/12", threadId: TARGET };

  it.effect("applies an external user's watch to the authorized session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness("external-user");
      yield* harness.call(name, input);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.pull-request.watch",
          threadId: TARGET,
          watching: name === "watch_pull_request",
        },
      ]);
      expect(yield* Ref.get(harness.reads)).toEqual([TARGET, TARGET]);
    }),
  );

  it.effect("rejects another session before an in-session agent reads or changes it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness("provider-session");
      const failure = yield* harness.call(name, input).pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "PullRequestSessionTargetError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
      expect(yield* Ref.get(harness.reads)).toEqual([]);
    }),
  );

  it.effect("rejects an external user without access before reading the session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness("external-user", false);
      const failure = yield* harness.call(name, input).pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "PullRequestSessionTargetError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
      expect(yield* Ref.get(harness.reads)).toEqual([]);
    }),
  );

  it.effect("requires an explicit target for an external operator", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness("external-operator");
      const failure = yield* harness.call(name, { url: input.url }).pipe(Effect.flip);
      // A client caller has no thread of its own to fall back to.
      expect(failure).toMatchObject({ _tag: "PullRequestThreadRequiredError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );
});
