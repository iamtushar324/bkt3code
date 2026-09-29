/**
 * T3-CUSTOM(expbkt3): user presence tracker.
 *
 * Upstream's `BackgroundPolicy` keeps a 45 s lease per connected client and
 * forgets it on expiry — enough to throttle background work, not enough to
 * tell an agent whether the human is still around. This service follows the
 * policy's snapshot stream and keeps, per client, the last report and the
 * facts that should outlive the lease: when it last reported, last interacted,
 * last had focus, and which threads it had open when. Clients are mapped to
 * environment users through the auth session that reported them, so the
 * answer is phrased per person, and the durable facts the server already has
 * (auth-session last-seen, the person's last message in the thread) fill the
 * gap right after a restart, when no client has reported yet.
 *
 * The rules that turn these inputs into a state and a recommendation live in
 * `presenceModel.ts`; this file only gathers.
 */
import {
  EnvironmentUserId,
  ThreadId,
  userIdFromSubject,
  type AuthSessionId,
  type BackgroundPolicySnapshot,
  type ClientActivityLease,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as SessionStore from "../auth/SessionStore.ts";
import { BackgroundPolicy } from "../background/BackgroundPolicy.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as EnvironmentUsers from "../persistence/EnvironmentUsers.ts";
import {
  buildPresenceReport,
  type PresenceClientInput,
  type PresencePersonInput,
  type PresenceReport,
  type PresenceRole,
} from "./presenceModel.ts";

/** Distinct clients remembered after their lease expires; the oldest report goes first. */
export const MAX_TRACKED_CLIENTS = 256;
/** Threads remembered per client; the least recently viewed goes first. */
export const MAX_VIEWED_THREADS_PER_CLIENT = 32;
/** Turns read from the thread to find each person's last message. */
const LAST_MESSAGE_TURN_WINDOW = 50;

export class PresenceError extends Schema.TaggedError<PresenceError>()("PresenceError", {
  reason: Schema.Literals(["not-found", "read-failed"]),
  message: Schema.String,
}) {}

export interface TrackedClient {
  readonly authSessionId: AuthSessionId;
  readonly clientId: string;
  readonly clientKind: ClientActivityLease["clientKind"];
  readonly visible: boolean;
  readonly focused: boolean;
  readonly recentlyInteracted: boolean;
  readonly appState: NonNullable<ClientActivityLease["appState"]> | null;
  readonly lowPowerMode: string | null;
  readonly batteryState: string | null;
  readonly networkType: string | null;
  readonly viewingThreadIds: ReadonlyArray<string>;
  readonly lastReportAtMs: number;
  readonly leaseExpiresAtMs: number;
  readonly lastInteractionAtMs: number | null;
  readonly lastFocusedAtMs: number | null;
  /** threadId → newest report that had it in scope. */
  readonly viewedThreads: ReadonlyMap<string, number>;
}

export interface PresenceQuery {
  readonly threadId: ThreadId;
  readonly userId?: string;
  readonly email?: string;
}

export class UserPresenceService extends Context.Service<
  UserPresenceService,
  {
    readonly trackingSinceMs: number;
    readonly report: (query: PresenceQuery) => Effect.Effect<PresenceReport, PresenceError>;
    /** Exposed for tests and diagnostics. */
    readonly trackedClients: Effect.Effect<ReadonlyArray<TrackedClient>>;
  }
>()("t3/presence/UserPresenceService") {}

const trackedKey = (lease: Pick<ClientActivityLease, "sessionId" | "clientId">): string =>
  JSON.stringify([lease.sessionId, lease.clientId]);

const threadScopes = (lease: ClientActivityLease): ReadonlyArray<string> =>
  lease.scopes.flatMap((scope) => (scope.type === "thread" ? [String(scope.threadId)] : []));

/** Folds one lease into the client's record; a report older than the record is ignored. */
export function ingestLease(
  previous: TrackedClient | undefined,
  lease: ClientActivityLease,
): TrackedClient | undefined {
  const reportAtMs = DateTime.toEpochMillis(lease.updatedAt);
  if (previous !== undefined && reportAtMs <= previous.lastReportAtMs) return undefined;
  const viewingThreadIds = threadScopes(lease);
  const viewedThreads = new Map(previous?.viewedThreads ?? []);
  for (const threadId of viewingThreadIds) {
    viewedThreads.delete(threadId);
    viewedThreads.set(threadId, reportAtMs);
  }
  while (viewedThreads.size > MAX_VIEWED_THREADS_PER_CLIENT) {
    let oldest: [string, number] | undefined;
    for (const entry of viewedThreads) {
      if (oldest === undefined || entry[1] < oldest[1]) oldest = entry;
    }
    if (oldest === undefined) break;
    viewedThreads.delete(oldest[0]);
  }
  return {
    authSessionId: lease.sessionId,
    clientId: lease.clientId,
    clientKind: lease.clientKind,
    visible: lease.visible,
    focused: lease.focused,
    recentlyInteracted: lease.recentlyInteracted,
    appState: lease.appState ?? null,
    lowPowerMode: lease.lowPowerMode ?? null,
    batteryState: lease.batteryState ?? null,
    networkType: lease.networkType ?? null,
    viewingThreadIds,
    lastReportAtMs: reportAtMs,
    leaseExpiresAtMs: DateTime.toEpochMillis(lease.expiresAt),
    lastInteractionAtMs: lease.recentlyInteracted
      ? reportAtMs
      : (previous?.lastInteractionAtMs ?? null),
    lastFocusedAtMs:
      lease.focused && lease.visible ? reportAtMs : (previous?.lastFocusedAtMs ?? null),
    viewedThreads,
  };
}

/** Applies a policy snapshot to the tracked set, evicting the stalest clients past the cap. */
export function ingestSnapshot(
  clients: Map<string, TrackedClient>,
  snapshot: Pick<BackgroundPolicySnapshot, "leases">,
): void {
  for (const lease of snapshot.leases) {
    const key = trackedKey(lease);
    const next = ingestLease(clients.get(key), lease);
    if (next !== undefined) clients.set(key, next);
  }
  while (clients.size > MAX_TRACKED_CLIENTS) {
    let oldest: [string, TrackedClient] | undefined;
    for (const entry of clients) {
      if (oldest === undefined || entry[1].lastReportAtMs < oldest[1].lastReportAtMs) {
        oldest = entry;
      }
    }
    if (oldest === undefined) break;
    clients.delete(oldest[0]);
  }
}

const toClientInput = (client: TrackedClient, threadId: string): PresenceClientInput => ({
  clientId: client.clientId,
  clientKind: client.clientKind,
  visible: client.visible,
  focused: client.focused,
  recentlyInteracted: client.recentlyInteracted,
  appState: client.appState,
  lowPowerMode: client.lowPowerMode,
  batteryState: client.batteryState,
  networkType: client.networkType,
  viewingThreadIds: client.viewingThreadIds,
  lastReportAtMs: client.lastReportAtMs,
  leaseExpiresAtMs: client.leaseExpiresAtMs,
  lastInteractionAtMs: client.lastInteractionAtMs,
  lastFocusedAtMs: client.lastFocusedAtMs,
  lastViewedThisSessionAtMs: client.viewedThreads.get(threadId) ?? null,
});

const sessionFacts = (shell: OrchestrationThreadShell | undefined, threadId: ThreadId) => {
  const reasons: Array<string> = [];
  if (shell?.hasPendingApprovals) reasons.push("approval");
  if (shell?.hasPendingUserInput) reasons.push("user-input");
  if (shell?.hasActionableProposedPlan) reasons.push("proposed-plan");
  if (shell?.session?.status === "error") reasons.push("failure");
  const status = shell?.session?.status ?? "absent";
  return {
    sessionId: String(threadId),
    title: shell?.title ?? null,
    status,
    isRunning: status === "running" || status === "starting",
    needsHumanAttention: reasons.length > 0,
    humanAttentionReasons: reasons,
    archived: shell === undefined || shell.archivedAt !== null,
  };
};

export const make = Effect.gen(function* () {
  const backgroundPolicy = yield* BackgroundPolicy;
  const sessions = yield* SessionStore.SessionStore;
  const users = yield* EnvironmentUsers.EnvironmentUserRepository;
  const query = yield* ProjectionSnapshotQuery;
  const trackingSinceMs = yield* Clock.currentTimeMillis;

  const clients = new Map<string, TrackedClient>();
  // Auth session → user id (null = a login with no user identity). Filled from
  // the session store's change stream and refreshed on a miss.
  const identities = new Map<string, string | null>();

  const rememberIdentity = (session: {
    readonly sessionId: AuthSessionId;
    readonly userId: string | null;
    readonly subject: string;
  }) => {
    const userId = session.userId ?? userIdFromSubject(session.subject);
    identities.set(String(session.sessionId), userId === null ? null : String(userId));
  };

  const listAuthSessions = sessions.listActive().pipe(
    Effect.tap((rows) => Effect.sync(() => rows.forEach(rememberIdentity))),
    Effect.catchCause((cause) =>
      Effect.logWarning("presence: auth session read failed", { cause }).pipe(
        Effect.as([] as ReadonlyArray<never>),
      ),
    ),
  );

  yield* listAuthSessions;

  yield* backgroundPolicy.streamChanges.pipe(
    Stream.runForEach((snapshot) => Effect.sync(() => ingestSnapshot(clients, snapshot))),
    Effect.tapCause(Effect.logError),
    Effect.forkScoped,
  );
  yield* sessions.streamChanges.pipe(
    Stream.runForEach((change) =>
      Effect.sync(() => {
        if (change.type === "clientUpserted") rememberIdentity(change.clientSession);
      }),
    ),
    Effect.tapCause(Effect.logError),
    Effect.forkScoped,
  );

  const lookupUser = (userId: string) =>
    users.get(EnvironmentUserId.make(userId)).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catchCause((cause) =>
        Effect.logWarning("presence: user lookup failed", { userId, cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );

  const report: UserPresenceService["Service"]["report"] = Effect.fn("UserPresenceService.report")(
    function* (input) {
      const threadId = input.threadId;
      const caveats: Array<string> = [];

      // Fold the freshest leases in before answering: the stream is asynchronous
      // and a report that raced a heartbeat should still see it.
      yield* backgroundPolicy.snapshot.pipe(
        Effect.map((snapshot) => ingestSnapshot(clients, snapshot)),
        Effect.ignore,
      );

      const shell = yield* query.getThreadShellById(threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(
          (cause) => new PresenceError({ reason: "read-failed", message: String(cause) }),
        ),
      );
      const access =
        shell !== undefined
          ? { ownerUserId: shell.ownerUserId, memberUserIds: shell.memberUserIds }
          : yield* query.getThreadAccessById(threadId).pipe(
              Effect.map(Option.getOrUndefined),
              Effect.mapError(
                (cause) => new PresenceError({ reason: "read-failed", message: String(cause) }),
              ),
            );
      if (access === undefined) {
        return yield* new PresenceError({
          reason: "not-found",
          message: `T3 session ${threadId} was not found.`,
        });
      }

      const lastMessageByUser = new Map<string, number>();
      let lastSenderUserId: string | null = null;
      const detail = yield* query
        .getThreadDetailSnapshot(threadId, { turnLimit: LAST_MESSAGE_TURN_WINDOW })
        .pipe(
          Effect.map(Option.getOrUndefined),
          Effect.catchCause((cause) =>
            Effect.logWarning("presence: thread detail read failed", { threadId, cause }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  caveats.push(
                    "last-message times are unavailable: the thread history failed to load",
                  );
                }),
              ),
              Effect.as(undefined),
            ),
          ),
        );
      if (detail !== undefined) {
        let lastSenderAtMs = -1;
        for (const message of detail.thread.messages) {
          if (message.role !== "user" || message.sentByUserId === null) continue;
          const atMs = Date.parse(message.createdAt);
          if (Number.isNaN(atMs)) continue;
          const userId = String(message.sentByUserId);
          lastMessageByUser.set(userId, Math.max(lastMessageByUser.get(userId) ?? 0, atMs));
          if (atMs >= lastSenderAtMs) {
            lastSenderAtMs = atMs;
            lastSenderUserId = userId;
          }
        }
      }

      const authSessions = yield* listAuthSessions;
      const authByUser = new Map<
        string,
        { lastConnectedAtMs: number | null; connected: boolean }
      >();
      for (const session of authSessions) {
        const userId = identities.get(String(session.sessionId));
        if (userId === null || userId === undefined) continue;
        const current = authByUser.get(userId) ?? { lastConnectedAtMs: null, connected: false };
        const lastConnectedAtMs =
          session.lastConnectedAt === null ? null : DateTime.toEpochMillis(session.lastConnectedAt);
        authByUser.set(userId, {
          lastConnectedAtMs:
            lastConnectedAtMs === null
              ? current.lastConnectedAtMs
              : Math.max(current.lastConnectedAtMs ?? 0, lastConnectedAtMs),
          connected: current.connected || session.connected,
        });
      }

      const nowMs = yield* Clock.currentTimeMillis;
      const clientsByUser = new Map<string | null, Array<TrackedClient>>();
      for (const client of clients.values()) {
        const userId = identities.get(String(client.authSessionId)) ?? null;
        const bucket = clientsByUser.get(userId) ?? [];
        bucket.push(client);
        clientsByUser.set(userId, bucket);
      }

      const roles = new Map<string, Set<PresenceRole>>();
      const addRole = (userId: string, role: PresenceRole) => {
        const set = roles.get(userId) ?? new Set<PresenceRole>();
        set.add(role);
        roles.set(userId, set);
      };
      if (access.ownerUserId !== null) addRole(String(access.ownerUserId), "owner");
      for (const memberId of access.memberUserIds) addRole(String(memberId), "member");
      if (lastSenderUserId !== null) addRole(lastSenderUserId, "last-sender");
      for (const [userId, bucket] of clientsByUser) {
        if (userId === null) continue;
        if (bucket.some((client) => client.viewedThreads.has(String(threadId)))) {
          addRole(userId, "viewer");
        }
      }
      if (access.ownerUserId === null) caveats.push("this session has no owner");

      const people: Array<PresencePersonInput> = [];
      for (const [userId, roleSet] of roles) {
        const user = yield* lookupUser(userId);
        const auth = authByUser.get(userId);
        people.push({
          userId,
          email: user?.primaryEmail ?? null,
          name: user?.displayName ?? null,
          roles: [...roleSet],
          clients: (clientsByUser.get(userId) ?? []).map((client) =>
            toClientInput(client, String(threadId)),
          ),
          authSessionLastConnectedAtMs: auth?.lastConnectedAtMs ?? null,
          authSessionConnected: auth?.connected ?? false,
          directoryLastSeenAtMs: user ? DateTime.toEpochMillis(user.lastSeenAt) : null,
          lastMessageInSessionAtMs: lastMessageByUser.get(userId) ?? null,
        });
      }
      const unidentified = clientsByUser.get(null) ?? [];
      if (
        unidentified.some(
          (client) => client.leaseExpiresAtMs > nowMs || client.viewedThreads.has(String(threadId)),
        )
      ) {
        people.push({
          userId: null,
          email: null,
          name: null,
          roles: unidentified.some((client) => client.viewedThreads.has(String(threadId)))
            ? ["viewer"]
            : [],
          clients: unidentified.map((client) => toClientInput(client, String(threadId))),
          authSessionLastConnectedAtMs: null,
          authSessionConnected: false,
          directoryLastSeenAtMs: null,
          lastMessageInSessionAtMs: null,
        });
      }

      const wantedUserId = input.userId?.trim();
      const wantedEmail = input.email?.trim().toLowerCase();
      const filtered =
        wantedUserId || wantedEmail
          ? people.filter(
              (person) =>
                (wantedUserId !== undefined &&
                  wantedUserId.length > 0 &&
                  person.userId === wantedUserId) ||
                (wantedEmail !== undefined &&
                  wantedEmail.length > 0 &&
                  person.email?.toLowerCase() === wantedEmail),
            )
          : people;
      if (filtered.length === 0 && people.length > 0) {
        caveats.push("no person on this session matches the userId/email filter");
      }

      return buildPresenceReport({
        nowMs,
        trackingSinceMs,
        session: sessionFacts(shell, threadId),
        people: filtered,
        caveats,
      });
    },
  );

  return UserPresenceService.of({
    trackingSinceMs,
    report,
    trackedClients: Effect.sync(() => [...clients.values()]),
  });
});

export const layer = Layer.effect(UserPresenceService, make);
