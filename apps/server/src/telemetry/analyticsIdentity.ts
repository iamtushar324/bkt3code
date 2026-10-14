/**
 * T3-CUSTOM(expbkt3): who a bkt3 analytics event belongs to.
 *
 * An event recorded with a `userId` is sent as that person: their
 * `environment_users.primary_email` becomes the PostHog `distinct_id`. The
 * user table is read at most once per `USER_DIRECTORY_REFRESH_MS`, never once
 * per event. A user without an email, or a caller with no user repository in
 * its context, falls back to the install-level anonymous id.
 *
 * The repository is read from the caller's context rather than the analytics
 * layer's, because `AnalyticsService` sits below persistence in the server's
 * layer stack. Every runtime service (websocket handlers, MCP tools, reactors)
 * has `EnvironmentUserRepository` in its context.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import * as EnvironmentUsers from "../persistence/EnvironmentUsers.ts";

export const USER_DIRECTORY_REFRESH_MS = 5 * 60_000;

/** The person-profile fields PostHog stores for an identified user. */
export interface AnalyticsPerson {
  readonly email: string;
  readonly name: string | undefined;
  readonly role: string;
}

interface UserDirectoryState {
  /** Epoch ms of the last read attempt, or null before the first. */
  readonly loadedAt: number | null;
  readonly people: ReadonlyMap<string, AnalyticsPerson>;
}

/** Users with an email, keyed by user id. Emails are trimmed and lower-cased. */
export function analyticsPeopleFromUsers(
  users: ReadonlyArray<EnvironmentUsers.EnvironmentUserRecord>,
): ReadonlyMap<string, AnalyticsPerson> {
  const people = new Map<string, AnalyticsPerson>();
  for (const user of users) {
    const email = user.primaryEmail?.trim().toLowerCase() ?? "";
    if (email === "") continue;
    const name = user.displayName?.trim() ?? "";
    people.set(user.userId, {
      email,
      name: name === "" ? undefined : name,
      role: user.role,
    });
  }
  return people;
}

/** Caches `environment_users` for identity lookups. */
export const makeAnalyticsUserDirectory = Effect.gen(function* () {
  const stateRef = yield* Ref.make<UserDirectoryState>({ loadedAt: null, people: new Map() });

  const refresh = Effect.gen(function* () {
    const repository = yield* Effect.serviceOption(EnvironmentUsers.EnvironmentUserRepository);
    // No repository here: try again on the next lookup, which costs no DB read.
    if (Option.isNone(repository)) return;
    const now = yield* Clock.currentTimeMillis;
    const users = yield* Effect.result(repository.value.list);
    yield* Ref.update(stateRef, (state) => ({
      loadedAt: now,
      // A failed read keeps the last good map until the next refresh window.
      people: Result.isSuccess(users) ? analyticsPeopleFromUsers(users.success) : state.people,
    }));
  });

  /** The person for `userId`, or undefined when unknown or without an email. */
  const resolve = (userId: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const state = yield* Ref.get(stateRef);
      if (state.loadedAt === null || now - state.loadedAt >= USER_DIRECTORY_REFRESH_MS) {
        yield* refresh;
      }
      return (yield* Ref.get(stateRef)).people.get(userId);
    });

  return { resolve } as const;
});

/**
 * A stable UUID for a caller-chosen insert id, so a re-sent or backfilled
 * event lands on the same PostHog `uuid` and is de-duplicated. `sha256Hex` is
 * the hex SHA-256 of the insert id. The result has UUID version 8 (custom).
 */
export function uuidFromSha256Hex(sha256Hex: string): string {
  const hex = sha256Hex.toLowerCase().padEnd(32, "0");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
