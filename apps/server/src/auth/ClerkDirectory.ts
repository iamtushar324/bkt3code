/**
 * ClerkDirectory - Clerk identity + org-membership service for team mode.
 *
 * Wraps `@clerk/backend` behind an Effect service so the rest of the server can
 * verify Clerk session tokens, hard-gate on org membership, list org members
 * (TTL-cached, backing the users endpoint), and resolve a user id by email
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

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
  /** List org members (TTL-cached ~2 min; stale cache served on Clerk outage). */
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

const makeEnabledDirectory = (
  config: NonNullable<ServerConfig["Service"]["clerkAuth"]>,
): Effect.Effect<ClerkDirectoryShape> =>
  Effect.gen(function* () {
    const client: ClerkClient = createClerkClient({ secretKey: config.secretKey });
    const organizationId = config.organizationId ?? null;
    const descriptor: ServerAuthClerkDescriptor | null =
      config.publishableKey !== undefined
        ? { publishableKey: config.publishableKey, organizationId }
        : null;

    const cacheRef = yield* Ref.make<OrgMemberCache | null>(null);

    const fetchOrgMembers = (): Effect.Effect<
      ReadonlyArray<OrchestrationUser>,
      ClerkDirectoryError
    > =>
      organizationId === null
        ? Effect.succeed([])
        : Effect.tryPromise({
            try: async () => {
              const users: OrchestrationUser[] = [];
              let offset = 0;
              // Page through the org's memberships. A 4-person org is one page,
              // but paginate defensively.
              for (;;) {
                const page = await client.organizations.getOrganizationMembershipList({
                  organizationId,
                  limit: ORG_MEMBER_PAGE_SIZE,
                  offset,
                });
                for (const membership of page.data) {
                  const publicUserData = membership.publicUserData;
                  if (!publicUserData) continue;
                  users.push({
                    id: publicUserData.userId as UserId,
                    name: memberDisplayName(publicUserData.firstName, publicUserData.lastName),
                    email: nonEmpty(publicUserData.identifier),
                    imageUrl: nonEmpty(publicUserData.imageUrl),
                    isAdmin: isAdminRole(membership.role),
                  });
                }
                offset += ORG_MEMBER_PAGE_SIZE;
                if (page.data.length < ORG_MEMBER_PAGE_SIZE || offset >= page.totalCount) {
                  break;
                }
              }
              return users;
            },
            catch: (cause) =>
              new ClerkDirectoryError({ message: "Failed to list Clerk org members.", cause }),
          });

    const verifySessionToken: ClerkDirectoryShape["verifySessionToken"] = (token) =>
      Effect.gen(function* () {
        const payload = yield* Effect.tryPromise({
          try: () => verifyToken(token, { secretKey: config.secretKey }),
          catch: (cause) =>
            new ClerkAuthError({
              reason: "invalid_token",
              message: `Clerk token verification failed: ${String(cause)}`,
            }),
        });
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
          // present; otherwise confirm via the Backend API.
          const claimedOrgId =
            typeof (payload as { org_id?: unknown }).org_id === "string"
              ? (payload as { org_id: string }).org_id
              : null;
          const isMember =
            claimedOrgId === organizationId
              ? true
              : yield* Effect.tryPromise({
                  try: async () => {
                    const memberships = await client.users.getOrganizationMembershipList({
                      userId,
                    });
                    return memberships.data.some(
                      (membership) => membership.organization.id === organizationId,
                    );
                  },
                  catch: (cause) =>
                    new ClerkAuthError({
                      reason: "invalid_token",
                      message: `Failed to verify Clerk org membership: ${String(cause)}`,
                    }),
                });
          if (!isMember) {
            return yield* new ClerkAuthError({
              reason: "not_org_member",
              message: "This account is not a member of the workspace organization.",
            });
          }
        }

        return { userId, subject: clerkSubjectForUser(userId) } satisfies VerifiedClerkSession;
      });

    const listOrgMembers: ClerkDirectoryShape["listOrgMembers"] = () =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const cached = yield* Ref.get(cacheRef);
        if (cached !== null && nowMs - cached.fetchedAtMs < ORG_MEMBER_CACHE_TTL_MS) {
          return cached.users;
        }
        return yield* fetchOrgMembers().pipe(
          Effect.tap((users) => Ref.set(cacheRef, { users, fetchedAtMs: nowMs })),
          // On a Clerk outage serve the stale cache rather than failing the
          // users endpoint; only propagate the error when we have nothing.
          Effect.catch((error) =>
            cached !== null ? Effect.succeed(cached.users) : Effect.fail(error),
          ),
        );
      });

    const isOrgAdmin: ClerkDirectoryShape["isOrgAdmin"] = (userId) =>
      listOrgMembers().pipe(
        Effect.map((users) => users.find((user) => user.id === userId)?.isAdmin ?? false),
        // Fail-closed: never grant admin on a Clerk directory error.
        Effect.orElseSucceed(() => false),
      );

    const findUserIdByEmail: ClerkDirectoryShape["findUserIdByEmail"] = (email) =>
      Effect.tryPromise({
        try: async () => {
          const page = await client.users.getUserList({ emailAddress: [email], limit: 1 });
          const user = page.data[0];
          return user ? (user.id as UserId) : null;
        },
        catch: (cause) =>
          new ClerkDirectoryError({
            message: `Failed to resolve Clerk user by email '${email}'.`,
            cause,
          }),
      });

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
