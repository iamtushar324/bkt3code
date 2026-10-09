/**
 * T3-CUSTOM(expbkt3): the tracker keeps history past the lease, keys
 * connections like upstream does, maps logins to people, bounds what it
 * remembers, and folds the durable facts in.
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
import { OrchestrationAccessControl } from "../orchestration-v2/Services/AccessControl.ts";
import { ProjectionSnapshotQuery } from "../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import * as EnvironmentUsers from "../persistence/EnvironmentUsers.ts";
import {
  PresenceMessageQuery,
  PresenceMessageReadError,
  type LatestUserMessage,
} from "./presenceMessages.ts";
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
const strangerId = UserId.make("user-stranger");
const ownerSession = AuthSessionId.make("auth-owner");
const memberSession = AuthSessionId.make("auth-member");
const strangerSession = AuthSessionId.make("auth-stranger");
const anonymousSession = AuthSessionId.make("auth-anon");

const at = (ms: number) => DateTime.makeUnsafe(ms);
const iso = (ms: number) => DateTime.formatIso(at(ms));

/** Walks a value's strings without serialising it, so no thread id can hide in a nested field. */
const mentions = (value: unknown, needle: string): boolean =>
  typeof value === "string"
    ? value.includes(needle)
    : Array.isArray(value)
      ? value.some((entry) => mentions(entry, needle))
      : typeof value === "object" && value !== null
        ? Object.values(value).some((entry) => mentions(entry, needle))
        : false;

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
  readonly messages: { current: ReadonlyArray<LatestUserMessage>; fail: boolean };
  readonly userLookups: Array<string>;
  readonly accessChecks: Array<string>;
}

const snapshotWith = (
  leases: ReadonlyArray<ClientActivityLease>,
  updatedAtMs: number,
): BackgroundPolicySnapshot =>
  ({ leases, updatedAt: at(updatedAtMs) }) as unknown as BackgroundPolicySnapshot;

const makeHarness = Effect.gen(function* () {
  const policyChanges = yield* PubSub.unbounded<BackgroundPolicySnapshot>();
  const sessionChanges = yield* PubSub.unbounded<SessionStore.SessionCredentialChange>();
  const harness: Harness = {
    policyChanges,
    sessionChanges,
    snapshot: { current: snapshotWith([], START - 10 * MINUTE) },
    authSessions: { current: [authSession()] },
    messages: {
      current: [
        { userId: String(ownerId), createdAt: iso(START - 20 * MINUTE) },
        { userId: String(memberId), createdAt: iso(START - 5 * MINUTE) },
      ],
      fail: false,
    },
    userLookups: [],
    accessChecks: [],
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
    }),
    Layer.mock(OrchestrationAccessControl)({
      actorFor: () => Option.none(),
      canAccessThread: (userId, id) =>
        Effect.sync(() => {
          harness.accessChecks.push(`${userId}@${id}`);
          return String(userId) !== String(strangerId);
        }),
    }),
    Layer.mock(PresenceMessageQuery)({
      latestUserMessageBySender: () =>
        harness.messages.fail
          ? Effect.fail(new PresenceMessageReadError({ threadId, cause: "sqlite busy" }))
          : Effect.succeed(harness.messages.current),
    }),
  );
  const service = yield* make.pipe(Effect.provide(layer));
  // Let the forked subscribers attach before the first publish.
  yield* TestClock.adjust(0);
  return { harness, service };
});

const publishPolicy = (
  harness: Harness,
  leases: ReadonlyArray<ClientActivityLease>,
  updatedAtMs: number,
) =>
  Effect.gen(function* () {
    harness.snapshot.current = snapshotWith(leases, updatedAtMs);
    yield* PubSub.publish(harness.policyChanges, harness.snapshot.current);
    // Let the forked subscriber run.
    yield* TestClock.adjust(0);
  });

