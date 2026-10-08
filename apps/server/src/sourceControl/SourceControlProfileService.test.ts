import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentUserId,
  SourceControlProfileId,
  ThreadId,
  UserId,
  type ServerSettings,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
// T3-CUSTOM(expbkt3): profile validation reads GitHub through upstream's API transport.
import * as GitHubApi from "./GitHubApi.ts";
import { make, sourceControlProfileSecretName } from "./SourceControlProfileService.ts";

const output = (body: string): GitHubApi.GitHubRestResponse => ({
  status: 200,
  headers: {},
  body,
  truncated: false,
  invalidUtf8: false,
});

const makeHarness = Effect.gen(function* () {
  const settings = yield* Ref.make<ServerSettings>({
    ...DEFAULT_SERVER_SETTINGS,
    sourceControlIdentityMode: "thread-profile",
  });
  const secrets = new Map<string, Uint8Array>();
  const validationCredentials: Array<{ readonly host: string; readonly token: string }> = [];

  const settingsLayer = Layer.mock(ServerSettingsService)({
    getSettings: Ref.get(settings),
    updateSettings: (patch) =>
      Ref.updateAndGet(settings, (current) => applyServerSettingsPatch(current, patch)),
  });
  const secretLayer = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
      set: (name, value) => Effect.sync(() => void secrets.set(name, Uint8Array.from(value))),
      create: (name, value) => Effect.sync(() => void secrets.set(name, Uint8Array.from(value))),
      getOrCreateRandom: () => Effect.die("unused random secret"),
      remove: (name) => Effect.sync(() => void secrets.delete(name)),
    }),
  );
  const githubLayer = Layer.mock(GitHubApi.GitHubApi)({
    rest: (input) =>
      Effect.gen(function* () {
        // The profile's token arrives pinned, never through the machine's credential.
        const pinned = yield* GitHubApi.PinnedGitHubCredential;
        const credential = pinned === null ? undefined : Redacted.value(pinned.token);
        validationCredentials.push({ host: pinned?.host ?? "", token: credential ?? "" });
        if (credential === "invalid-token") {
          return yield* new GitHubApi.GitHubApiAuthenticationError({
            host: input.host,
            operation: input.operation,
          });
        }
        if (input.path === "user/emails") {
          if (credential === "email-private-token") {
            return yield* new GitHubApi.GitHubApiResponseError({
              host: input.host,
              operation: input.operation,
              status: 403,
              githubErrors: ["Resource not accessible by personal access token"],
            });
          }
          return output("[]");
        }
        const bob = credential === "bob-token";
        return output(
          JSON.stringify({
            login: bob ? "bob" : "alice",
            id: bob ? 84 : 42,
            avatar_url: null,
            name: bob ? "Bob Example" : "Alice Example",
            email: null,
          }),
        );
      }),
  });
  const dependencies = Layer.mergeAll(
    settingsLayer,
    secretLayer,
    githubLayer,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-control-profile-test-" }),
  );
  const service = yield* make.pipe(Effect.provide(dependencies));

  return { service, settings, secrets, validationCredentials };
});

