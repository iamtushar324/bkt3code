import {
  AuthSessionId,
  EnvironmentUser,
  type EnvironmentUserDirectoryResult,
  type EnvironmentUserId,
  type EnvironmentUserIdInput,
  EnvironmentUserManagementError,
  type EnvironmentUserSourceControlProfileSetInput,
  type EnvironmentUserUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as EnvironmentUsers from "../persistence/EnvironmentUsers.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { VerifiedClerkIdentity } from "./ClerkIdentityVerifier.ts";
import * as SessionStore from "./SessionStore.ts";

type AdmittedEnvironmentUser = EnvironmentUsers.EnvironmentUserRecord;

const userError = (
  operation: string,
  reason: ConstructorParameters<typeof EnvironmentUserManagementError>[0]["reason"],
  detail: string,
  userId?: EnvironmentUserId,
) =>
  new EnvironmentUserManagementError({
    operation,
    reason,
    detail,
    ...(userId ? { userId } : {}),
  });

const persistenceError = (operation: string, userId?: EnvironmentUserId) =>
  userError(operation, "persistence-failed", "The user directory could not be updated.", userId);

export class EnvironmentUserService extends Context.Service<
  EnvironmentUserService,
  {
    readonly assertAllowed: (
      userId: EnvironmentUserId,
    ) => Effect.Effect<void, EnvironmentUserManagementError>;
    readonly admit: (
      identity: VerifiedClerkIdentity,
      input: { readonly administrativeGrant: boolean },
    ) => Effect.Effect<AdmittedEnvironmentUser, EnvironmentUserManagementError>;
    readonly assertAdministrator: (
      currentSessionId: AuthSessionId,
    ) => Effect.Effect<void, EnvironmentUserManagementError>;
    readonly list: (
      currentSessionId: AuthSessionId,
    ) => Effect.Effect<EnvironmentUserDirectoryResult, EnvironmentUserManagementError>;
    readonly update: (
      input: EnvironmentUserUpdateInput,
    ) => Effect.Effect<EnvironmentUser, EnvironmentUserManagementError>;
    readonly revokeSessions: (
      input: EnvironmentUserIdInput,
    ) => Effect.Effect<EnvironmentUser, EnvironmentUserManagementError>;
    readonly setSourceControlProfile: (
      input: EnvironmentUserSourceControlProfileSetInput,
    ) => Effect.Effect<EnvironmentUser, EnvironmentUserManagementError>;
    readonly revokeUnidentifiedSessions: Effect.Effect<number, EnvironmentUserManagementError>;
  }
>()("t3/auth/EnvironmentUserService") {}

export const make = Effect.gen(function* () {
  const repository = yield* EnvironmentUsers.EnvironmentUserRepository;
  const sessions = yield* SessionStore.SessionStore;
  const settings = yield* ServerSettings.ServerSettingsService;

  const requireRecord = Effect.fn("EnvironmentUserService.requireRecord")(function* (
    userId: EnvironmentUserId,
  ) {
    const existing = yield* repository
      .get(userId)
      .pipe(Effect.mapError(() => persistenceError("read-user", userId)));
    return yield* Option.match(existing, {
      onNone: () =>
        Effect.fail(userError("read-user", "user-not-found", "The user was not found.", userId)),
      onSome: Effect.succeed,
    });
  });

  const assertAllowed: EnvironmentUserService["Service"]["assertAllowed"] = Effect.fn(
    "EnvironmentUserService.assertAllowed",
  )(function* (userId) {
    const existing = yield* repository
      .get(userId)
      .pipe(Effect.mapError(() => persistenceError("check-user", userId)));
    if (Option.isSome(existing) && existing.value.status === "blocked") {
      return yield* userError(
        "check-user",
        "identity-blocked",
        "This user is blocked from the environment.",
        userId,
      );
    }
  });

  const admit: EnvironmentUserService["Service"]["admit"] = Effect.fn(
    "EnvironmentUserService.admit",
  )(function* (identity, input) {
    const existing = yield* repository
      .get(identity.userId)
      .pipe(Effect.mapError(() => persistenceError("admit-user", identity.userId)));
    if (Option.isSome(existing) && existing.value.status === "blocked") {
      return yield* userError(
        "admit-user",
        "identity-blocked",
        "This user is blocked from the environment.",
        identity.userId,
      );
    }
    const now = yield* DateTime.now;
    const role = Option.isSome(existing)
      ? existing.value.role
      : input.administrativeGrant &&
          !(yield* repository.list.pipe(
            Effect.map((records) =>
              records.some((record) => record.role === "admin" && record.status === "active"),
            ),
            Effect.mapError(() => persistenceError("admit-user", identity.userId)),
          ))
        ? "admin"
        : "member";
    yield* repository
      .upsert({
        userId: identity.userId,
        displayName: identity.displayName,
        primaryEmail: identity.primaryEmail,
        avatarUrl: identity.avatarUrl,
        role,
        status: Option.isSome(existing) ? existing.value.status : "active",
        firstSeenAt: Option.isSome(existing) ? existing.value.firstSeenAt : now,
        lastSeenAt: now,
      })
      .pipe(Effect.mapError(() => persistenceError("admit-user", identity.userId)));
    if (Option.isSome(existing) && role !== existing.value.role) {
      yield* repository
        .update({ userId: identity.userId, role })
        .pipe(Effect.mapError(() => persistenceError("admit-user", identity.userId)));
    }
    return yield* requireRecord(identity.userId);
  });

  const assertAdministrator: EnvironmentUserService["Service"]["assertAdministrator"] = Effect.fn(
    "EnvironmentUserService.assertAdministrator",
  )(function* (currentSessionId) {
    const activeSessions = yield* sessions
      .listActive()
      .pipe(Effect.mapError(() => persistenceError("authorize-user")));
    const session = activeSessions.find((entry) => entry.sessionId === currentSessionId);
    if (!session?.userId) {
      return yield* userError(
        "authorize-user",
        "identity-required",
        "Sign in with Clerk before managing environment users.",
      );
    }
    const user = yield* requireRecord(session.userId);
    if (user.status !== "active" || user.role !== "admin") {
      return yield* userError(
        "authorize-user",
        "not-authorized",
        "Only an active environment administrator can manage users.",
        session.userId,
      );
    }
  });

  const list: EnvironmentUserService["Service"]["list"] = Effect.fn("EnvironmentUserService.list")(
    function* (currentSessionId) {
      const [records, activeSessions, currentSettings] = yield* Effect.all(
        [repository.list, sessions.listActive(), settings.getSettings],
        { concurrency: 3 },
      ).pipe(Effect.mapError(() => persistenceError("list-users")));
      const profileByUserId = new Map(
        Object.values(currentSettings.sourceControlProfiles)
          .filter((profile) => profile.ownerUserId !== null)
          .map((profile) => [profile.ownerUserId!, profile.id] as const),
      );
      const directoryUsers = records.map((record) => {
        const userSessions = activeSessions.filter((session) => session.userId === record.userId);
        const connectedSessionCount = userSessions.filter((session) => session.connected).length;
        return EnvironmentUser.make({
          id: record.userId,
          identity: { provider: "clerk", subject: record.userId },
          displayName: record.displayName,
          primaryEmail: record.primaryEmail,
          avatarUrl: record.avatarUrl,
          role: record.role,
          status: record.status,
          sourceControlProfileId: profileByUserId.get(record.userId) ?? null,
          presence: connectedSessionCount > 0 ? "online" : "offline",
          connectedSessionCount,
          sessionCount: userSessions.length,
          current: userSessions.some((session) => session.sessionId === currentSessionId),
          firstSeenAt: record.firstSeenAt,
          lastSeenAt: record.lastSeenAt,
        });
      });
      return {
        identityMode: currentSettings.environmentUserIdentityMode,
        users: directoryUsers,
        unidentifiedSessionCount: activeSessions.filter((session) => session.userId === null)
          .length,
      } satisfies EnvironmentUserDirectoryResult;
    },
  );

  const readDirectoryUser = Effect.fn("EnvironmentUserService.readDirectoryUser")(function* (
    userId: EnvironmentUserId,
  ) {
    const active = yield* sessions
      .listActive()
      .pipe(Effect.mapError(() => persistenceError("read-user", userId)));
    const current = active.find((session) => session.userId === userId)?.sessionId;
    const directory = yield* list(current ?? AuthSessionId.make("no-current-session"));
    const user = directory.users.find((entry) => entry.id === userId);
    return yield* user
      ? Effect.succeed(user)
      : Effect.fail(userError("read-user", "user-not-found", "The user was not found.", userId));
  });

  const update: EnvironmentUserService["Service"]["update"] = Effect.fn(
    "EnvironmentUserService.update",
  )(function* (input) {
    const existing = yield* requireRecord(input.userId);
    const removesAdmin =
      existing.role === "admin" &&
      existing.status === "active" &&
      (input.role === "member" || input.status === "blocked");
    if (removesAdmin) {
      const records = yield* repository.list.pipe(
        Effect.mapError(() => persistenceError("update-user", input.userId)),
      );
      const otherAdmins = records.filter(
        (record) =>
          record.userId !== input.userId && record.role === "admin" && record.status === "active",
      );
      if (otherAdmins.length === 0) {
        return yield* userError(
          "update-user",
          "last-admin",
          "The final active administrator cannot be demoted or blocked.",
          input.userId,
        );
      }
    }
    const updated = yield* repository
      .update(input)
      .pipe(Effect.mapError(() => persistenceError("update-user", input.userId)));
    if (!updated) {
      return yield* userError(
        "update-user",
        "user-not-found",
        "The user was not found.",
        input.userId,
      );
    }
    if (input.status === "blocked") {
      yield* sessions
        .revokeByUserId(input.userId)
        .pipe(
          Effect.mapError(() =>
            userError(
              "update-user",
              "session-revocation-failed",
              "The user was blocked, but active sessions could not be revoked.",
              input.userId,
            ),
          ),
        );
    }
    return yield* readDirectoryUser(input.userId);
  });

  const revokeSessions: EnvironmentUserService["Service"]["revokeSessions"] = Effect.fn(
    "EnvironmentUserService.revokeSessions",
  )(function* (input) {
    yield* requireRecord(input.userId);
    yield* sessions
      .revokeByUserId(input.userId)
      .pipe(
        Effect.mapError(() =>
          userError(
            "revoke-sessions",
            "session-revocation-failed",
            "The user's sessions could not be revoked.",
            input.userId,
          ),
        ),
      );
    return yield* readDirectoryUser(input.userId);
  });

  const setSourceControlProfile: EnvironmentUserService["Service"]["setSourceControlProfile"] =
    Effect.fn("EnvironmentUserService.setSourceControlProfile")(function* (input) {
      yield* requireRecord(input.userId);
      const currentSettings = yield* settings.getSettings.pipe(
        Effect.mapError(() => persistenceError("assign-source-control-profile", input.userId)),
      );
      const profiles = currentSettings.sourceControlProfiles;
      if (input.sourceControlProfileId !== null) {
        const target = profiles[input.sourceControlProfileId];
        if (!target || target.archived) {
          return yield* userError(
            "assign-source-control-profile",
            "profile-not-found",
            "The selected GitHub profile is unavailable.",
            input.userId,
          );
        }
        if (target.ownerUserId !== null && target.ownerUserId !== input.userId) {
          return yield* userError(
            "assign-source-control-profile",
            "profile-already-assigned",
            "The selected GitHub profile already belongs to another user.",
            input.userId,
          );
        }
      }
      const nextProfiles = Object.fromEntries(
        Object.entries(profiles).map(([profileId, profile]) => [
          profileId,
          {
            ...profile,
            ownerUserId:
              profile.id === input.sourceControlProfileId
                ? input.userId
                : profile.ownerUserId === input.userId
                  ? null
                  : profile.ownerUserId,
          },
        ]),
      );
      yield* settings
        .updateSettings({ sourceControlProfiles: nextProfiles })
        .pipe(
          Effect.mapError(() => persistenceError("assign-source-control-profile", input.userId)),
        );
      return yield* readDirectoryUser(input.userId);
    });

  const revokeUnidentifiedSessions: EnvironmentUserService["Service"]["revokeUnidentifiedSessions"] =
    sessions.listActive().pipe(
      Effect.flatMap((activeSessions) =>
        Effect.forEach(
          activeSessions.filter((session) => session.userId === null),
          (session) => sessions.revoke(session.sessionId),
          { concurrency: 4 },
        ),
      ),
      Effect.map((results) => results.filter(Boolean).length),
      Effect.mapError(() =>
        userError(
          "enforce-identity",
          "session-revocation-failed",
          "Legacy unidentified sessions could not be revoked.",
        ),
      ),
      Effect.withSpan("EnvironmentUserService.revokeUnidentifiedSessions"),
    );

  return EnvironmentUserService.of({
    assertAllowed,
    assertAdministrator,
    admit,
    list,
    update,
    revokeSessions,
    setSourceControlProfile,
    revokeUnidentifiedSessions,
  });
});

export const layer = Layer.effect(EnvironmentUserService, make).pipe(
  Layer.provideMerge(EnvironmentUsers.layer),
);
