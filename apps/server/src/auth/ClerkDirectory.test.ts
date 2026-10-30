import { UserId, type OrchestrationUser } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  CLERK_MEMBERSHIP_CACHE_TTL_MS,
  CLERK_REQUEST_TIMEOUT,
  type ClerkDirectoryBackend,
  makeEnabledDirectory,
} from "./ClerkDirectory.ts";

const ORGANIZATION_ID = "org_team";

const config = {
  secretKey: "sk_test_directory",
  publishableKey: undefined,
  organizationId: ORGANIZATION_ID,
  defaultOwnerUserId: undefined,
  defaultOwnerEmail: undefined,
};

const alice: OrchestrationUser = {
  id: UserId.make("user_alice"),
  name: "Alice Example",
  email: "alice@example.com",
  imageUrl: null,
  isAdmin: true,
};
const bob: OrchestrationUser = {
  id: UserId.make("user_bob"),
  name: "Bob Example",
  email: "bob@example.com",
  imageUrl: null,
  isAdmin: false,
};

/** A Clerk Backend API that can be told to stop answering. */
const makeBackend = () => {
  const state = {
    members: [alice] as ReadonlyArray<OrchestrationUser>,
    hangMemberList: false,
    memberListCalls: 0,
    memberships: new Map<string, ReadonlyArray<string>>([["user_alice", [ORGANIZATION_ID]]]),
    membershipCalls: 0,
  };
  const backend: ClerkDirectoryBackend = {
    // The test token is the Clerk user id itself, with no org claim.
    verifyToken: (token) => Promise.resolve({ sub: token }),
    listOrgMembersPage: () => {
      state.memberListCalls += 1;
      if (state.hangMemberList) return new Promise(() => {});
      return Promise.resolve({
        members: state.members,
        pageLength: state.members.length,
        totalCount: state.members.length,
      });
    },
    listUserOrganizationIds: (userId) => {
      state.membershipCalls += 1;
      return Promise.resolve(state.memberships.get(userId) ?? []);
    },
    findUserIdByEmail: () => Promise.resolve(null),
  };
  return { state, backend };
};

it.effect("serves the cached member list at once while Clerk does not answer", () =>
  Effect.gen(function* () {
    const { state, backend } = makeBackend();
    const directory = yield* makeEnabledDirectory(config, backend);
    expect(yield* directory.listOrgMembers()).toEqual([alice]);
    expect(state.memberListCalls).toBe(1);

    state.hangMemberList = true;
    state.members = [alice, bob];
    yield* TestClock.adjust(Duration.minutes(3));

    // Stale and Clerk hangs: the connect path still gets the last good list.
    expect(yield* directory.listOrgMembers()).toEqual([alice]);
    expect(yield* directory.isOrgAdmin(alice.id)).toBe(true);

    // The background refresh gives up after the timeout and keeps the list.
    yield* TestClock.adjust(CLERK_REQUEST_TIMEOUT);
    expect(yield* directory.listOrgMembers()).toEqual([alice]);
    expect(state.memberListCalls).toBe(2);
  }).pipe(Effect.scoped),
);

it.effect("fails the first load after the Clerk timeout when nothing is cached", () =>
  Effect.gen(function* () {
    const { state, backend } = makeBackend();
    state.hangMemberList = true;
    const directory = yield* makeEnabledDirectory(config, backend);

    const pending = yield* directory
      .listOrgMembers()
      .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust(CLERK_REQUEST_TIMEOUT);
    const error = yield* Fiber.join(pending);

    expect(error._tag).toBe("ClerkDirectoryError");
    // The warm-up load and the waiting caller shared one Clerk call.
    expect(state.memberListCalls).toBe(1);
    expect(yield* directory.isOrgAdmin(alice.id)).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("caches a confirmed sign-in membership for five minutes, never a refusal", () =>
  Effect.gen(function* () {
    const { state, backend } = makeBackend();
    const directory = yield* makeEnabledDirectory(config, backend);

    expect((yield* directory.verifySessionToken("user_alice")).userId).toBe(alice.id);
    expect((yield* directory.verifySessionToken("user_alice")).userId).toBe(alice.id);
    expect(state.membershipCalls).toBe(1);

    yield* TestClock.adjust(CLERK_MEMBERSHIP_CACHE_TTL_MS);
    yield* directory.verifySessionToken("user_alice");
    expect(state.membershipCalls).toBe(2);

    const refused = yield* Effect.flip(directory.verifySessionToken("user_mallory"));
    expect(refused.reason).toBe("not_org_member");
    // A user who joins the org later is not locked out by a cached refusal.
    state.memberships.set("user_mallory", [ORGANIZATION_ID]);
    expect((yield* directory.verifySessionToken("user_mallory")).userId).toBe("user_mallory");
    expect(state.membershipCalls).toBe(4);
  }).pipe(Effect.scoped),
);
