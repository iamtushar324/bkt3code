/**
 * T3-CUSTOM(expbkt3): coverage for the probe-only "application-focus" wakeup.
 * The harness is a trimmed copy of supervisor.test.ts's.
 */
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  ConnectionTransientError,
  type ConnectionAttemptError,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const TARGET_ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.none(),
  enabled: true,
};
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};
const TEST_RPC_CLIENT = {} as WsRpcProtocolClient;

const awaitState = (
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  predicate: (value: SupervisorConnectionState) => boolean,
) =>
  SubscriptionRef.changes(state).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const makeHarness = Effect.fn("FocusWakeupHarness.make")(function* (options: {
  readonly probe: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
}) {
  const networkStatus = yield* SubscriptionRef.make<"online" | "offline">("online");
  const sessionCount = yield* Ref.make(0);
  const releaseCount = yield* Ref.make(0);
  const wakeups = yield* SubscriptionRef.make<{
    readonly sequence: number;
    readonly reason: ConnectionWakeups.ConnectionWakeup;
  }>({ sequence: 0, reason: "application-active" });

  const connect = Effect.fn("FocusWakeupHarness.connect")(function* (
    _entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    yield* reportProgress({ stage: "preparing" });
    yield* reportProgress({ stage: "opening", prepared: PREPARED });
    const attempt = yield* Ref.updateAndGet(sessionCount, (count) => count + 1);
    const closed = yield* Deferred.make<never, ConnectionTransientError>();
    const session = yield* Effect.acquireRelease(
      Effect.succeed({
        client: TEST_RPC_CLIENT,
        initialConfig: Effect.die(new Error("unused")),
        subscribeServerConfig: (input) => TEST_RPC_CLIENT.subscribeServerConfig(input),
        ready: Effect.void,
        probe: options.probe(attempt),
        closed: Deferred.await(closed),
      } satisfies RpcSession.RpcSession),
      () => Ref.update(releaseCount, (count) => count + 1),
    );
    yield* reportProgress({ stage: "synchronizing", prepared: PREPARED });
    return { prepared: PREPARED, session } satisfies ConnectionDriver.EnvironmentConnectionLease;
  });

  return {
    sessionCount,
    releaseCount,
    dependencies: Layer.mergeAll(
      Layer.succeed(
        Connectivity.Connectivity,
        Connectivity.Connectivity.of({
          status: SubscriptionRef.get(networkStatus),
          changes: SubscriptionRef.changes(networkStatus),
        }),
      ),
      Layer.succeed(
        ConnectionWakeups.ConnectionWakeups,
        ConnectionWakeups.ConnectionWakeups.of({
          changes: SubscriptionRef.changes(wakeups).pipe(
            Stream.drop(1),
            Stream.map((event) => event.reason),
          ),
        }),
      ),
      Layer.succeed(
        ConnectionDriver.ConnectionDriver,
        ConnectionDriver.ConnectionDriver.of({ connect }),
      ),
    ),
    wake: (reason: ConnectionWakeups.ConnectionWakeup) =>
      SubscriptionRef.update(wakeups, (event) => ({ sequence: event.sequence + 1, reason })),
  };
});

describe("application-focus wakeup", () => {
  it("counts as the user returning but never resubscribes streams", () => {
    expect(ConnectionWakeups.isApplicationActiveWakeup("application-focus")).toBe(true);
    expect(ConnectionWakeups.shouldResubscribeAfterWakeup("application-focus")).toBe(false);
    expect(ConnectionWakeups.shouldResubscribeAfterWakeup("application-active")).toBe(true);
  });

  it.effect("probes the live session without replacing it", () =>
    Effect.gen(function* () {
      const probeCalled = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: () => Deferred.succeed(probeCalled, undefined).pipe(Effect.asVoid),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-focus");
      yield* Deferred.await(probeCalled);

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
    }),
  );

  it.effect("reconnects without backoff when the focus probe finds a dead socket", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) =>
          attempt === 1
            ? Effect.fail(new ConnectionTransientError({ reason: "transport", detail: "stale" }))
            : Effect.void,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-focus");
      // No TestClock advance: a failed foreground probe skips the first backoff rung.
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
