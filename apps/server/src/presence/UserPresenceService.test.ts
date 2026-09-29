/**
 * T3-CUSTOM(expbkt3): the tracker keeps history past the lease, maps auth
 * sessions to people, bounds what it remembers, and folds the durable facts in.
 */
import { assert, describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentUserId,
  RpcClientId,
  ThreadId,
  UserId,
  type AuthClientSession,
  type BackgroundPolicySnapshot,
  type ClientActivityLease,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SessionStore from "../auth/SessionStore.ts";
import { BackgroundPolicy } from "../background/BackgroundPolicy.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as EnvironmentUsers from "../persistence/EnvironmentUsers.ts";
import {
  ingestLease,
  ingestSnapshot,
  make,
  MAX_TRACKED_CLIENTS,
  MAX_VIEWED_THREADS_PER_CLIENT,
  type TrackedClient,
} from "./UserPresenceService.ts";

const START = Date.parse("2026-09-29T12:00:00.000Z");
const MINUTE = 60_000;
const threadId = ThreadId.make("thread-here");
const otherThreadId = ThreadId.make("thread-elsewhere");
const ownerId = UserId.make("user-owner");
const memberId = UserId.make("user-member");
const ownerSession = AuthSessionId.make("auth-owner");
const memberSession = AuthSessionId.make("auth-member");
const anonymousSession = AuthSessionId.make("auth-anon");

const at = (ms: number) => DateTime.makeUnsafe(ms);

function lease(overrides: Partial<ClientActivityLease> = {}): ClientActivityLease {
  const updatedAt = overrides.updatedAt ?? at(START);
  return {
    sessionId: ownerSession,
    rpcClientId: RpcClientId.make(1),
    clientId: "client-owner",
    clientKind: "desktop-renderer",
    visible: true,
    focused: true,
    recentlyInteracted: true,
    scopes: [{ type: "provider-status" }, { type: "thread", threadId }],
    updatedAt,
    expiresAt: DateTime.add(updatedAt, { milliseconds: 45_000 }),
    ...overrides,
  };
}

function authSession(overrides: Partial<AuthClientSession> = {}): AuthClientSession {
  return {
    sessionId: ownerSession,
    userId: EnvironmentUserId.make(String(ownerId)),
    subject: `clerk:${ownerId}`,
    scopes: [],
    method: "pairing",
    client: { name: "desktop", version: "1", platform: "darwin", ip: null },
    issuedAt: at(START - 60 * MINUTE),
    expiresAt: at(START + 60 * MINUTE),
    lastConnectedAt: at(START - 3 * MINUTE),
    connected: true,
    current: false,
    ...overrides,
  } as AuthClientSession;
}

const shell = {
  id: threadId,
  title: "Presence thread",
  ownerUserId: ownerId,
  memberUserIds: [memberId],
  archivedAt: null,
  session: { status: "running", activeTurnId: null, lastError: null },
  hasPendingApprovals: false,
  hasPendingUserInput: true,
  hasActionableProposedPlan: false,
} as unknown as OrchestrationThreadShell;

interface Harness {
  readonly policyChanges: PubSub.PubSub<BackgroundPolicySnapshot>;
  readonly sessionChanges: PubSub.PubSub<SessionStore.SessionCredentialChange>;
  readonly snapshot: { current: BackgroundPolicySnapshot };
  readonly authSessions: { current: ReadonlyArray<AuthClientSession> };
  readonly userLookups: Array<string>;
}

const snapshotWith = (leases: ReadonlyArray<ClientActivityLease>): BackgroundPolicySnapshot =>
  ({ leases }) as unknown as BackgroundPolicySnapshot;

const makeHarness = Effect.gen(function* () {
  const policyChanges = yield* PubSub.unbounded<BackgroundPolicySnapshot>();
  const sessionChanges = yield* PubSub.unbounded<SessionStore.SessionCredentialChange>();
  const harness: Harness = {
    policyChanges,
    sessionChanges,
    snapshot: { current: snapshotWith([]) },
    authSessions: { current: [authSession()] },
    userLookups: [],
  };
  const layer = Layer.mergeAll(
    Layer.mock(BackgroundPolicy)({
      snapshot: Effect.sync(() => harness.snapshot.current),
      streamChanges: Stream.fromPubSub(policyChanges),
    }),
    Layer.mock(SessionStore.SessionStore)({
      cookieName: "t3-session",
      legacyCookieName: undefined,
      listActive: () => Effect.sync(() => harness.authSessions.current),
      streamChanges: Stream.fromPubSub(sessionChanges),
    }),
    Layer.mock(EnvironmentUsers.EnvironmentUserRepository)({
      get: (userId) =>
        Effect.sync(() => {
          harness.userLookups.push(String(userId));
          return String(userId) === String(ownerId)
            ? Option.some({
                userId,
                displayName: "Owner",
                primaryEmail: "owner@example.com",
                avatarUrl: null,
                role: "member" as const,
                status: "active" as const,
                firstSeenAt: at(START - 60 * MINUTE),
                lastSeenAt: at(START - 2 * MINUTE),
              })
            : Option.none();
        }),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (id) =>
        Effect.succeed(id === threadId ? Option.some(shell) : Option.none()),
      getThreadAccessById: () => Effect.succeed(Option.none()),
      getThreadDetailSnapshot: (id) =>
        Effect.succeed(
          id === threadId
            ? Option.some({
                snapshotSequence: 1,
                thread: {
                  ...shell,
                  messages: [
                    {
                      role: "user",
                      sentByUserId: ownerId,
                      createdAt: DateTime.formatIso(at(START - 20 * MINUTE)),
                    },
                    {
                      role: "assistant",
                      sentByUserId: null,
                      createdAt: DateTime.formatIso(at(START - 19 * MINUTE)),
                    },
                    {
                      role: "user",
                      sentByUserId: memberId,
                      createdAt: DateTime.formatIso(at(START - 5 * MINUTE)),
                    },
                  ],
                },
              } as never)
            : Option.none(),
        ),
    }),
  );
  const service = yield* make.pipe(Effect.provide(layer));
  return { harness, service };
});

const publishPolicy = (harness: Harness, leases: ReadonlyArray<ClientActivityLease>) =>
  Effect.gen(function* () {
    harness.snapshot.current = snapshotWith(leases);
    yield* PubSub.publish(harness.policyChanges, harness.snapshot.current);
    // Let the forked subscriber run.
    yield* TestClock.adjust(0);
  });

describe("ingestLease", () => {
  const record = (overrides: Partial<ClientActivityLease>) =>
    ingestLease(undefined, lease(overrides))!;

  it("remembers interaction, focus and viewed threads past later reports", () => {
    const first = record({});
    expect(first.lastInteractionAtMs).toBe(START);
    expect(first.lastFocusedAtMs).toBe(START);
    expect([...first.viewedThreads]).toEqual([[String(threadId), START]]);

    const later = ingestLease(
      first,
      lease({
        updatedAt: at(START + MINUTE),
        recentlyInteracted: false,
        focused: false,
        scopes: [{ type: "thread", threadId: otherThreadId }],
      }),
    )!;
    expect(later.lastInteractionAtMs).toBe(START);
    expect(later.lastFocusedAtMs).toBe(START);
    expect(later.viewingThreadIds).toEqual([String(otherThreadId)]);
    expect(later.viewedThreads.get(String(threadId))).toBe(START);
    expect(later.viewedThreads.get(String(otherThreadId))).toBe(START + MINUTE);
  });

  it("ignores a report that is not newer than the record", () => {
    const first = record({});
    expect(ingestLease(first, lease({ updatedAt: at(START) }))).toBeUndefined();
    expect(ingestLease(first, lease({ updatedAt: at(START - 1) }))).toBeUndefined();
  });

  it("bounds the viewed-thread map by dropping the least recently viewed", () => {
    let current: TrackedClient | undefined;
    for (let index = 0; index <= MAX_VIEWED_THREADS_PER_CLIENT; index += 1) {
      current = ingestLease(
        current,
        lease({
          updatedAt: at(START + index),
          scopes: [{ type: "thread", threadId: ThreadId.make(`thread-${index}`) }],
        }),
      );
    }
    assert(current !== undefined);
    expect(current.viewedThreads.size).toBe(MAX_VIEWED_THREADS_PER_CLIENT);
    expect(current.viewedThreads.has("thread-0")).toBe(false);
    expect(current.viewedThreads.has(`thread-${MAX_VIEWED_THREADS_PER_CLIENT}`)).toBe(true);
  });
});

describe("ingestSnapshot", () => {
  it("keys clients by auth session and client id, and evicts the stalest past the cap", () => {
    const clients = new Map<string, TrackedClient>();
    ingestSnapshot(clients, snapshotWith([lease(), lease({ rpcClientId: RpcClientId.make(2) })]));
    expect(clients.size).toBe(1);

    for (let index = 0; index < MAX_TRACKED_CLIENTS + 5; index += 1) {
      ingestSnapshot(
        clients,
        snapshotWith([lease({ clientId: `client-${index}`, updatedAt: at(START + 1 + index) })]),
      );
    }
    expect(clients.size).toBe(MAX_TRACKED_CLIENTS);
    expect([...clients.values()].some((client) => client.clientId === "client-owner")).toBe(false);
    expect([...clients.values()].some((client) => client.clientId === "client-0")).toBe(false);
    expect(
      [...clients.values()].some(
        (client) => client.clientId === `client-${MAX_TRACKED_CLIENTS + 4}`,
      ),
    ).toBe(true);
  });
});

describe("UserPresenceService.report", () => {
  it.effect("maps live leases to the session's people with roles and durable facts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START - 10 * MINUTE);
        const { harness, service } = yield* makeHarness;
        yield* TestClock.setTime(START);
        yield* publishPolicy(harness, [
          lease(),
          lease({
            sessionId: anonymousSession,
            clientId: "client-anon",
            clientKind: "web",
            scopes: [{ type: "thread", threadId }],
          }),
        ]);

        const report = yield* service.report({ threadId });
        expect(report.session).toEqual({
          sessionId: String(threadId),
          title: "Presence thread",
          status: "running",
          isRunning: true,
          needsHumanAttention: true,
          humanAttentionReasons: ["user-input"],
          archived: false,
        });
        expect(report.trackingSince).toBe("2026-09-29T11:50:00.000Z");
        expect(report.attended).toBe(true);
        expect(report.recommendation.action).toBe("ask-in-chat");

        const owner = report.people.find((person) => person.userId === String(ownerId));
        assert(owner !== undefined);
        expect(owner.roles).toEqual(["owner", "viewer"]);
        expect(owner.email).toBe("owner@example.com");
        expect(owner.name).toBe("Owner");
        expect(owner.state).toBe("viewing-this-session");
        expect(owner.lastMessageInSessionAt).toBe("2026-09-29T11:40:00.000Z");
        expect(owner.clients).toHaveLength(1);
        expect(owner.clients[0]?.viewingThisSession).toBe(true);

        const member = report.people.find((person) => person.userId === String(memberId));
        assert(member !== undefined);
        expect(member.roles).toEqual(["member", "last-sender"]);
        expect(member.email).toBeNull();
        expect(member.state).toBe("away");
        expect(member.lastMessageInSessionAt).toBe("2026-09-29T11:55:00.000Z");
        expect(member.lastSeenAt).toBe("2026-09-29T11:55:00.000Z");

        const anonymous = report.people.find((person) => person.userId === null);
        assert(anonymous !== undefined);
        expect(anonymous.roles).toEqual(["viewer"]);
        expect(anonymous.state).toBe("viewing-this-session");
        expect(report.caveats).toEqual([
          "1 live client(s) carry no user identity and are grouped under userId null",
        ]);
        expect(harness.userLookups).toEqual([String(ownerId), String(memberId)]);
      }),
    ),
  );

  it.effect("keeps the person's history after the lease expires and picks up new logins", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START - 10 * MINUTE);
        const { harness, service } = yield* makeHarness;
        yield* TestClock.setTime(START - 3 * MINUTE);
        yield* publishPolicy(harness, [lease({ updatedAt: at(START - 3 * MINUTE) })]);
        // The policy forgets the lease; the tracker must not.
        yield* TestClock.setTime(START);
        harness.snapshot.current = snapshotWith([]);

        const report = yield* service.report({ threadId });
        const owner = report.people.find((person) => person.userId === String(ownerId));
        assert(owner !== undefined);
        expect(owner.state).toBe("away");
        expect(owner.lastInteractionAt).toBe("2026-09-29T11:57:00.000Z");
        expect(owner.lastViewedThisSessionAt).toBe("2026-09-29T11:57:00.000Z");
        expect(owner.secondsSinceInteraction).toBe(180);
        expect(owner.clients[0]?.live).toBe(false);
        expect(owner.connected).toBe(true);
        expect(report.attended).toBe(false);
        // Auth-session last seen (3 min) beats the directory (2 min)? No: newest wins.
        expect(owner.lastSeenAt).toBe("2026-09-29T11:58:00.000Z");
        expect(report.recommendation.action).toBe("notify-mattermost");

        // A login that arrives later is mapped from the change stream, not a re-read.
        yield* PubSub.publish(harness.sessionChanges, {
          type: "clientUpserted",
          clientSession: authSession({
            sessionId: memberSession,
            userId: null,
            subject: `clerk:${memberId}`,
            connected: false,
          }),
        });
        yield* TestClock.adjust(0);
        yield* publishPolicy(harness, [
          lease({
            sessionId: memberSession,
            clientId: "client-member",
            clientKind: "mobile",
            appState: "active",
            updatedAt: at(START),
            scopes: [{ type: "thread", threadId: otherThreadId }],
          }),
        ]);
        const next = yield* service.report({ threadId });
        const member = next.people.find((person) => person.userId === String(memberId));
        assert(member !== undefined);
        expect(member.state).toBe("active-elsewhere");
        expect(member.clients[0]?.viewingThreadId).toBe(String(otherThreadId));
        expect(next.recommendation.action).toBe("ask-in-chat-and-notify");
      }),
    ),
  );

  it.effect("filters by userId or email and fails for an unknown session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service } = yield* makeHarness;
        const byEmail = yield* service.report({ threadId, email: "OWNER@example.com" });
        expect(byEmail.people.map((person) => person.userId)).toEqual([String(ownerId)]);
        const byUser = yield* service.report({ threadId, userId: String(memberId) });
        expect(byUser.people.map((person) => person.userId)).toEqual([String(memberId)]);
        const none = yield* service.report({ threadId, email: "nobody@example.com" });
        expect(none.people).toEqual([]);
        expect(none.caveats).toContain("no person on this session matches the userId/email filter");

        const missing = yield* Effect.flip(
          service.report({ threadId: ThreadId.make("thread-nope") }),
        );
        expect(missing.reason).toBe("not-found");
      }),
    ),
  );
});
