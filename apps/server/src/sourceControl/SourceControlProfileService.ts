import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  GitHubSourceControlProfile,
  SourceControlProfileError,
  SourceControlProfileId,
  type GitHubSourceControlProfileMetadata,
  type SourceControlProfileArchiveInput,
  type SourceControlProfileIdInput,
  type SourceControlProfileReplaceCredentialInput,
  type SourceControlProfilesListResult,
  type SourceControlProfileUpsertInput,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GitHubCli from "./GitHubCli.ts";
import { scrubSourceControlIdentityEnvironment } from "./SourceControlExecutionEnvironment.ts";

export {
  mergeSourceControlEnvironment,
  RESERVED_SOURCE_CONTROL_ENVIRONMENT_KEYS,
  scrubSourceControlIdentityEnvironment,
} from "./SourceControlExecutionEnvironment.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const GitHubUser = Schema.Struct({
  login: Schema.String,
  id: Schema.Number,
  avatar_url: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
});
const decodeGitHubUser = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubUser));

const GitHubEmail = Schema.Struct({
  email: Schema.String,
  verified: Schema.Boolean,
});
const decodeGitHubEmails = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(GitHubEmail)),
);

interface ValidatedGitHubCredential {
  readonly login: string;
  readonly accountId: number;
  readonly avatarUrl: string | null;
  readonly displayName: string;
  readonly publicEmail: string | null;
}

export interface SourceControlExecutionContext {
  readonly profileId: SourceControlProfileId;
  readonly provider: "github";
  readonly login: string;
  readonly gitName: string;
  readonly gitEmail: string;
  readonly environment: NodeJS.ProcessEnv;
}

export function sourceControlProfileSecretName(profileId: SourceControlProfileId): string {
  return `source-control-github-${Buffer.from(profileId, "utf8").toString("base64url")}`;
}

function isGitHubNoreplyEmail(input: {
  readonly login: string;
  readonly accountId: number;
  readonly email: string;
}): boolean {
  const normalized = input.email.toLowerCase();
  const login = input.login.toLowerCase();
  return (
    normalized === `${login}@users.noreply.github.com` ||
    normalized === `${input.accountId}+${login}@users.noreply.github.com`
  );
}

function profileError(input: ConstructorParameters<typeof SourceControlProfileError>[0]) {
  return new SourceControlProfileError(input);
}

export class SourceControlProfileService extends Context.Service<
  SourceControlProfileService,
  {
    readonly list: Effect.Effect<SourceControlProfilesListResult, SourceControlProfileError>;
    readonly upsert: (
      input: SourceControlProfileUpsertInput,
    ) => Effect.Effect<GitHubSourceControlProfile, SourceControlProfileError>;
    readonly test: (
      input: SourceControlProfileIdInput,
    ) => Effect.Effect<GitHubSourceControlProfile, SourceControlProfileError>;
    readonly replaceCredential: (
      input: SourceControlProfileReplaceCredentialInput,
    ) => Effect.Effect<GitHubSourceControlProfile, SourceControlProfileError>;
    readonly disconnect: (
      input: SourceControlProfileIdInput,
    ) => Effect.Effect<GitHubSourceControlProfile, SourceControlProfileError>;
    readonly archive: (
      input: SourceControlProfileArchiveInput,
    ) => Effect.Effect<GitHubSourceControlProfile, SourceControlProfileError>;
    readonly resolveExecutionContext: (
      profileId: SourceControlProfileId,
      baseEnvironment?: NodeJS.ProcessEnv,
    ) => Effect.Effect<SourceControlExecutionContext, SourceControlProfileError>;
    readonly resolveUserExecutionContext: (
      ownerUserId: UserId,
      baseEnvironment?: NodeJS.ProcessEnv,
    ) => Effect.Effect<SourceControlExecutionContext | null, SourceControlProfileError>;
    readonly resolveThreadExecutionContext: (
      threadId: ThreadId,
      ownerUserId: UserId | null,
      baseEnvironment?: NodeJS.ProcessEnv,
    ) => Effect.Effect<SourceControlExecutionContext | null, SourceControlProfileError>;
  }
