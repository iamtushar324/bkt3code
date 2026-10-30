/**
 * ClerkDirectory - Clerk identity + org-membership service for team mode.
 *
 * Wraps `@clerk/backend` behind an Effect service so the rest of the server can
 * verify Clerk session tokens, hard-gate on org membership, list org members
 * (stale-while-revalidate cache, backing the users endpoint), and resolve a user id by email
 * (backfill). When `ServerConfig.clerkAuth` is undefined the service is built in
 * a "disabled" variant: `enabled === false`, `verifySessionToken` fails, and the
 * directory queries return empty — single-user mode never touches Clerk.
 *
 * @module ClerkDirectory
 */
import {
  clerkSubjectForUser,
  UserId,
  type OrchestrationUser,
  type ServerAuthClerkDescriptor,
} from "@t3tools/contracts";
import { createClerkClient, verifyToken, type ClerkClient } from "@clerk/backend";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";

const ORG_MEMBER_CACHE_TTL_MS = 2 * 60 * 1000;
const ORG_MEMBER_PAGE_SIZE = 100;

/** Failure verifying a Clerk token or gating on org membership. */
export class ClerkAuthError extends Schema.TaggedError<ClerkAuthError>()("ClerkAuthError", {
  reason: Schema.Literals(["disabled", "invalid_token", "not_org_member"]),
  message: Schema.String,
}) {}

/** Failure calling the Clerk directory (list members / resolve email). */
export class ClerkDirectoryError extends Schema.TaggedError<ClerkDirectoryError>()(
  "ClerkDirectoryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface VerifiedClerkSession {
  readonly userId: UserId;
  /** Convenience: `subject` string to persist on the session ("clerk:<userId>"). */
  readonly subject: string;
}

export interface ClerkDirectoryShape {
  /** True in team mode (a Clerk secret is configured). */
  readonly enabled: boolean;
  /** Runtime descriptor advertised to the SPA, or null in single-user mode. */
  readonly descriptor: ServerAuthClerkDescriptor | null;
  /**
   * Verify a Clerk session token AND hard-gate on org membership (when an org
   * is configured). Returns the operator identity to bind to the session.
   */
  readonly verifySessionToken: (
    token: string,
  ) => Effect.Effect<VerifiedClerkSession, ClerkAuthError>;
  /**
   * List org members. Served from a cache; a list older than ~2 min is
   * returned at once and refreshed in the background. On a Clerk outage the
   * last good list keeps being served. Only the first load waits on Clerk.
   */
  readonly listOrgMembers: () => Effect.Effect<
    ReadonlyArray<OrchestrationUser>,
    ClerkDirectoryError
  >;
  /**
   * Whether the user is a Clerk organization admin (manages project access).
   * Derived from the cached member list; false in single-user mode or on error.
   */
  readonly isOrgAdmin: (userId: UserId) => Effect.Effect<boolean, never>;
  /** Resolve a user id by email (backfill). Returns null when not found. */
  readonly findUserIdByEmail: (email: string) => Effect.Effect<UserId | null, ClerkDirectoryError>;
}

export class ClerkDirectory extends Context.Service<ClerkDirectory, ClerkDirectoryShape>()(
  "t3/auth/ClerkDirectory",
) {}

interface OrgMemberCache {
  readonly users: ReadonlyArray<OrchestrationUser>;
  readonly fetchedAtMs: number;
}

interface OrgMemberLoadFailure {
  readonly atMs: number;
  readonly error: ClerkDirectoryError;
}

const memberDisplayName = (firstName: string | null, lastName: string | null): string | null => {
  const name = [firstName, lastName].filter((part) => part && part.trim().length > 0).join(" ");
  return name.length > 0 ? name : null;
};

const nonEmpty = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

/** Clerk admin role — matches the modern `org:admin` and legacy `admin`. */
const isAdminRole = (role: string | null | undefined): boolean =>
  role === "org:admin" || role === "admin";

const makeDisabledDirectory: ClerkDirectoryShape = {
  enabled: false,
  descriptor: null,
  verifySessionToken: () =>
    Effect.fail(
      new ClerkAuthError({ reason: "disabled", message: "Clerk auth is not configured." }),
    ),
  listOrgMembers: () => Effect.succeed([]),
  isOrgAdmin: () => Effect.succeed(false),
  findUserIdByEmail: () => Effect.succeed(null),
};

