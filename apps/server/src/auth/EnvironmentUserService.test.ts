import { EnvironmentId } from "@t3tools/contracts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { EnvironmentUserId, SourceControlProfileId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as EnvironmentUsers from "../persistence/EnvironmentUsers.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as EnvironmentUserService from "./EnvironmentUserService.ts";

const githubAliceProfileId = SourceControlProfileId.make("github_alice");

const settingsLayer = ServerSettings.layerTest({
  environmentUserIdentityMode: "required",
  sourceControlProfiles: {
    [githubAliceProfileId]: {
      id: githubAliceProfileId,
      provider: "github",
      label: "Alice GitHub",
      login: "alice",
      accountId: 42,
      avatarUrl: null,
      gitName: "Alice Example",
      gitEmail: "alice@users.noreply.github.com",
      ownerUserId: EnvironmentUserId.make("user_clerk_alice"),
      archived: false,
    },
  },
});

const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-user-service-test-" });
const sessionLayer = SessionStore.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(configLayer),
  Layer.provide(SqlitePersistenceMemory),
);
const serviceLayer = EnvironmentUserService.layer.pipe(
  Layer.provide(EnvironmentUsers.layer),
  Layer.provideMerge(sessionLayer),
  Layer.provide(settingsLayer),
  Layer.provide(SqlitePersistenceMemory),
);

it.layer(
  Layer.merge(
    NodeServices.layer,
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("fork-auth-test")),
    }),
  ),
)("EnvironmentUserService", (it) => {
  it.effect("registers verified users, derives presence, and connects GitHub ownership", () =>
    Effect.gen(function* () {
      const users = yield* EnvironmentUserService.EnvironmentUserService;
      const sessions = yield* SessionStore.SessionStore;
      const alice = yield* users.admit(
        {
          userId: EnvironmentUserId.make("user_clerk_alice"),
          displayName: "Alice Example",
          primaryEmail: "alice@example.com",
          avatarUrl: null,
        },
        { administrativeGrant: true },
      );
      const bob = yield* users.admit(
        {
          userId: EnvironmentUserId.make("user_clerk_bob"),
          displayName: "Bob Example",
          primaryEmail: "bob@example.com",
          avatarUrl: null,
        },
        { administrativeGrant: false },
      );
      const aliceSession = yield* sessions.issue({ userId: alice.userId, subject: "pairing" });
      yield* sessions.issue({ userId: bob.userId, subject: "pairing" });
      yield* sessions.issue({ subject: "legacy-device" });
      yield* sessions.markConnected(aliceSession.sessionId);

      const directory = yield* users.list(aliceSession.sessionId);

      expect(alice.role).toBe("admin");
      expect(bob.role).toBe("member");
      expect(directory.identityMode).toBe("required");
      expect(directory.unidentifiedSessionCount).toBe(1);
      expect(directory.users.find((user) => user.id === alice.userId)).toMatchObject({
        presence: "online",
        current: true,
        sourceControlProfileId: "github_alice",
      });
      expect(yield* users.revokeUnidentifiedSessions).toBe(1);
      expect((yield* users.list(aliceSession.sessionId)).unidentifiedSessionCount).toBe(0);
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("blocks a member and revokes all of that user's sessions", () =>
    Effect.gen(function* () {
      const users = yield* EnvironmentUserService.EnvironmentUserService;
      const sessions = yield* SessionStore.SessionStore;
      const alice = yield* users.admit(
        {
          userId: EnvironmentUserId.make("user_clerk_alice"),
          displayName: "Alice",
          primaryEmail: null,
          avatarUrl: null,
        },
        { administrativeGrant: true },
      );
      const bob = yield* users.admit(
        {
          userId: EnvironmentUserId.make("user_clerk_bob"),
          displayName: "Bob",
          primaryEmail: null,
          avatarUrl: null,
        },
        { administrativeGrant: false },
      );
      yield* sessions.issue({ userId: alice.userId });
      yield* sessions.issue({ userId: bob.userId });
      yield* sessions.issue({ userId: bob.userId });

      const updated = yield* users.update({ userId: bob.userId, status: "blocked" });
      expect(updated.status).toBe("blocked");
      expect(
        (yield* sessions.listActive()).filter((session) => session.userId === bob.userId),
      ).toHaveLength(0);

      const error = yield* Effect.flip(
        users.admit({ ...bob, userId: bob.userId }, { administrativeGrant: false }),
      );
      expect(error.reason).toBe("identity-blocked");
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("does not allow the final active admin to be blocked", () =>
    Effect.gen(function* () {
      const users = yield* EnvironmentUserService.EnvironmentUserService;
      const alice = yield* users.admit(
        {
          userId: EnvironmentUserId.make("user_clerk_alice"),
          displayName: "Alice",
          primaryEmail: null,
          avatarUrl: null,
        },
        { administrativeGrant: true },
      );

      const error = yield* Effect.flip(users.update({ userId: alice.userId, status: "blocked" }));
      expect(error.reason).toBe("last-admin");
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("limits management to admins and assigns one GitHub profile per user", () =>
    Effect.gen(function* () {
      const users = yield* EnvironmentUserService.EnvironmentUserService;
      const sessions = yield* SessionStore.SessionStore;
      const alice = yield* users.admit(
        {
          userId: EnvironmentUserId.make("user_clerk_alice"),
          displayName: "Alice",
          primaryEmail: null,
          avatarUrl: null,
        },
        { administrativeGrant: true },
      );
      const bob = yield* users.admit(
        {
          userId: EnvironmentUserId.make("user_clerk_bob"),
          displayName: "Bob",
          primaryEmail: null,
          avatarUrl: null,
        },
        { administrativeGrant: true },
      );
      const aliceSession = yield* sessions.issue({ userId: alice.userId });
      const bobSession = yield* sessions.issue({ userId: bob.userId });

      yield* users.assertAdministrator(aliceSession.sessionId);
      const authorizationError = yield* Effect.flip(
        users.assertAdministrator(bobSession.sessionId),
      );
      expect(authorizationError.reason).toBe("not-authorized");
      expect(bob.role).toBe("member");

      yield* users.setSourceControlProfile({
        userId: alice.userId,
        sourceControlProfileId: null,
      });
      const updatedBob = yield* users.setSourceControlProfile({
        userId: bob.userId,
        sourceControlProfileId: githubAliceProfileId,
      });
      expect(updatedBob.sourceControlProfileId).toBe(githubAliceProfileId);
    }).pipe(Effect.provide(serviceLayer)),
  );
});
