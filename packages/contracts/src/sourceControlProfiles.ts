/**
 * T3-CUSTOM(expbkt3): Thread-owned source-control identity contracts.
 *
 * Extracted from `sourceControl.ts` so the upstream-owned file keeps a single
 * one-line fork seam instead of a 127-line block. Nothing here exists upstream;
 * see `docs/internals/source-control-identity.md`.
 */
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { EnvironmentUserId, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const SOURCE_CONTROL_PROFILE_SLUG_MAX_CHARS = 64;
const SOURCE_CONTROL_PROFILE_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export const SourceControlProfileId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SOURCE_CONTROL_PROFILE_SLUG_MAX_CHARS),
  Schema.isPattern(SOURCE_CONTROL_PROFILE_SLUG_PATTERN),
).pipe(Schema.brand("SourceControlProfileId"));
export type SourceControlProfileId = typeof SourceControlProfileId.Type;

export const SourceControlIdentityMode = Schema.Literals(["machine", "thread-profile"]);
export type SourceControlIdentityMode = typeof SourceControlIdentityMode.Type;

export const SourceControlCredentialStatus = Schema.Literals(["connected", "invalid", "missing"]);
export type SourceControlCredentialStatus = typeof SourceControlCredentialStatus.Type;

export const GitHubSourceControlProfileMetadata = Schema.Struct({
  id: SourceControlProfileId,
  provider: Schema.Literal("github"),
  label: TrimmedNonEmptyString,
  login: TrimmedNonEmptyString,
  accountId: PositiveInt,
  avatarUrl: Schema.NullOr(Schema.String),
  gitName: TrimmedNonEmptyString,
  gitEmail: TrimmedNonEmptyString,
  ownerUserId: Schema.NullOr(EnvironmentUserId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  archived: Schema.Boolean,
});
export type GitHubSourceControlProfileMetadata = typeof GitHubSourceControlProfileMetadata.Type;

export const GitHubSourceControlProfile = Schema.Struct({
  ...GitHubSourceControlProfileMetadata.fields,
  credentialStatus: SourceControlCredentialStatus,
});
export type GitHubSourceControlProfile = typeof GitHubSourceControlProfile.Type;

export const SourceControlProfilesListResult = Schema.Struct({
  identityMode: SourceControlIdentityMode,
  profiles: Schema.Array(GitHubSourceControlProfile),
});
export type SourceControlProfilesListResult = typeof SourceControlProfilesListResult.Type;

const SourceControlProfileCredential = TrimmedNonEmptyString.check(Schema.isMaxLength(1_024));

export const SourceControlProfileUpsertInput = Schema.Struct({
  id: Schema.optional(SourceControlProfileId),
  label: TrimmedNonEmptyString,
  gitName: TrimmedNonEmptyString,
  gitEmail: TrimmedNonEmptyString,
  credential: Schema.optional(SourceControlProfileCredential),
});
export type SourceControlProfileUpsertInput = typeof SourceControlProfileUpsertInput.Type;

export const SourceControlProfileIdInput = Schema.Struct({
  profileId: SourceControlProfileId,
});
export type SourceControlProfileIdInput = typeof SourceControlProfileIdInput.Type;

export const SourceControlProfileReplaceCredentialInput = Schema.Struct({
  profileId: SourceControlProfileId,
  credential: SourceControlProfileCredential,
});
export type SourceControlProfileReplaceCredentialInput =
  typeof SourceControlProfileReplaceCredentialInput.Type;

export const SourceControlProfileArchiveInput = Schema.Struct({
  profileId: SourceControlProfileId,
  archived: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type SourceControlProfileArchiveInput = typeof SourceControlProfileArchiveInput.Type;

export const SourceControlThreadOwnerSetInput = Schema.Struct({
  threadId: ThreadId,
  sourceControlProfileId: SourceControlProfileId,
});
export type SourceControlThreadOwnerSetInput = typeof SourceControlThreadOwnerSetInput.Type;

export const SourceControlConvertRemoteInput = Schema.Struct({
  threadId: ThreadId,
  cwd: TrimmedNonEmptyString,
  remoteName: TrimmedNonEmptyString,
});
export type SourceControlConvertRemoteInput = typeof SourceControlConvertRemoteInput.Type;

export const SourceControlConvertRemoteResult = Schema.Struct({
  remoteName: TrimmedNonEmptyString,
  previousUrl: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type SourceControlConvertRemoteResult = typeof SourceControlConvertRemoteResult.Type;

export const SourceControlProfileErrorReason = Schema.Literals([
  "missing-profile",
  "missing-credential",
  "invalid-credential",
  "identity-mismatch",
  "archived-profile",
  "insufficient-permission",
  "invalid-email",
  "thread-not-found",
  "thread-busy",
  "unsupported-runtime",
  "ssh-remote",
  "remote-not-found",
  "profile-persist-failed",
  "credential-store-failed",
  "validation-failed",
]);
export type SourceControlProfileErrorReason = typeof SourceControlProfileErrorReason.Type;

export class SourceControlProfileError extends Schema.TaggedError<SourceControlProfileError>()(
  "SourceControlProfileError",
  {
    operation: TrimmedNonEmptyString,
    reason: SourceControlProfileErrorReason,
    detail: TrimmedNonEmptyString,
    profileId: Schema.optional(SourceControlProfileId),
    threadId: Schema.optional(ThreadId),
  },
) {
  override get message(): string {
    return `Source-control identity ${this.operation} failed: ${this.detail}`;
  }
}
