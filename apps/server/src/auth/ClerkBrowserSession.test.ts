import { EnvironmentId } from "@t3tools/contracts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentUserId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const testConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-clerk-browser-session-test-",
});

const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(testConfig),
);

it.layer(
  Layer.merge(
    NodeServices.layer,
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("fork-auth-test")),
    }),
  ),
)("Clerk browser sessions", (it) => {
  it.effect("persist the verified environment user id on the issued session", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const userId = EnvironmentUserId.make("user_clerk_alice");

      const issued = yield* auth.createClerkBrowserSession(
        { subject: "clerk:user_clerk_alice", userId },
        { deviceType: "unknown" },
      );
      const verified = yield* sessions.verify(issued.sessionToken);

      expect(verified.subject).toBe("clerk:user_clerk_alice");
      expect(verified.userId).toBe(userId);
    }).pipe(Effect.provide(authLayer)),
  );
});
