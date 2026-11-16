// T3-CUSTOM(expbkt3): proves session identity survives an upstream merge —
// owner and sender resolution, the changes that must restart a provider, and
// the degraded paths that must not block a turn.

import { EnvironmentUserId, UserId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EnvironmentUsers from "../persistence/EnvironmentUsers.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import {
  MESSAGE_SENDER_EMAIL_KEY,
  OWNER_EMAIL_KEY,
  OWNER_NAME_KEY,
  OWNER_USER_ID_KEY,
  SENDER_EMAIL_KEY,
  SENDER_NAME_KEY,
  SENDER_USER_ID_KEY,
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

const names: Record<string, string> = {
  [String(alice)]: "Alice Example",
  [String(bob)]: "Bob Example",
};

const seedUser = (
  userId: UserId,
  primaryEmail: string | null,
  displayName: string | null = names[String(userId)] ?? null,
) =>
  Effect.gen(function* () {
    const users = yield* EnvironmentUsers.EnvironmentUserRepository;
    yield* users.upsert({
      userId: EnvironmentUserId.make(String(userId)),
      displayName,
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
      [OWNER_NAME_KEY]: "Alice Example",
      [OWNER_EMAIL_KEY]: "alice@example.com",
      [OWNER_USER_ID_KEY]: "user_clerk_alice",
      [SESSION_OWNER_EMAIL_KEY]: "alice@example.com",
      [SENDER_NAME_KEY]: "Bob Example",
      [SENDER_EMAIL_KEY]: "bob@example.com",
      [SENDER_USER_ID_KEY]: "user_clerk_bob",
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
    expect(environment[SENDER_USER_ID_KEY]).toBeUndefined();
    expect(environment[SENDER_NAME_KEY]).toBeUndefined();
  }).pipe(Effect.provide(serviceLayer)),
);

it.effect("keeps only the user ids when the directory has no record of the users", () =>
  Effect.gen(function* () {
    const identity = yield* SessionIdentityEnvironmentService;

    const environment = yield* identity.resolve({ ownerUserId: alice, senderUserId: bob });

    expect(environment).toStrictEqual({
      [SESSION_IDENTITY_RUNTIME_KEY]: SESSION_IDENTITY_RUNTIME,
      [OWNER_USER_ID_KEY]: "user_clerk_alice",
      [SENDER_USER_ID_KEY]: "user_clerk_bob",
    });
  }).pipe(Effect.provide(serviceLayer)),
);

it.effect("omits a name or email the directory records as blank", () =>
  Effect.gen(function* () {
    yield* seedUser(alice, null, null);
    yield* seedUser(bob, "   ", "  ");
    const identity = yield* SessionIdentityEnvironmentService;

    const environment = yield* identity.resolve({ ownerUserId: alice, senderUserId: bob });

    expect(environment).toStrictEqual({
      [SESSION_IDENTITY_RUNTIME_KEY]: SESSION_IDENTITY_RUNTIME,
      [OWNER_USER_ID_KEY]: "user_clerk_alice",
      [SENDER_USER_ID_KEY]: "user_clerk_bob",
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

it.effect("restarts the provider when the sender's Clerk name changes", () =>
  Effect.gen(function* () {
    yield* seedUser(alice, "alice@example.com");
    yield* seedUser(bob, "bob@example.com", "Bob Example");
    const identity = yield* SessionIdentityEnvironmentService;

    const bound = yield* identity.resolve({ ownerUserId: alice, senderUserId: bob });
    yield* seedUser(bob, "bob@example.com", "Robert Example");
    const renamed = yield* identity.resolve({ ownerUserId: alice, senderUserId: bob });

    expect(renamed[SENDER_NAME_KEY]).toBe("Robert Example");
    expect(sessionIdentityFingerprint(renamed)).not.toBe(sessionIdentityFingerprint(bound));
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
  const unresolved = buildSessionIdentityEnvironment({ owner: null, sender: null });
  const resolved = buildSessionIdentityEnvironment({
    owner: { userId: null, name: null, email: "alice@example.com" },
    sender: null,
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
      owner: { userId: null, name: null, email: "alice@example.com" },
      sender: { userId: null, name: null, email: "bob@example.com" },
    }),
  });

  expect(composed?.environment).toStrictEqual({
    GH_TOKEN: "alice-token",
    GIT_AUTHOR_NAME: "Alice Example",
    GIT_AUTHOR_EMAIL: "alice@users.noreply.github.com",
    [SESSION_IDENTITY_RUNTIME_KEY]: SESSION_IDENTITY_RUNTIME,
    [OWNER_EMAIL_KEY]: "alice@example.com",
    [SESSION_OWNER_EMAIL_KEY]: "alice@example.com",
    [SENDER_EMAIL_KEY]: "bob@example.com",
    [MESSAGE_SENDER_EMAIL_KEY]: "bob@example.com",
  });
});

it("leaves execution options untouched when no identity was resolved", () => {
  expect(withSessionIdentityEnvironment(undefined)).toBeUndefined();
  const sourceControlOnly = { environment: { GH_TOKEN: "alice-token" } };
  expect(withSessionIdentityEnvironment(sourceControlOnly)).toBe(sourceControlOnly);
});

it.effect("resolves one directory person and keeps the id of an unknown one", () =>
  Effect.gen(function* () {
    yield* seedUser(bob, "bob@example.com");
    const identity = yield* SessionIdentityEnvironmentService;

    expect(yield* identity.resolvePerson(bob)).toStrictEqual({
      userId: "user_clerk_bob",
      name: "Bob Example",
      email: "bob@example.com",
    });
    expect(yield* identity.resolvePerson(alice)).toStrictEqual({
      userId: "user_clerk_alice",
      name: null,
      email: null,
    });
  }).pipe(Effect.provide(serviceLayer)),
);
