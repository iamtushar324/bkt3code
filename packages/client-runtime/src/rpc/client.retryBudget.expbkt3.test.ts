// T3-CUSTOM(expbkt3): a delivered value resets a subscription's retry budget.
import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import type * as RpcSession from "./session.ts";
import { subscribe } from "./client.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

describe("subscription retry budget", () => {
  it.effect("keeps retrying a stream that recovers between failures", () =>
    Effect.gen(function* () {
      const subscriptions = yield* Ref.make(0);
      const received = yield* Ref.make(0);
      // Every subscription delivers one value, then fails with an expected error.
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.unwrap(
            Ref.update(subscriptions, (count) => count + 1).pipe(
              Effect.as(
                Stream.concat(
                  Stream.succeed({ type: "output", threadId: "t", terminalId: "x", data: "ok" }),
                  Stream.fail(new Error("live event buffer is full")),
                ),
              ),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some({
          client,
          initialConfig: Effect.never,
          subscribeServerConfig: (input) => client.subscribeServerConfig(input),
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        }),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE),
        session: activeSession,
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
        notifySessionSuspect: () => Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);

      const fiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: () => Effect.void,
          // Two consecutive failures without progress end the retries.
          retryExpectedFailureAfter: (attempt) =>
            attempt < 2 ? Option.some("10 millis") : Option.none(),
        },
      ).pipe(
        Stream.runForEach(() => Ref.update(received, (count) => count + 1)),
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      for (let tick = 0; tick < 12; tick += 1) {
        for (let spin = 0; spin < 20; spin += 1) yield* Effect.yieldNow;
        yield* TestClock.adjust("10 millis");
      }
      for (let spin = 0; spin < 20; spin += 1) yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);

      // Without the reset the stream went dormant after its third failure.
      expect(yield* Ref.get(subscriptions)).toBeGreaterThanOrEqual(8);
      expect(yield* Ref.get(received)).toBeGreaterThanOrEqual(8);
    }),
  );
});
