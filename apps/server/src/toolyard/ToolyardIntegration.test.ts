/** T3-CUSTOM(expbkt3): Callback history is bounded, typed, and excludes credentials/results. */
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, UserId, WS_METHODS, type SessionWebhookView } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { EnvironmentUserRepository } from "../persistence/EnvironmentUsers.ts";
import {
  ToolyardIntegration,
  toolyardIntegrationLayer,
  managedToolyardActor,
  ToolyardCallbackInspection,
} from "./ToolyardIntegration.ts";

import { makeForkWsHandlers, type ForkWsHandlerDeps } from "../wsForkHandlers.ts";
import { SessionWebhookService } from "../session-webhooks/SessionWebhookService.ts";

const integrationTestLayer = (team: boolean) => {
  const config = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const value = yield* ServerConfig.ServerConfig;
      return {
        ...value,
        ...(team
          ? {
              clerkAuth: {
                secretKey: "fixture-secret",
                publishableKey: undefined,
                organizationId: "org-fixture",
                defaultOwnerUserId: undefined,
                defaultOwnerEmail: undefined,
              },
            }
          : {}),
      };
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "toolyard-local-test-" })),
    Layer.provide(NodeServices.layer),
  );
  return toolyardIntegrationLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        config,
        Layer.mock(ServerSecretStore)({
          get: () => Effect.succeed(Option.none()),
          set: () => Effect.void,
        }),
        Layer.succeed(ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("fixture-environment")),
        }),
        Layer.mock(EnvironmentUserRepository)({ get: () => Effect.succeed(Option.none()) }),
      ),
    ),
  );
};
const decodeHistory = Schema.decodeUnknownEffect(ToolyardCallbackInspection);
const decision = {
  event_id: "decision-one",
  inbox_id: "inbox-one",
  status: "failed",
  attempts: 1,
  terminal_reason: "receiver_unavailable",
  history: [{ attempt: 1, at: 1_790_000_000_000, http_status: 503, outcome: "http_error" }],
};
it.effect(
  "keeps physical delivery history but excludes receiver secrets and sensitive results",
  () =>
    Effect.gen(function* () {
      const result = yield* decodeHistory({
        receiver: { secret: "signing-secret", token: "agent-token" },
        deliveries: [
          {
            ...decision,
            credentials: "agent-secret",
            results: { private: "sensitive result" },
            history: [{ ...decision.history[0], grant_token: "permission-token" }],
          },
        ],
      });
      expect(result).toEqual({ deliveries: [decision] });
    }),
);
it.effect("rejects malformed or excessive delivery history", () =>
  Effect.gen(function* () {
    for (const input of [
      { deliveries: [{ ...decision, attempts: -1 }] },
      { deliveries: [{ ...decision, history: [{ ...decision.history[0], http_status: 700 }] }] },
      {
        deliveries: [
          { ...decision, history: Array.from({ length: 257 }, () => decision.history[0]) },
        ],
      },
      { deliveries: Array.from({ length: 101 }, () => decision) },
    ])
      expect((yield* Effect.result(decodeHistory(input)))._tag).toBe("Failure");
  }),
);

it.effect("permits the authenticated local profile only when Clerk team mode is absent", () =>
  Effect.gen(function* () {
    const service = yield* ToolyardIntegration;
    const local = UserId.make("local-user");
    expect(yield* service.isLocalOwner(local)).toBe(true);
    yield* service.assertConnectionOwner(local);
    expect(managedToolyardActor(null)).toBe(local);
    expect(yield* service.status(local)).toMatchObject({
      administrator: true,
      teamAvailable: false,
      mode: "api-key",
      connection: "not_connected",
    });
    expect(
      (yield* Effect.result(service.assertConnectionOwner(UserId.make("other-local-owner"))))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(integrationTestLayer(false))),
);
it.effect("never converts an anonymous team transport into the local owner", () =>
  Effect.gen(function* () {
    const service = yield* ToolyardIntegration;
    expect(yield* service.isLocalOwner(UserId.make("local-user"))).toBe(false);
    expect(managedToolyardActor(null)).toBeNull();
    expect(
      (yield* Effect.result(service.assertConnectionOwner(UserId.make("local-user"))))._tag,
    ).toBe("Failure");
    expect(
      (yield* Effect.result(service.assertConnectionOwner(UserId.make("user_disabled"))))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(integrationTestLayer(true))),
);

it.effect.each([false, true])(
  "webhook Settings preserve the authenticated boundary (team=%s)",
  (team) =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const deps = {
        actorUserId: null,
        actorIsAdmin: false,
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStream: (_method, stream) => stream,
      } satisfies Partial<ForkWsHandlerDeps>;
      const handlers = makeForkWsHandlers(deps as unknown as ForkWsHandlerDeps);
      const mock = Layer.mock(SessionWebhookService)({
        list: (owner) =>
          Effect.sync(() => {
            calls.push(["list", owner]);
            return [];
          }),
        update: (owner, id, action, revision) =>
          Effect.sync(() => {
            calls.push(["update", owner, id, action, revision]);
            return {} as SessionWebhookView;
          }),
      });
      const list = yield* Effect.result(
        handlers[WS_METHODS.sessionWebhooksList]().pipe(Effect.provide(mock)),
      );
      const update = yield* Effect.result(
        handlers[WS_METHODS.sessionWebhooksUpdate]({
          id: "swh_fixture",
          action: "disable",
          expectedRevision: 2,
        }).pipe(Effect.provide(mock)),
      );
      if (team) {
        expect(list._tag).toBe("Failure");
        expect(update._tag).toBe("Failure");
        expect(calls).toEqual([]);
      } else {
        expect(list._tag).toBe("Success");
        expect(update._tag).toBe("Success");
        expect(calls).toEqual([
          ["list", "local-user"],
          ["update", "local-user", "swh_fixture", "disable", 2],
        ]);
      }
    }).pipe(Effect.provide(integrationTestLayer(team))),
);