/**
 * The Clerk calls the directory makes, behind plain shapes so tests can stand in
 * for the Backend API. `clerkBackendFromClient` is the production adapter.
 */
export interface ClerkDirectoryBackend {
  readonly verifyToken: (token: string) => Promise<{
    readonly sub?: unknown;
    readonly org_id?: unknown;
  }>;
  readonly listOrgMembersPage: (input: {
    readonly organizationId: string;
    readonly limit: number;
    readonly offset: number;
  }) => Promise<{
    readonly members: ReadonlyArray<OrchestrationUser>;
    readonly pageLength: number;
    readonly totalCount: number;
  }>;
  readonly listUserOrganizationIds: (userId: string) => Promise<ReadonlyArray<string>>;
  readonly findUserIdByEmail: (email: string) => Promise<string | null>;
}

export const clerkBackendFromClient = (
  client: ClerkClient,
  secretKey: string,
): ClerkDirectoryBackend => ({
  verifyToken: async (token) => {
    const payload = await verifyToken(token, { secretKey });
    return { sub: payload.sub, org_id: (payload as { org_id?: unknown }).org_id };
  },
  listOrgMembersPage: async ({ organizationId, limit, offset }) => {
    const page = await client.organizations.getOrganizationMembershipList({
      organizationId,
      limit,
      offset,
    });
    const members: OrchestrationUser[] = [];
    for (const membership of page.data) {
      const publicUserData = membership.publicUserData;
      if (!publicUserData) continue;
      members.push({
        id: publicUserData.userId as UserId,
        name: memberDisplayName(publicUserData.firstName, publicUserData.lastName),
        email: nonEmpty(publicUserData.identifier),
        imageUrl: nonEmpty(publicUserData.imageUrl),
        isAdmin: isAdminRole(membership.role),
      });
    }
    return { members, pageLength: page.data.length, totalCount: page.totalCount };
  },
  listUserOrganizationIds: async (userId) => {
    const memberships = await client.users.getOrganizationMembershipList({ userId });
    return memberships.data.map((membership) => membership.organization.id);
  },
  findUserIdByEmail: async (email) => {
    const page = await client.users.getUserList({ emailAddress: [email], limit: 1 });
    return page.data[0]?.id ?? null;
  },
});

/** Every Clerk call gives up after this long, so a slow Clerk never holds a request. */
export const CLERK_REQUEST_TIMEOUT = Duration.seconds(5);
/** A sign-in membership confirmed by the Backend API is trusted this long. */
export const CLERK_MEMBERSHIP_CACHE_TTL_MS = 5 * 60 * 1000;
/** After a failed background refresh, wait this long before asking Clerk again. */
const ORG_MEMBER_REFRESH_RETRY_MS = 30 * 1000;
const MEMBERSHIP_CACHE_MAX_ENTRIES = 1_000;

const callClerk = <A, E>(
  label: string,
  run: () => Promise<A>,
  onError: (cause: unknown) => E,
): Effect.Effect<A, E> =>
  Effect.tryPromise({ try: run, catch: onError }).pipe(
    Effect.timeoutOrElse({
      duration: CLERK_REQUEST_TIMEOUT,
      orElse: () =>
        Effect.fail(
          onError(
            new Error(
              `Clerk ${label} timed out after ${Duration.toSeconds(CLERK_REQUEST_TIMEOUT)} s.`,
            ),
          ),
        ),
    }),
  );

/**
 * Builds the team-mode directory. The member list is stale-while-revalidate:
 * once a list exists, callers get it at once and a stale list refreshes in a
 * background fiber, so a WebSocket connect never waits on Clerk. Only the very
 * first load (no list yet) waits, and concurrent first loads share one call.
 */
