import { EnvironmentUserId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import * as EnvironmentUsers from "./EnvironmentUsers.ts";

const repositoryLayer = EnvironmentUsers.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.effect("keeps the first role/status while refreshing verified Clerk presentation", () =>
  Effect.gen(function* () {
    const users = yield* EnvironmentUsers.EnvironmentUserRepository;
    const userId = EnvironmentUserId.make("user_clerk_alice");
    const firstSeenAt = DateTime.makeUnsafe("2026-08-01T10:00:00.000Z");
    const lastSeenAt = DateTime.makeUnsafe("2026-08-01T11:00:00.000Z");

    yield* users.upsert({
      userId,
      displayName: "Alice",
      primaryEmail: "alice@example.com",
      avatarUrl: null,
      role: "admin",
      status: "active",
      firstSeenAt,
      lastSeenAt: firstSeenAt,
    });
    yield* users.upsert({
      userId,
      displayName: "Alice Updated",
      primaryEmail: null,
      avatarUrl: "https://images.example.com/alice.png",
      role: "member",
      status: "blocked",
      firstSeenAt: lastSeenAt,
      lastSeenAt,
    });

    const [user] = yield* users.list;
    expect(user).toMatchObject({
      userId,
      displayName: "Alice Updated",
      primaryEmail: "alice@example.com",
      avatarUrl: "https://images.example.com/alice.png",
      role: "admin",
      status: "active",
    });
    expect(user?.firstSeenAt.epochMilliseconds).toBe(firstSeenAt.epochMilliseconds);
    expect(user?.lastSeenAt.epochMilliseconds).toBe(lastSeenAt.epochMilliseconds);
  }).pipe(Effect.provide(repositoryLayer)),
);

it.effect("updates administrative state without replacing identity metadata", () =>
  Effect.gen(function* () {
    const users = yield* EnvironmentUsers.EnvironmentUserRepository;
    const userId = EnvironmentUserId.make("user_clerk_bob");
    const now = DateTime.makeUnsafe("2026-08-01T10:00:00.000Z");
    yield* users.upsert({
      userId,
      displayName: "Bob",
      primaryEmail: "bob@example.com",
      avatarUrl: null,
      role: "member",
      status: "active",
      firstSeenAt: now,
      lastSeenAt: now,
    });

    expect(yield* users.update({ userId, role: "admin", status: "blocked" })).toBe(true);
    const user = yield* users.get(userId);
    expect(user._tag).toBe("Some");
    if (user._tag === "Some") {
      expect(user.value).toMatchObject({ role: "admin", status: "blocked", displayName: "Bob" });
    }
  }).pipe(Effect.provide(repositoryLayer)),
);
