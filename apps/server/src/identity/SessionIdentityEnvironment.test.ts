// T3-CUSTOM(expbkt3): proves session identity survives an upstream merge —
// owner and sender resolution, the changes that must restart a provider, and
// the degraded paths that must not block a turn.

import { EnvironmentUserId, UserId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EnvironmentUsers from "../persistence/EnvironmentUsers.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  MESSAGE_SENDER_EMAIL_KEY,
  SESSION_IDENTITY_RUNTIME,
  SESSION_IDENTITY_RUNTIME_KEY,
  SESSION_OWNER_EMAIL_KEY,
  SessionIdentityEnvironmentService,
  buildSessionIdentityEnvironment,
  layer as sessionIdentityLayer,
  sessionIdentityFingerprint,
  withSessionIdentityEnvironment,
} from "./SessionIdentityEnvironment.ts";

const serviceLayer = sessionIdentityLayer.pipe(
  Layer.provideMerge(EnvironmentUsers.layer),
  Layer.provide(SqlitePersistenceMemory),
);

const alice = UserId.make("user_clerk_alice");
const bob = UserId.make("user_clerk_bob");
const seenAt = DateTime.makeUnsafe("2026-08-18T10:00:00.000Z");

const seedUser = (userId: UserId, primaryEmail: string | null) =>
  Effect.gen(function* () {
    const users = yield* EnvironmentUsers.EnvironmentUserRepository;
    yield* users.upsert({
      userId: EnvironmentUserId.make(String(userId)),
      displayName: String(userId),
      primaryEmail,
      avatarUrl: null,
      role: "member",
      status: "active",
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    });
  });

it.effect("names the thread owner and the user who actually sent the message", () =>
  Effect.gen(function* () {
    yield* seedUser(alice, "alice@example.com");
    yield* seedUser(bob, "bob@example.com");
    const identity = yield* SessionIdentityEnvironmentService;

    const environment = yield* identity.resolve({ ownerUserId: alice, senderUserId: bob });

    expect(environment).toStrictEqual({
      [SESSION_IDENTITY_RUNTIME_KEY]: SESSION_IDENTITY_RUNTIME,
      [SESSION_OWNER_EMAIL_KEY]: "alice@example.com",
      [MESSAGE_SENDER_EMAIL_KEY]: "bob@example.com",
    });
  }).pipe(Effect.provide(serviceLayer)),
);

it.effect("never manufactures a sender from the owner", () =>
  Effect.gen(function* () {
    yield* seedUser(alice, "alice@example.com");
    const identity = yield* SessionIdentityEnvironmentService;

    const environment = yield* identity.resolve({ ownerUserId: alice, senderUserId: null });

    expect(environment[SESSION_OWNER_EMAIL_KEY]).toBe("alice@example.com");
    expect(environment[MESSAGE_SENDER_EMAIL_KEY]).toBeUndefined();
  }).pipe(Effect.provide(serviceLayer)),
);

it.effect("reports the runtime alone when the directory has no record of the users", () =>
  Effect.gen(function* () {
    const identity = yield* SessionIdentityEnvironmentService;

    const environment = yield* identity.resolve({ ownerUserId: alice, senderUserId: bob });

    expect(environment).toStrictEqual({
      [SESSION_IDENTITY_RUNTIME_KEY]: SESSION_IDENTITY_RUNTIME,
    });
  }).pipe(Effect.provide(serviceLayer)),
);

it.effect("omits an email the directory records as blank", () =>
  Effect.gen(function* () {
    yield* seedUser(alice, null);
    yield* seedUser(bob, "   ");
    const identity = yield* SessionIdentityEnvironmentService;

    const environment = yield* identity.resolve({ ownerUserId: alice, senderUserId: bob });

    expect(environment).toStrictEqual({
      [SESSION_IDENTITY_RUNTIME_KEY]: SESSION_IDENTITY_RUNTIME,
    });
  }).pipe(Effect.provide(serviceLayer)),
);

it.effect("resolves an unknown sender without losing the known owner", () =>
  Effect.gen(function* () {
    yield* seedUser(alice, "alice@example.com");
    const identity = yield* SessionIdentityEnvironmentService;

    const environment = yield* identity.resolve({ ownerUserId: alice, senderUserId: bob });

    expect(environment[SESSION_OWNER_EMAIL_KEY]).toBe("alice@example.com");
    expect(environment[MESSAGE_SENDER_EMAIL_KEY]).toBeUndefined();
  }).pipe(Effect.provide(serviceLayer)),
);

