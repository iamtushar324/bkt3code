import * as Schema from "effect/Schema";

import { EnvironmentUserId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SourceControlProfileId } from "./sourceControlProfiles.ts";

export const EnvironmentUserIdentityMode = Schema.Literals(["optional", "required"]);
export type EnvironmentUserIdentityMode = typeof EnvironmentUserIdentityMode.Type;

export const EnvironmentUserRole = Schema.Literals(["admin", "member"]);
export type EnvironmentUserRole = typeof EnvironmentUserRole.Type;

export const EnvironmentUserStatus = Schema.Literals(["active", "blocked"]);
export type EnvironmentUserStatus = typeof EnvironmentUserStatus.Type;

export const EnvironmentUserPresence = Schema.Literals(["online", "offline"]);
export type EnvironmentUserPresence = typeof EnvironmentUserPresence.Type;

export const EnvironmentUserIdentity = Schema.Struct({
  provider: Schema.Literal("clerk"),
  subject: EnvironmentUserId,
});
export type EnvironmentUserIdentity = typeof EnvironmentUserIdentity.Type;

export const EnvironmentUser = Schema.Struct({
  id: EnvironmentUserId,
  identity: EnvironmentUserIdentity,
  displayName: Schema.NullOr(TrimmedNonEmptyString),
  primaryEmail: Schema.NullOr(TrimmedNonEmptyString),
  avatarUrl: Schema.NullOr(Schema.String),
  role: EnvironmentUserRole,
  status: EnvironmentUserStatus,
  sourceControlProfileId: Schema.NullOr(SourceControlProfileId),
  presence: EnvironmentUserPresence,
  connectedSessionCount: NonNegativeInt,
  sessionCount: NonNegativeInt,
  current: Schema.Boolean,
  firstSeenAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.DateTimeUtc,
});
export type EnvironmentUser = typeof EnvironmentUser.Type;

export const EnvironmentUserDirectoryResult = Schema.Struct({
  identityMode: EnvironmentUserIdentityMode,
  users: Schema.Array(EnvironmentUser),
  unidentifiedSessionCount: NonNegativeInt,
});
export type EnvironmentUserDirectoryResult = typeof EnvironmentUserDirectoryResult.Type;

export const EnvironmentUserUpdateInput = Schema.Struct({
  userId: EnvironmentUserId,
  role: Schema.optional(EnvironmentUserRole),
  status: Schema.optional(EnvironmentUserStatus),
});
export type EnvironmentUserUpdateInput = typeof EnvironmentUserUpdateInput.Type;

export const EnvironmentUserIdInput = Schema.Struct({
  userId: EnvironmentUserId,
});
export type EnvironmentUserIdInput = typeof EnvironmentUserIdInput.Type;

export const EnvironmentUserSourceControlProfileSetInput = Schema.Struct({
  userId: EnvironmentUserId,
  sourceControlProfileId: Schema.NullOr(SourceControlProfileId),
});
export type EnvironmentUserSourceControlProfileSetInput =
  typeof EnvironmentUserSourceControlProfileSetInput.Type;

export const EnvironmentUserManagementErrorReason = Schema.Literals([
  "identity-not-configured",
  "identity-required",
  "identity-invalid",
  "identity-blocked",
  "not-authorized",
  "user-not-found",
  "last-admin",
  "profile-not-found",
  "profile-already-assigned",
  "persistence-failed",
  "session-revocation-failed",
]);
export type EnvironmentUserManagementErrorReason = typeof EnvironmentUserManagementErrorReason.Type;

export class EnvironmentUserManagementError extends Schema.TaggedError<EnvironmentUserManagementError>()(
  "EnvironmentUserManagementError",
  {
    operation: TrimmedNonEmptyString,
    reason: EnvironmentUserManagementErrorReason,
    detail: TrimmedNonEmptyString,
    userId: Schema.optional(EnvironmentUserId),
  },
) {
  override get message(): string {
    return `User management ${this.operation} failed: ${this.detail}`;
  }
}