describe("ingestLease", () => {
  const record = (overrides: Partial<ClientActivityLease>) =>
    ingestLease(undefined, lease(overrides))!;

  it("remembers interaction, focus and viewed threads past later reports", () => {
    const first = record({});
    expect(first.rpcClientId).toBe(RpcClientId.make(1));
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
  it("keys connections by login, socket and client id, so two tabs do not overwrite each other", () => {
    const clients = new Map<string, TrackedClient>();
    ingestSnapshot(
      clients,
      snapshotWith(
        [
          lease({ scopes: [{ type: "thread", threadId }] }),
          lease({
            rpcClientId: RpcClientId.make(2),
            scopes: [{ type: "thread", threadId: otherThreadId }],
          }),
        ],
        START,
      ),
    );
    expect(clients.size).toBe(2);
    expect([...clients.values()].map((client) => client.viewingThreadIds)).toEqual([
      [String(threadId)],
      [String(otherThreadId)],
    ]);
  });

  it("ends the lease of a connection that left the snapshot", () => {
    const clients = new Map<string, TrackedClient>();
    ingestSnapshot(clients, snapshotWith([lease()], START));
    ingestSnapshot(clients, snapshotWith([], START + 5_000));
    const [client] = clients.values();
    assert(client !== undefined);
    expect(client.leaseExpiresAtMs).toBe(START + 5_000);
    expect(client.lastReportAtMs).toBe(START);
    // A later snapshot must not push the end forward again.
    ingestSnapshot(clients, snapshotWith([], START + 9_000));
    expect([...clients.values()][0]?.leaseExpiresAtMs).toBe(START + 5_000);
  });

  it("evicts the stalest connection past the cap", () => {
    const clients = new Map<string, TrackedClient>();
    ingestSnapshot(clients, snapshotWith([lease()], START));
    for (let index = 0; index < MAX_TRACKED_CLIENTS + 5; index += 1) {
      ingestSnapshot(
        clients,
        snapshotWith(
          [lease({ rpcClientId: RpcClientId.make(100 + index), updatedAt: at(START + 1 + index) })],
          START + 1 + index,
        ),
      );
    }
    expect(clients.size).toBe(MAX_TRACKED_CLIENTS);
    expect([...clients.values()].some((client) => client.rpcClientId === 1)).toBe(false);
    expect([...clients.values()].some((client) => client.rpcClientId === 100)).toBe(false);
    expect(
      [...clients.values()].some((client) => client.rpcClientId === 100 + MAX_TRACKED_CLIENTS + 4),
    ).toBe(true);
  });
});

describe("UserPresenceService.report", () => {
  it.effect("maps live leases to the session's people with roles and durable facts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START - 10 * MINUTE);
        const { harness, service } = yield* makeHarness;
        expect(yield* service.trackingSince).toBeNull();
        // Warm-up runs from the first report, not from construction.
        yield* publishPolicy(
          harness,
          [lease({ updatedAt: at(START - 10 * MINUTE) })],
          START - 10 * MINUTE,
        );
        expect(yield* service.trackingSince).toBe(START - 10 * MINUTE);
        yield* TestClock.setTime(START);
        yield* publishPolicy(
          harness,
          [
            lease(),
            lease({
              sessionId: anonymousSession,
              rpcClientId: RpcClientId.make(2),
              clientId: "client-anon",
              clientKind: "web",
              scopes: [{ type: "thread", threadId }],
            }),
            lease({
              sessionId: anonymousSession,
              rpcClientId: RpcClientId.make(3),
              clientId: "client-anon",
              clientKind: "web",
              scopes: [{ type: "thread", threadId: otherThreadId }],
            }),
          ],
          START,
        );

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
        expect(report.trackingSince).toBe(iso(START - 10 * MINUTE));
        expect(report.attended).toBe(true);
        expect(report.recommendation.action).toBe("ask-in-chat");

        const owner = report.people.find((person) => person.userId === String(ownerId));
        assert(owner !== undefined);
        expect(owner.roles).toEqual(["owner", "viewer"]);
        expect(owner.email).toBe("owner@example.com");
        expect(owner.name).toBe("Owner");
        expect(owner.state).toBe("viewing-this-session");
        expect(owner.lastMessageInSessionAt).toBe(iso(START - 20 * MINUTE));
        expect(owner.clients).toHaveLength(1);
        expect(owner.clients[0]?.viewingThisSession).toBe(true);

        const member = report.people.find((person) => person.userId === String(memberId));
        assert(member !== undefined);
        expect(member.roles).toEqual(["member", "last-sender"]);
        expect(member.email).toBeNull();
        expect(member.state).toBe("away");
        expect(member.lastMessageInSessionAt).toBe(iso(START - 5 * MINUTE));
        expect(member.lastSeenAt).toBe(iso(START - 5 * MINUTE));

        // Only the unidentified tab that has this session open is reported.
        const anonymous = report.people.find((person) => person.userId === null);
        assert(anonymous !== undefined);
        expect(anonymous.roles).toEqual(["viewer"]);
        expect(anonymous.state).toBe("viewing-this-session");
        expect(anonymous.clients).toHaveLength(1);
        expect(anonymous.clients[0]?.viewingThisSession).toBe(true);
        expect(report.caveats).toEqual([
          "1 live client(s) carry no user identity and are grouped under userId null",
        ]);
        expect(harness.userLookups).toEqual([String(ownerId), String(memberId)]);
        // Owner and member need no access check for their viewer role.
        expect(harness.accessChecks).toEqual([]);

        const elsewhere = yield* service.report({ threadId: otherThreadId }).pipe(Effect.flip);
        expect(elsewhere.reason).toBe("not-found");
      }),
    ),
  );

  it.effect("leaves out unidentified clients that are not looking at this session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { harness, service } = yield* makeHarness;
        yield* publishPolicy(
          harness,
          [
            lease({
              sessionId: anonymousSession,
              clientId: "client-anon",
              scopes: [{ type: "thread", threadId: otherThreadId }],
            }),
          ],
          START,
        );
        const report = yield* service.report({ threadId });
        expect(report.people.some((person) => person.userId === null)).toBe(false);
        expect(report.attended).toBe(false);
      }),
    ),
  );

  it.effect("keeps a person's history after the socket closes and picks up new logins", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START - 10 * MINUTE);
        const { harness, service } = yield* makeHarness;
        yield* TestClock.setTime(START - 3 * MINUTE);
        yield* publishPolicy(
          harness,
          [lease({ updatedAt: at(START - 3 * MINUTE) })],
          START - 3 * MINUTE,
        );
        // The socket closes: the policy drops the lease before its expiry.
        yield* publishPolicy(harness, [], START - 3 * MINUTE + 10_000);
        yield* TestClock.setTime(START - 3 * MINUTE + 20_000);

        const early = yield* service.report({ threadId });
        const ownerEarly = early.people.find((person) => person.userId === String(ownerId));
        assert(ownerEarly !== undefined);
        expect(ownerEarly.state).toBe("away");
        expect(ownerEarly.clients[0]?.live).toBe(false);
        expect(ownerEarly.clients[0]?.leaseExpiresAt).toBe(iso(START - 3 * MINUTE + 10_000));

        yield* TestClock.setTime(START);
        const report = yield* service.report({ threadId });
        const owner = report.people.find((person) => person.userId === String(ownerId));
        assert(owner !== undefined);
        expect(owner.state).toBe("away");
        expect(owner.lastInteractionAt).toBe(iso(START - 3 * MINUTE));
        expect(owner.lastViewedThisSessionAt).toBe(iso(START - 3 * MINUTE));
        expect(owner.secondsSinceInteraction).toBe(180);
        expect(owner.connected).toBe(true);
        expect(report.attended).toBe(false);
        expect(owner.lastSeenAt).toBe(iso(START - 2 * MINUTE));
        expect(report.recommendation.action).toBe("ask-in-chat-and-wait");

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
        yield* publishPolicy(
          harness,
          [
            lease({
              sessionId: memberSession,
              rpcClientId: RpcClientId.make(7),
              clientId: "client-member",
              clientKind: "mobile",
              appState: "active",
              updatedAt: at(START),
              scopes: [{ type: "thread", threadId: otherThreadId }],
            }),
          ],
          START,
        );
        const next = yield* service.report({ threadId });
        const member = next.people.find((person) => person.userId === String(memberId));
        assert(member !== undefined);
        expect(member.state).toBe("active-elsewhere");
        expect(member.clients[0]?.viewingAnotherSession).toBe(true);
        expect(mentions(next, String(otherThreadId))).toBe(false);
        expect(next.recommendation.action).toBe("ask-in-chat-and-wait");
      }),
    ),
  );

  it.effect("only lists a viewer who may access the thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { harness, service } = yield* makeHarness;
        harness.authSessions.current = [
          authSession(),
          authSession({
            sessionId: strangerSession,
            userId: EnvironmentUserId.make(String(strangerId)),
            subject: `clerk:${strangerId}`,
          }),
        ];
        yield* publishPolicy(
          harness,
          [lease({ sessionId: strangerSession, clientId: "client-stranger" })],
          START,
        );
        const report = yield* service.report({ threadId });
        expect(report.people.some((person) => person.userId === String(strangerId))).toBe(false);
        expect(harness.accessChecks).toEqual([`${strangerId}@${threadId}`]);
        expect(report.attended).toBe(false);
      }),
    ),
  );

  it.effect(
    "filters by userId or email, survives a failed message read, and fails for an unknown session",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(START);
          const { harness, service } = yield* makeHarness;
          const byEmail = yield* service.report({ threadId, email: "OWNER@example.com" });
          expect(byEmail.people.map((person) => person.userId)).toEqual([String(ownerId)]);
          const byUser = yield* service.report({ threadId, userId: String(memberId) });
          expect(byUser.people.map((person) => person.userId)).toEqual([String(memberId)]);
          const none = yield* service.report({ threadId, email: "nobody@example.com" });
          expect(none.people).toEqual([]);
          expect(none.caveats).toContain(
            "no person on this session matches the userId/email filter",
          );

          harness.messages.fail = true;
          const degraded = yield* service.report({ threadId });
          expect(degraded.caveats).toContain(
            "last-message times are unavailable: the message read failed",
          );
          expect(degraded.people.map((person) => person.roles)).toEqual([["owner"], ["member"]]);

          const missing = yield* Effect.flip(
            service.report({ threadId: ThreadId.make("thread-nope") }),
          );
          expect(missing.reason).toBe("not-found");
        }),
      ),
  );
});