it.effect("restarts the provider when a different contributor sends the next message", () =>
  Effect.gen(function* () {
    yield* seedUser(alice, "alice@example.com");
    yield* seedUser(bob, "bob@example.com");
    const identity = yield* SessionIdentityEnvironmentService;

    const bound = yield* identity.resolve({ ownerUserId: alice, senderUserId: alice });
    const unchanged = yield* identity.resolve({ ownerUserId: alice, senderUserId: alice });
    const senderChanged = yield* identity.resolve({ ownerUserId: alice, senderUserId: bob });

    expect(sessionIdentityFingerprint(unchanged)).toBe(sessionIdentityFingerprint(bound));
    expect(sessionIdentityFingerprint(senderChanged)).not.toBe(sessionIdentityFingerprint(bound));
  }).pipe(Effect.provide(serviceLayer)),
);

it.effect("restarts the provider when the thread is transferred to a new owner", () =>
  Effect.gen(function* () {
    yield* seedUser(alice, "alice@example.com");
    yield* seedUser(bob, "bob@example.com");
    const identity = yield* SessionIdentityEnvironmentService;

    const bound = yield* identity.resolve({ ownerUserId: alice, senderUserId: bob });
    const transferred = yield* identity.resolve({ ownerUserId: bob, senderUserId: bob });

    expect(transferred[SESSION_OWNER_EMAIL_KEY]).toBe("bob@example.com");
    expect(sessionIdentityFingerprint(transferred)).not.toBe(sessionIdentityFingerprint(bound));
  }).pipe(Effect.provide(serviceLayer)),
);

it("distinguishes an unresolved identity from a resolved one", () => {
  const unresolved = buildSessionIdentityEnvironment({ ownerEmail: null, senderEmail: null });
  const resolved = buildSessionIdentityEnvironment({
    ownerEmail: "alice@example.com",
    senderEmail: null,
  });

  expect(unresolved[SESSION_IDENTITY_RUNTIME_KEY]).toBe(SESSION_IDENTITY_RUNTIME);
  expect(sessionIdentityFingerprint(unresolved)).not.toBe(sessionIdentityFingerprint(resolved));
});

it("carries the identity markers in machine source-control mode", () => {
  const composed = withSessionIdentityEnvironment({
    identityEnvironment: { [SESSION_IDENTITY_RUNTIME_KEY]: SESSION_IDENTITY_RUNTIME },
    actorUserId: alice,
  });

  expect(composed?.environment).toStrictEqual({
    [SESSION_IDENTITY_RUNTIME_KEY]: SESSION_IDENTITY_RUNTIME,
  });
  expect(composed?.actorUserId).toBe(alice);
});

it("composes with a thread profile without displacing its Git identity", () => {
  const composed = withSessionIdentityEnvironment({
    environment: {
      GH_TOKEN: "alice-token",
      GIT_AUTHOR_NAME: "Alice Example",
      GIT_AUTHOR_EMAIL: "alice@users.noreply.github.com",
    },
    identityEnvironment: buildSessionIdentityEnvironment({
      ownerEmail: "alice@example.com",
      senderEmail: "bob@example.com",
    }),
  });

  expect(composed?.environment).toStrictEqual({
    GH_TOKEN: "alice-token",
    GIT_AUTHOR_NAME: "Alice Example",
    GIT_AUTHOR_EMAIL: "alice@users.noreply.github.com",
    [SESSION_IDENTITY_RUNTIME_KEY]: SESSION_IDENTITY_RUNTIME,
    [SESSION_OWNER_EMAIL_KEY]: "alice@example.com",
    [MESSAGE_SENDER_EMAIL_KEY]: "bob@example.com",
  });
});

it("leaves execution options untouched when no identity was resolved", () => {
  expect(withSessionIdentityEnvironment(undefined)).toBeUndefined();
  const sourceControlOnly = { environment: { GH_TOKEN: "alice-token" } };
  expect(withSessionIdentityEnvironment(sourceControlOnly)).toBe(sourceControlOnly);
});
