import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2GetShellSnapshotError,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { makeEnvironmentShellState } from "./shell.ts";
import { canResumeShellAcrossSessions } from "./shellResume.expbkt3.ts";
import * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
import { v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

const HTTP_SNAPSHOT: OrchestrationV2ShellSnapshot = { ...v2ShellSnapshot, snapshotSequence: 7 };

const RESUME_INPUT = { afterSequence: 7, requestCompletionMarker: true };

type SubscribeInput = { readonly afterSequence?: number; readonly requestCompletionMarker?: true };

const synchronizedThenOpen: Stream.Stream<OrchestrationV2ShellStreamItem> = Stream.concat(
  Stream.make({ kind: "synchronized" as const }),
  Stream.never,
);

const NO_CACHE = Persistence.EnvironmentCacheStore.of({
  loadShell: () => Effect.succeed(Option.none()),
  saveShell: () => Effect.void,
  loadThread: () => Effect.succeed(Option.none()),
  saveThread: () => Effect.void,
  removeThread: () => Effect.void,
  loadServerConfig: () => Effect.succeed(Option.none()),
  saveServerConfig: () => Effect.void,
  loadVcsRefs: () => Effect.succeed(Option.none()),
  saveVcsRefs: () => Effect.void,
  removeVcsRefs: () => Effect.void,
  clearVcsRefs: () => Effect.void,
  clear: () => Effect.void,
});

/**
 * One shell state over sessions the test swaps. `answer(call)` is the server's
 * reply to the nth subscription (0-based). The first subscription loads the
 * HTTP snapshot, so the in-memory cursor is 7 once it is live.
 */
const makeHarness = Effect.fn("ShellResumeHarness.make")(function* (
  answer: (call: number) => Stream.Stream<OrchestrationV2ShellStreamItem, unknown>,
) {
  const inputs = yield* Queue.unbounded<SubscribeInput>();
  const calls = yield* Ref.make(0);
  const httpLoads = yield* Ref.make(0);
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input: SubscribeInput) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const call = yield* Ref.getAndUpdate(calls, (count) => count + 1);
          yield* Queue.offer(inputs, input);
          return answer(call);
        }),
      ),
  } as unknown as WsRpcProtocolClient;
  const sessionFor = (serverInstanceId: string | undefined): RpcSession.RpcSession => ({
    client,
    initialConfig: Effect.succeed({
      shellResumeCompletionMarker: true,
      ...(serverInstanceId === undefined ? {} : { serverInstanceId }),
    } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  });
  const activeSession = yield* SubscriptionRef.make(Option.some(sessionFor("instance-a")));
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: activeSession,
    prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
    load: () =>
      Ref.update(httpLoads, (count) => count + 1).pipe(Effect.as(Option.some(HTTP_SNAPSHOT))),
  });
  const shellState = yield* makeEnvironmentShellState().pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, NO_CACHE),
    Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
  );

  // The first socket loads the HTTP snapshot, then subscribes from its sequence.
  expect(yield* Queue.take(inputs)).toEqual(RESUME_INPUT);
  expect(yield* Ref.get(httpLoads)).toBe(1);

  return {
    inputs,
    httpLoads,
    shellState,
    replaceSession: (serverInstanceId: string | undefined) =>
      SubscriptionRef.set(activeSession, Option.some(sessionFor(serverInstanceId))),
  };
});

describe("shell resume across sessions", () => {
  it.effect("resumes a replaced socket to the same server process from the cursor", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(() => synchronizedThenOpen);

      yield* harness.replaceSession("instance-a");

      expect(yield* Queue.take(harness.inputs)).toEqual(RESUME_INPUT);
      expect(yield* Ref.get(harness.httpLoads)).toBe(1);
    }),
  );

  it.effect("loads the full snapshot when the server process changed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(() => synchronizedThenOpen);

      yield* harness.replaceSession("instance-b");

      expect(yield* Queue.take(harness.inputs)).toEqual(RESUME_INPUT);
      expect(yield* Ref.get(harness.httpLoads)).toBe(2);
    }),
  );

  it.effect("loads the full snapshot when the server does not name its process", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(() => synchronizedThenOpen);

      yield* harness.replaceSession(undefined);

      expect(yield* Queue.take(harness.inputs)).toEqual(RESUME_INPUT);
      expect(yield* Ref.get(harness.httpLoads)).toBe(2);
    }),
  );

  it.effect("applies the full snapshot the server sends when the gap is too large", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness((call) =>
        call === 1
          ? Stream.concat(
              Stream.make(
                {
                  kind: "snapshot" as const,
                  snapshot: { ...v2ShellSnapshot, snapshotSequence: 5_000 },
                },
                { kind: "synchronized" as const },
              ),
              Stream.never,
            )
          : synchronizedThenOpen,
      );

      yield* harness.replaceSession("instance-a");

      expect(yield* Queue.take(harness.inputs)).toEqual(RESUME_INPUT);
      yield* SubscriptionRef.changes(harness.shellState).pipe(
        Stream.filter(
          (value) =>
            value.status === "live" &&
            Option.isSome(value.snapshot) &&
            value.snapshot.value.snapshotSequence === 5_000,
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(yield* Ref.get(harness.httpLoads)).toBe(1);
    }),
  );

  it.effect("loads the HTTP snapshot when a resume fails before any item", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness((call) =>
        call === 1
          ? Stream.fail(new OrchestrationV2GetShellSnapshotError({ message: "Replay failed." }))
          : synchronizedThenOpen,
      );

      yield* harness.replaceSession("instance-a");
      expect(yield* Queue.take(harness.inputs)).toEqual(RESUME_INPUT);
      expect(yield* Ref.get(harness.httpLoads)).toBe(1);

      // The failed subscription retries after 250 ms. Step the clock until it does,
      // because the retry sleep starts a few fiber hops after the failure.
      let retried = yield* Queue.poll(harness.inputs);
      for (let step = 0; step < 40 && Option.isNone(retried); step += 1) {
        yield* TestClock.adjust("50 millis");
        retried = yield* Queue.poll(harness.inputs);
      }
      expect(Option.getOrThrow(retried)).toEqual(RESUME_INPUT);
      expect(yield* Ref.get(harness.httpLoads)).toBe(2);
    }),
  );
});

describe("canResumeShellAcrossSessions", () => {
  const eligible = {
    hasEarlierAuthoritativeSession: true,
    earlierServerIdentity: "instance-a",
    serverIdentity: "instance-a",
    pendingLinkFill: false,
    alreadyTriedOnThisSession: false,
  };

  it("allows a resume to the same server process", () => {
    expect(canResumeShellAcrossSessions(eligible)).toBe(true);
  });

  it("refuses without an earlier authoritative snapshot, such as a disk cache only", () => {
    expect(
      canResumeShellAcrossSessions({ ...eligible, hasEarlierAuthoritativeSession: false }),
    ).toBe(false);
  });

  it("refuses when either server does not name its process", () => {
    expect(canResumeShellAcrossSessions({ ...eligible, serverIdentity: null })).toBe(false);
    expect(
      canResumeShellAcrossSessions({
        ...eligible,
        earlierServerIdentity: null,
        serverIdentity: null,
      }),
    ).toBe(false);
  });

  it("refuses while pull request links are still loading", () => {
    expect(canResumeShellAcrossSessions({ ...eligible, pendingLinkFill: true })).toBe(false);
  });

  it("refuses a second resume on the same socket", () => {
    expect(canResumeShellAcrossSessions({ ...eligible, alreadyTriedOnThisSession: true })).toBe(
      false,
    );
  });
});