>()("t3/sourceControl/SourceControlProfileService") {}

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const github = yield* GitHubCli.GitHubCli;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const invalidProfiles = yield* Ref.make(new Set<SourceControlProfileId>());

  const setCredentialInvalid = (profileId: SourceControlProfileId, invalid: boolean) =>
    Ref.update(invalidProfiles, (current) => {
      const next = new Set(current);
      if (invalid) next.add(profileId);
      else next.delete(profileId);
      return next;
    });

  const getMetadata = Effect.fn("SourceControlProfileService.getMetadata")(function* (
    profileId: SourceControlProfileId,
  ) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() =>
        profileError({
          operation: "read-profile",
          reason: "profile-persist-failed",
          detail: "Could not read source-control profile settings.",
          profileId,
        }),
      ),
    );
    const profile = current.sourceControlProfiles[profileId];
    if (!profile) {
      return yield* profileError({
        operation: "read-profile",
        reason: "missing-profile",
        detail: "The selected GitHub profile no longer exists.",
        profileId,
      });
    }
    return profile;
  });

  const readCredential = Effect.fn("SourceControlProfileService.readCredential")(function* (
    profileId: SourceControlProfileId,
  ) {
    const credential = yield* secrets.get(sourceControlProfileSecretName(profileId)).pipe(
      Effect.mapError(() =>
        profileError({
          operation: "read-credential",
          reason: "credential-store-failed",
          detail: "Could not read the GitHub credential from the server secret store.",
          profileId,
        }),
      ),
    );
    if (Option.isNone(credential)) {
      return yield* profileError({
        operation: "read-credential",
        reason: "missing-credential",
        detail: "Reconnect the selected GitHub profile before continuing.",
        profileId,
      });
    }
    return textDecoder.decode(credential.value);
  });

  const isolatedEnvironment = Effect.fn("SourceControlProfileService.isolatedEnvironment")(
    function* (
      profileId: SourceControlProfileId,
      credential: string,
      baseEnvironment: NodeJS.ProcessEnv,
    ) {
      const ghConfigDir = path.join(config.stateDir, "source-control", "github", profileId);
      yield* fileSystem.makeDirectory(ghConfigDir, { recursive: true }).pipe(
        Effect.mapError(() =>
          profileError({
            operation: "prepare-environment",
            reason: "validation-failed",
            detail: "Could not prepare an isolated GitHub CLI configuration directory.",
            profileId,
          }),
        ),
      );
      yield* fileSystem.chmod(ghConfigDir, 0o700).pipe(Effect.ignore);
      return {
        ...scrubSourceControlIdentityEnvironment(baseEnvironment),
        GH_TOKEN: credential,
        GH_CONFIG_DIR: ghConfigDir,
        GH_PROMPT_DISABLED: "1",
        GIT_TERMINAL_PROMPT: "0",
      } satisfies NodeJS.ProcessEnv;
    },
  );

  const validateCredential = Effect.fn("SourceControlProfileService.validateCredential")(function* (
    profileId: SourceControlProfileId,
    credential: string,
  ): Effect.fn.Return<ValidatedGitHubCredential, SourceControlProfileError> {
    const environment = yield* isolatedEnvironment(profileId, credential, process.env);
    const response = yield* github
      .execute({ cwd: config.cwd, args: ["api", "user"], env: environment })
      .pipe(
        Effect.mapError((error) =>
          profileError({
            operation: "validate-credential",
            reason:
              error._tag === "GitHubCliAuthenticationError"
                ? "invalid-credential"
                : "validation-failed",
            detail:
              error._tag === "GitHubCliAuthenticationError"
                ? "GitHub rejected this credential. Replace it with a valid fine-grained token."
                : "GitHub CLI could not validate this credential.",
            profileId,
          }),
        ),
      );
    const user = yield* decodeGitHubUser(response.stdout).pipe(
      Effect.mapError(() =>
        profileError({
          operation: "validate-credential",
          reason: "validation-failed",
          detail: "GitHub returned an unexpected account response.",
          profileId,
        }),
      ),
    );
    if (!Number.isSafeInteger(user.id) || user.id <= 0 || user.login.trim().length === 0) {
      return yield* profileError({
        operation: "validate-credential",
        reason: "validation-failed",
        detail: "GitHub returned an invalid account identity.",
        profileId,
      });
    }
    return {
      login: user.login,
      accountId: user.id,
      avatarUrl: user.avatar_url,
      displayName: user.name?.trim() || user.login,
      publicEmail: user.email,
    };
  });

  const validateGitEmail = Effect.fn("SourceControlProfileService.validateGitEmail")(function* (
    profileId: SourceControlProfileId,
    credential: string,
    identity: ValidatedGitHubCredential,
    gitEmail: string,
  ) {
    if (
      isGitHubNoreplyEmail({
        login: identity.login,
        accountId: identity.accountId,
        email: gitEmail,
      }) ||
      identity.publicEmail?.toLowerCase() === gitEmail.toLowerCase()
    ) {
      return;
    }

    const noreplyEmail = `${identity.accountId}+${identity.login}@users.noreply.github.com`;

    const environment = yield* isolatedEnvironment(profileId, credential, process.env);
    const response = yield* github
      .execute({ cwd: config.cwd, args: ["api", "user/emails"], env: environment })
      .pipe(
        Effect.mapError(() =>
          profileError({
            operation: "validate-email",
            reason: "invalid-email",
            detail: `GitHub could not verify this email. Grant the token "Email addresses: read", or use ${noreplyEmail}.`,
            profileId,
          }),
        ),
      );
    const emails = yield* decodeGitHubEmails(response.stdout).pipe(
      Effect.mapError(() =>
        profileError({
          operation: "validate-email",
          reason: "invalid-email",
          detail: `GitHub could not confirm this commit email. Grant the token "Email addresses: read", or use ${noreplyEmail}.`,
          profileId,
        }),
      ),
    );
    if (
      !emails.some(
        (entry) => entry.verified && entry.email.toLowerCase() === gitEmail.toLowerCase(),
      )
    ) {
      return yield* profileError({
        operation: "validate-email",
        reason: "invalid-email",
        detail: `This email is not verified on GitHub. Use a verified email or ${noreplyEmail}.`,
        profileId,
      });
    }
  });

  const credentialStatus = Effect.fn("SourceControlProfileService.credentialStatus")(function* (
    profileId: SourceControlProfileId,
  ) {
    const value = yield* secrets.get(sourceControlProfileSecretName(profileId)).pipe(
      Effect.mapError(() =>
        profileError({
          operation: "list-profiles",
          reason: "credential-store-failed",
          detail: "Could not inspect GitHub credential health.",
          profileId,
        }),
      ),
    );
    if (Option.isNone(value)) return "missing" as const;
    return (yield* Ref.get(invalidProfiles)).has(profileId)
      ? ("invalid" as const)
      : ("connected" as const);
  });

  const materializeProfile = Effect.fn("SourceControlProfileService.materializeProfile")(function* (
    metadata: GitHubSourceControlProfileMetadata,
  ) {
    return GitHubSourceControlProfile.make({
      ...metadata,
      credentialStatus: yield* credentialStatus(metadata.id),
    });
  });

  const persistMetadata = Effect.fn("SourceControlProfileService.persistMetadata")(function* (
    metadata: GitHubSourceControlProfileMetadata,
  ) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() =>
        profileError({
          operation: "save-profile",
          reason: "profile-persist-failed",
          detail: "Could not read source-control profile settings.",
          profileId: metadata.id,
        }),
      ),
    );
    yield* settings
      .updateSettings({
        sourceControlProfiles: {
          ...current.sourceControlProfiles,
          [metadata.id]: metadata,
        },
      })
      .pipe(
        Effect.mapError(() =>
          profileError({
            operation: "save-profile",
            reason: "profile-persist-failed",
            detail: "Could not save source-control profile metadata.",
            profileId: metadata.id,
          }),
        ),
      );
  });

  const writeCredential = Effect.fn("SourceControlProfileService.writeCredential")(function* (
    profileId: SourceControlProfileId,
    credential: string,
  ) {
    yield* secrets
      .set(sourceControlProfileSecretName(profileId), textEncoder.encode(credential))
      .pipe(
        Effect.mapError(() =>
          profileError({
            operation: "save-credential",
            reason: "credential-store-failed",
            detail: "Could not store the GitHub credential securely.",
            profileId,
          }),
        ),
      );
  });

  const list: SourceControlProfileService["Service"]["list"] = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() =>
        profileError({
          operation: "list-profiles",
          reason: "profile-persist-failed",
          detail: "Could not read source-control profile settings.",
        }),
      ),
    );
    const profiles = yield* Effect.forEach(
      Object.values(current.sourceControlProfiles).sort((left, right) =>
        left.label.localeCompare(right.label),
      ),
      materializeProfile,
      { concurrency: 4 },
    );
    return { identityMode: current.sourceControlIdentityMode, profiles };
  });

  const upsert: SourceControlProfileService["Service"]["upsert"] = Effect.fn(
    "SourceControlProfileService.upsert",
  )(function* (input) {
    const existing = input.id
      ? yield* getMetadata(input.id).pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            error.reason === "missing-profile" ? Effect.succeed(Option.none()) : Effect.fail(error),
          ),
        )
      : Option.none();
    const credential =
      input.credential ??
      (Option.isSome(existing) ? yield* readCredential(existing.value.id) : undefined);
    if (!credential) {
      return yield* profileError({
        operation: "create-profile",
        reason: "missing-credential",
        detail: "A GitHub credential is required when creating a profile.",
      });
    }
    const provisionalId = input.id ?? SourceControlProfileId.make("github_profile");
    const identity = yield* validateCredential(provisionalId, credential);
    const profileId = input.id ?? SourceControlProfileId.make(`github_${identity.accountId}`);
    if (Option.isSome(existing) && existing.value.login !== identity.login) {
      return yield* profileError({
        operation: "update-profile",
        reason: "identity-mismatch",
        detail: `This credential belongs to @${identity.login}, not @${existing.value.login}.`,
        profileId,
      });
    }
    yield* validateGitEmail(profileId, credential, identity, input.gitEmail);
    const metadata = {
      id: profileId,
      provider: "github" as const,
      label: input.label,
      login: identity.login,
      accountId: identity.accountId,
      avatarUrl: identity.avatarUrl,
      gitName: input.gitName || identity.displayName,
      gitEmail: input.gitEmail,
      ownerUserId: Option.isSome(existing) ? existing.value.ownerUserId : null,
      archived: Option.isSome(existing) ? existing.value.archived : false,
    } satisfies GitHubSourceControlProfileMetadata;
    yield* persistMetadata(metadata);
    if (input.credential !== undefined || Option.isNone(existing)) {
      yield* writeCredential(profileId, credential);
    }
    yield* setCredentialInvalid(profileId, false);
    return yield* materializeProfile(metadata);
  });

  const testProfile = Effect.fn("SourceControlProfileService.test")(function* (
    input: SourceControlProfileIdInput,
  ) {
    const { profileId } = input;
    const metadata = yield* getMetadata(profileId);
    const credential = yield* readCredential(profileId);
    const identity = yield* validateCredential(profileId, credential);
    if (identity.login !== metadata.login || identity.accountId !== metadata.accountId) {
      return yield* profileError({
        operation: "test-profile",
        reason: "identity-mismatch",
        detail: `The stored credential no longer belongs to @${metadata.login}.`,
        profileId,
      });
    }
    yield* validateGitEmail(profileId, credential, identity, metadata.gitEmail);
    return GitHubSourceControlProfile.make({ ...metadata, credentialStatus: "connected" });
  });

  const test: SourceControlProfileService["Service"]["test"] = (input) =>
    testProfile(input).pipe(
      Effect.tap(() => setCredentialInvalid(input.profileId, false)),
      Effect.tapError(() => setCredentialInvalid(input.profileId, true)),
    );

  const replaceCredential: SourceControlProfileService["Service"]["replaceCredential"] = Effect.fn(
    "SourceControlProfileService.replaceCredential",
  )(function* ({ profileId, credential }) {
    const metadata = yield* getMetadata(profileId);
    const identity = yield* validateCredential(profileId, credential);
    if (identity.login !== metadata.login || identity.accountId !== metadata.accountId) {
      return yield* profileError({
        operation: "replace-credential",
        reason: "identity-mismatch",
        detail: `This credential belongs to @${identity.login}, not @${metadata.login}.`,
        profileId,
      });
    }
    yield* validateGitEmail(profileId, credential, identity, metadata.gitEmail);
    yield* writeCredential(profileId, credential);
    yield* setCredentialInvalid(profileId, false);
    return GitHubSourceControlProfile.make({ ...metadata, credentialStatus: "connected" });
  });

  const disconnect: SourceControlProfileService["Service"]["disconnect"] = Effect.fn(
    "SourceControlProfileService.disconnect",
  )(function* ({ profileId }) {
    const metadata = yield* getMetadata(profileId);
    yield* secrets.remove(sourceControlProfileSecretName(profileId)).pipe(
      Effect.mapError(() =>
        profileError({
          operation: "disconnect-profile",
          reason: "credential-store-failed",
          detail: "Could not remove the GitHub credential from the server secret store.",
          profileId,
        }),
      ),
    );
    yield* setCredentialInvalid(profileId, false);
    return GitHubSourceControlProfile.make({ ...metadata, credentialStatus: "missing" });
  });

  const archive: SourceControlProfileService["Service"]["archive"] = Effect.fn(
    "SourceControlProfileService.archive",
  )(function* ({ profileId, archived }) {
    const metadata = { ...(yield* getMetadata(profileId)), archived };
    yield* persistMetadata(metadata);
    return yield* materializeProfile(metadata);
  });

  const resolveContext = Effect.fn("SourceControlProfileService.resolveContext")(function* (
    profileId: SourceControlProfileId,
    baseEnvironment: NodeJS.ProcessEnv,
    allowArchived: boolean,
  ) {
    const metadata = yield* getMetadata(profileId);
    if (metadata.archived && !allowArchived) {
      return yield* profileError({
        operation: "resolve-profile",
        reason: "archived-profile",
        detail: "Archived GitHub profiles cannot start new source-control operations.",
        profileId,
      });
    }
    if ((yield* Ref.get(invalidProfiles)).has(profileId)) {
      return yield* profileError({
        operation: "resolve-profile",
        reason: "invalid-credential",
        detail: "Reconnect the selected GitHub profile before continuing.",
        profileId,
      });
    }
    const credential = yield* readCredential(profileId);
    const isolated = yield* isolatedEnvironment(profileId, credential, baseEnvironment);
    const environment = {
      ...isolated,
      GIT_AUTHOR_NAME: metadata.gitName,
      GIT_AUTHOR_EMAIL: metadata.gitEmail,
      GIT_COMMITTER_NAME: metadata.gitName,
      GIT_COMMITTER_EMAIL: metadata.gitEmail,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_1: "!gh auth git-credential",
      GIT_SSH_COMMAND: "false",
    } satisfies NodeJS.ProcessEnv;
    return {
      profileId,
      provider: "github" as const,
      login: metadata.login,
      gitName: metadata.gitName,
      gitEmail: metadata.gitEmail,
      environment,
    };
  });

  const resolveExecutionContext: SourceControlProfileService["Service"]["resolveExecutionContext"] =
    Effect.fn("SourceControlProfileService.resolveExecutionContext")(
      (profileId, baseEnvironment = process.env) =>
        resolveContext(profileId, baseEnvironment, false),
    );

  const resolveUserExecutionContext: SourceControlProfileService["Service"]["resolveUserExecutionContext"] =
    Effect.fn("SourceControlProfileService.resolveUserExecutionContext")(function* (
      ownerUserId,
      baseEnvironment = process.env,
    ) {
      const current = yield* settings.getSettings.pipe(
        Effect.mapError(() =>
          profileError({
            operation: "resolve-user-profile",
            reason: "profile-persist-failed",
            detail: "Could not read source-control identity settings.",
          }),
        ),
      );
      if (current.sourceControlIdentityMode === "machine") {
        return null;
      }
      const profile = Object.values(current.sourceControlProfiles).find(
        (candidate) =>
          candidate.ownerUserId !== null && String(candidate.ownerUserId) === String(ownerUserId),
      );
      if (profile === undefined) {
        return yield* profileError({
          operation: "resolve-user-profile",
          reason: "missing-profile",
          detail: "Assign a connected GitHub profile to this user in Settings before continuing.",
        });
      }
      return yield* resolveContext(profile.id, baseEnvironment, false);
    });

  const resolveThreadExecutionContext: SourceControlProfileService["Service"]["resolveThreadExecutionContext"] =
    Effect.fn("SourceControlProfileService.resolveThreadExecutionContext")(function* (
      threadId,
      ownerUserId,
      baseEnvironment = process.env,
    ) {
      const current = yield* settings.getSettings.pipe(
        Effect.mapError(() =>
          profileError({
            operation: "resolve-thread-profile",
            reason: "profile-persist-failed",
            detail: "Could not read source-control identity mode.",
            threadId,
          }),
        ),
      );
      if (current.sourceControlIdentityMode === "machine") {
        return null;
      }
      if (ownerUserId === null) {
        return yield* profileError({
          operation: "resolve-thread-profile",
          reason: "missing-profile",
          detail: "This thread has no owner. Assign an owner before continuing.",
          threadId,
        });
      }
      return yield* resolveUserExecutionContext(ownerUserId, baseEnvironment).pipe(
        Effect.mapError((error) =>
          profileError({
            operation: error.operation,
            reason: error.reason,
            detail: error.detail,
            ...(error.profileId !== undefined ? { profileId: error.profileId } : {}),
            threadId,
          }),
        ),
      );
    });

  return SourceControlProfileService.of({
    list,
    upsert,
    test,
    replaceCredential,
    disconnect,
    archive,
    resolveExecutionContext,
    resolveUserExecutionContext,
    resolveThreadExecutionContext,
  });
});

export const layer = Layer.effect(SourceControlProfileService, make);