export const makeEnabledDirectory = Effect.fn("ClerkDirectory.makeEnabledDirectory")(function* (
  config: NonNullable<ServerConfig["Service"]["clerkAuth"]>,
  backend: ClerkDirectoryBackend = clerkBackendFromClient(
    createClerkClient({ secretKey: config.secretKey }),
    config.secretKey,
  ),
): Effect.fn.Return<ClerkDirectoryShape, never, Scope.Scope> {
  const organizationId = config.organizationId ?? null;
  const descriptor: ServerAuthClerkDescriptor | null =
    config.publishableKey !== undefined
      ? { publishableKey: config.publishableKey, organizationId }
      : null;

  const scope = yield* Effect.scope;
  const cacheRef = yield* Ref.make<OrgMemberCache | null>(null);
  const lastFailureRef = yield* Ref.make<OrgMemberLoadFailure | null>(null);
  const refreshingRef = yield* Ref.make(false);
  const refreshLock = yield* Semaphore.make(1);
  // userId -> when the Backend API last confirmed org membership. Only positive
  // answers are kept, so a newly invited member is never locked out by a cache.
  const confirmedMemberships = new Map<UserId, number>();

  const fetchOrgMembers = (): Effect.Effect<
    ReadonlyArray<OrchestrationUser>,
    ClerkDirectoryError
  > =>
    organizationId === null
      ? Effect.succeed([])
      : callClerk(
          "org member list",
          async () => {
            const users: OrchestrationUser[] = [];
            let offset = 0;
            // Page through the org's memberships. A 4-person org is one page,
            // but paginate defensively.
            for (;;) {
              const page = await backend.listOrgMembersPage({
                organizationId,
                limit: ORG_MEMBER_PAGE_SIZE,
                offset,
              });
              users.push(...page.members);
              offset += ORG_MEMBER_PAGE_SIZE;
              if (page.pageLength < ORG_MEMBER_PAGE_SIZE || offset >= page.totalCount) {
                break;
              }
            }
            return users;
          },
          (cause) =>
            new ClerkDirectoryError({ message: "Failed to list Clerk org members.", cause }),
        );

  // One Clerk call at a time. A caller that waited behind another load takes
  // that load's result (or a failure that ended after it asked) instead of
  // calling Clerk again.
  const loadOrgMembers = (requestedAtMs: number) =>
    refreshLock.withPermit(
      Effect.gen(function* () {
        const startedAtMs = yield* Clock.currentTimeMillis;
        const cached = yield* Ref.get(cacheRef);
        if (cached !== null && startedAtMs - cached.fetchedAtMs < ORG_MEMBER_CACHE_TTL_MS) {
          return cached.users;
        }
        const failure = yield* Ref.get(lastFailureRef);
        if (failure !== null && failure.atMs >= requestedAtMs) {
          return yield* Effect.fail(failure.error);
        }
        return yield* fetchOrgMembers().pipe(
          Effect.tap((users) =>
            Effect.andThen(
              Ref.set(cacheRef, { users, fetchedAtMs: startedAtMs }),
              Ref.set(lastFailureRef, null),
            ),
          ),
          Effect.tapError((error) =>
            Effect.flatMap(Clock.currentTimeMillis, (atMs) =>
              Ref.set(lastFailureRef, { atMs, error }),
            ),
          ),
        );
      }),
    );

  const refreshInBackground = (requestedAtMs: number) =>
    Ref.modify(refreshingRef, (refreshing) => [!refreshing, true] as const).pipe(
      Effect.flatMap((start) =>
        start
          ? loadOrgMembers(requestedAtMs).pipe(
              Effect.asVoid,
              // Keep serving the last good list (today's outage behaviour).
              Effect.catch((error) =>
                Effect.logWarning("Clerk org member refresh failed; serving the cached list.", {
                  error,
                }),
              ),
              Effect.ensuring(Ref.set(refreshingRef, false)),
              Effect.forkIn(scope),
              Effect.asVoid,
            )
          : Effect.void,
      ),
    );

  const verifySessionToken: ClerkDirectoryShape["verifySessionToken"] = Effect.fn(
    "ClerkDirectory.verifySessionToken",
  )(function* (token) {
    const payload = yield* callClerk(
      "token verification",
      () => backend.verifyToken(token),
      (cause) =>
        new ClerkAuthError({
          reason: "invalid_token",
          message: `Clerk token verification failed: ${String(cause)}`,
        }),
    );
    const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
    if (subject.length === 0) {
      return yield* new ClerkAuthError({
        reason: "invalid_token",
        message: "Clerk token is missing a subject.",
      });
    }
    const userId = subject as UserId;

    if (organizationId !== null) {
      // Hard-gate on org membership. Prefer the token's org claim when
      // present; otherwise confirm via the Backend API (cached per user).
      const claimedOrgId = typeof payload.org_id === "string" ? payload.org_id : null;
      const nowMs = yield* Clock.currentTimeMillis;
      const confirmedAtMs = confirmedMemberships.get(userId);
      const isMember =
        claimedOrgId === organizationId ||
        (confirmedAtMs !== undefined && nowMs - confirmedAtMs < CLERK_MEMBERSHIP_CACHE_TTL_MS)
          ? true
          : yield* callClerk(
              "org membership check",
              () => backend.listUserOrganizationIds(userId),
              (cause) =>
                new ClerkAuthError({
                  reason: "invalid_token",
                  message: `Failed to verify Clerk org membership: ${String(cause)}`,
                }),
            ).pipe(Effect.map((organizationIds) => organizationIds.includes(organizationId)));
      if (!isMember) {
        confirmedMemberships.delete(userId);
        return yield* new ClerkAuthError({
          reason: "not_org_member",
          message: "This account is not a member of the workspace organization.",
        });
      }
      if (confirmedAtMs === undefined || nowMs - confirmedAtMs >= CLERK_MEMBERSHIP_CACHE_TTL_MS) {
        confirmedMemberships.delete(userId);
        if (confirmedMemberships.size >= MEMBERSHIP_CACHE_MAX_ENTRIES) {
          const oldest = confirmedMemberships.keys().next();
          if (!oldest.done) confirmedMemberships.delete(oldest.value);
        }
        confirmedMemberships.set(userId, nowMs);
      }
    }

    return { userId, subject: clerkSubjectForUser(userId) } satisfies VerifiedClerkSession;
  });

  const listOrgMembers: ClerkDirectoryShape["listOrgMembers"] = Effect.fn(
    "ClerkDirectory.listOrgMembers",
  )(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(cacheRef);
    if (cached === null) {
      // Nothing to serve yet: wait for the (shared) first load.
      return yield* loadOrgMembers(nowMs);
    }
    if (nowMs - cached.fetchedAtMs >= ORG_MEMBER_CACHE_TTL_MS) {
      const failure = yield* Ref.get(lastFailureRef);
      if (failure === null || nowMs - failure.atMs >= ORG_MEMBER_REFRESH_RETRY_MS) {
        yield* refreshInBackground(nowMs);
      }
    }
    return cached.users;
  });

  const isOrgAdmin: ClerkDirectoryShape["isOrgAdmin"] = (userId) =>
    listOrgMembers().pipe(
      Effect.map((users) => users.find((user) => user.id === userId)?.isAdmin ?? false),
      // Fail-closed: never grant admin on a Clerk directory error.
      Effect.orElseSucceed(() => false),
    );

  const findUserIdByEmail: ClerkDirectoryShape["findUserIdByEmail"] = (email) =>
    callClerk(
      "user lookup by email",
      () => backend.findUserIdByEmail(email),
      (cause) =>
        new ClerkDirectoryError({
          message: `Failed to resolve Clerk user by email '${email}'.`,
          cause,
        }),
    ).pipe(Effect.map((userId) => (userId === null ? null : (userId as UserId))));

  // Warm the member list so the first WebSocket connect after a restart does
  // not wait on Clerk.
  yield* refreshInBackground(yield* Clock.currentTimeMillis);

  return {
    enabled: true,
    descriptor,
    verifySessionToken,
    listOrgMembers,
    isOrgAdmin,
    findUserIdByEmail,
  } satisfies ClerkDirectoryShape;
});

export const ClerkDirectoryLive = Layer.effect(
  ClerkDirectory,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (config.clerkAuth === undefined) {
      return makeDisabledDirectory;
    }
    return yield* makeEnabledDirectory(config.clerkAuth);
  }),
);