it.layer(NodeServices.layer)("SourceControlProfileService", (it) => {
  it.effect("stores credentials separately and resolves an isolated execution environment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const profile = yield* harness.service.upsert({
        label: "Alice",
        gitName: "Alice Example",
        gitEmail: "42+alice@users.noreply.github.com",
        credential: "alice-token",
      });

      assert.strictEqual(profile.login, "alice");
      assert.strictEqual(profile.credentialStatus, "connected");
      const storedSettings = yield* Ref.get(harness.settings);
      assert.notProperty(storedSettings.sourceControlProfiles[profile.id], "credential");
      assert.strictEqual(
        new TextDecoder().decode(harness.secrets.get(sourceControlProfileSecretName(profile.id))),
        "alice-token",
      );

      const context = yield* harness.service.resolveExecutionContext(profile.id, {
        GH_TOKEN: "machine-token",
        GITHUB_TOKEN: "machine-github-token",
        GH_CONFIG_DIR: "/machine-gh",
        GIT_AUTHOR_NAME: "Machine User",
        GIT_CONFIG_COUNT: "99",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "machine-helper",
      });

      assert.strictEqual(context.login, "alice");
      assert.strictEqual(context.environment.GH_TOKEN, "alice-token");
      assert.isUndefined(context.environment.GITHUB_TOKEN);
      assert.strictEqual(context.environment.GIT_AUTHOR_NAME, "Alice Example");
      assert.strictEqual(context.environment.GIT_AUTHOR_EMAIL, profile.gitEmail);
      assert.strictEqual(context.environment.GIT_CONFIG_COUNT, "2");
      assert.strictEqual(context.environment.GIT_CONFIG_VALUE_1, "!gh auth git-credential");
      assert.strictEqual(context.environment.GIT_SSH_COMMAND, "false");
      assert.notStrictEqual(context.environment.GH_CONFIG_DIR, "/machine-gh");

      const validationCredential = harness.validationCredentials[0];
      assert.strictEqual(validationCredential?.token, "alice-token");
      assert.strictEqual(validationCredential?.host, "github.com");
    }),
  );

  it.effect("resolves a thread's GitHub identity from its durable owner", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const profile = yield* harness.service.upsert({
        label: "Alice",
        gitName: "Alice Example",
        gitEmail: "42+alice@users.noreply.github.com",
        credential: "alice-token",
      });
      yield* Ref.update(harness.settings, (settings) => ({
        ...settings,
        sourceControlProfiles: {
          ...settings.sourceControlProfiles,
          [profile.id]: {
            ...settings.sourceControlProfiles[profile.id]!,
            ownerUserId: EnvironmentUserId.make("user-alice"),
          },
        },
      }));

      const context = yield* harness.service.resolveThreadExecutionContext(
        ThreadId.make("thread-alice"),
        UserId.make("user-alice"),
        {},
      );

      assert.strictEqual(context?.profileId, profile.id);
      assert.strictEqual(context?.login, "alice");
      assert.strictEqual(context?.environment.GH_TOKEN, "alice-token");

      const replacementProfile = yield* harness.service.upsert({
        label: "Bob",
        gitName: "Bob Example",
        gitEmail: "84+bob@users.noreply.github.com",
        credential: "bob-token",
      });
      yield* Ref.update(harness.settings, (settings) => ({
        ...settings,
        sourceControlProfiles: {
          ...settings.sourceControlProfiles,
          [profile.id]: {
            ...settings.sourceControlProfiles[profile.id]!,
            ownerUserId: null,
          },
          [replacementProfile.id]: {
            ...settings.sourceControlProfiles[replacementProfile.id]!,
            ownerUserId: EnvironmentUserId.make("user-alice"),
          },
        },
      }));

      const reassignedContext = yield* harness.service.resolveThreadExecutionContext(
        ThreadId.make("thread-alice"),
        UserId.make("user-alice"),
        {},
      );
      assert.strictEqual(reassignedContext?.profileId, replacementProfile.id);
      assert.strictEqual(reassignedContext?.login, "bob");
      assert.strictEqual(reassignedContext?.environment.GH_TOKEN, "bob-token");
    }),
  );

  it.effect("rejects a replacement credential owned by another GitHub account", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const profile = yield* harness.service.upsert({
        label: "Alice",
        gitName: "Alice Example",
        gitEmail: "42+alice@users.noreply.github.com",
        credential: "alice-token",
      });

      const error = yield* Effect.flip(
        harness.service.replaceCredential({ profileId: profile.id, credential: "bob-token" }),
      );
      assert.strictEqual(error.reason, "identity-mismatch");
      assert.notInclude(error.detail, "bob-token");
      assert.strictEqual(
        new TextDecoder().decode(harness.secrets.get(sourceControlProfileSecretName(profile.id))),
        "alice-token",
      );
    }),
  );

  it.effect("explains how to recover when a token cannot read private GitHub emails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const error = yield* Effect.flip(
        harness.service.upsert({
          label: "Alice",
          gitName: "Alice Example",
          gitEmail: "alice@example.com",
          credential: "email-private-token",
        }),
      );

      assert.strictEqual(error.reason, "invalid-email");
      assert.strictEqual(
        error.detail,
        'GitHub could not verify this email. Grant the token "Email addresses: read", or use 42+alice@users.noreply.github.com.',
      );
      assert.notInclude(error.detail, "email-private-token");
    }),
  );

  it.effect("reports a tested invalid credential and fails closed after disconnect", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const profile = yield* harness.service.upsert({
        label: "Alice",
        gitName: "Alice Example",
        gitEmail: "42+alice@users.noreply.github.com",
        credential: "alice-token",
      });
      yield* Effect.sync(() =>
        harness.secrets.set(
          sourceControlProfileSecretName(profile.id),
          new TextEncoder().encode("invalid-token"),
        ),
      );

      const invalid = yield* Effect.flip(harness.service.test({ profileId: profile.id }));
      assert.strictEqual(invalid.reason, "invalid-credential");
      const listed = yield* harness.service.list;
      assert.strictEqual(listed.profiles[0]?.credentialStatus, "invalid");
      const rejectedInvalid = yield* Effect.flip(
        harness.service.resolveExecutionContext(profile.id),
      );
      assert.strictEqual(rejectedInvalid.reason, "invalid-credential");

      yield* harness.service.disconnect({ profileId: profile.id });
      const disconnected = yield* Effect.flip(
        harness.service.resolveExecutionContext(SourceControlProfileId.make(profile.id)),
      );
      assert.strictEqual(disconnected.reason, "missing-credential");
    }),
  );
});
