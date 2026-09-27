#!/usr/bin/env node

/**
 * Builds a Beknown-branded macOS DMG from the current checkout.
 *
 * There are two fork apps and `--channel` picks which one this is — it selects
 * the bundle id, product name, user-data directory, updater channel and the
 * central server the build orchestrates, all at once:
 *
 *   node scripts/build-bk-desktop-dmg.ts --channel staging     # BK T3 Code (Staging), expbkt3
 *   node scripts/build-bk-desktop-dmg.ts --channel production  # BK T3 Code, bkt3
 *   node scripts/build-bk-desktop-dmg.ts --channel staging \
 *     --build-version 0.0.32-staging-nightly.20260810.1
 *
 * Must run on macOS: electron-builder cannot cross-compile a mac DMG, so this
 * fails fast anywhere else rather than producing something unusable. Set
 * `T3CODE_BK_SIGNING_IDENTITY` to sign; unsigned builds run locally but cannot
 * be published, because Squirrel.Mac cannot install them as updates.
 *
 * See docs/operations/bk-desktop-build.md.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  BK_DESKTOP_BRAND_ID,
  BK_DESKTOP_BRANDS,
  BK_DESKTOP_UPDATE_REPOSITORY,
  DESKTOP_BRAND_ENV_VAR,
} from "./lib/bk-desktop-brand.ts";
import { BK_SIGNING_IDENTITY_ENV_VAR, resolveBkSigningIdentity } from "./lib/bk-desktop-signing.ts";
import {
  BK_MANAGED_CHANNEL_ENV_VAR,
  BK_MANAGED_ENVIRONMENTS,
  isBkManagedChannel,
  type BkManagedChannel,
} from "./lib/bk-managed-environment.ts";
import {
  BK_DESKTOP_RELEASE_REPOSITORY,
  composeNightlyVersion,
  formatBuildDate,
  parseNightlyVersion,
  resolveNextCounter,
  updateManifestFileName,
} from "./lib/bk-desktop-release.ts";
import { loadRepoEnv } from "./lib/public-config.ts";
import { readDesktopBaseVersion } from "./resolve-nightly-release.ts";

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

const GhReleaseList = Schema.Array(Schema.Struct({ tagName: Schema.String }));
const decodeGhReleaseList = Schema.decodeUnknownEffect(Schema.fromJsonString(GhReleaseList));

export class UnsupportedBuildHostError extends Schema.TaggedError<UnsupportedBuildHostError>()(
  "UnsupportedBuildHostError",
  {
    hostPlatform: Schema.String,
  },
) {
  override get message(): string {
    return (
      `A macOS DMG can only be built on macOS (host is "${this.hostPlatform}"). ` +
      `electron-builder cannot cross-compile it. Run this on your Mac; ` +
      `see docs/operations/bk-desktop-build.md.`
    );
  }
}

export class InvalidBkBuildVersionError extends Schema.TaggedError<InvalidBkBuildVersionError>()(
  "InvalidBkBuildVersionError",
  {
    version: Schema.String,
    channel: Schema.String,
  },
) {
  override get message(): string {
    return (
      `--build-version must look like 0.0.32-${this.channel}-nightly.20260810.1, got ` +
      `"${this.version}". Fork builds must use the nightly channel or auto-update cannot ` +
      `see them, and the leading "${this.channel}" is what keeps the two fork apps' updates ` +
      `apart; see scripts/lib/bk-desktop-release.ts.`
    );
  }
}

export class BuildVersionChannelMismatchError extends Schema.TaggedError<BuildVersionChannelMismatchError>()(
  "BuildVersionChannelMismatchError",
  {
    version: Schema.String,
    channel: Schema.String,
    versionChannel: Schema.String,
  },
) {
  override get message(): string {
    return (
      `--build-version ${this.version} is a ${this.versionChannel} version, but --channel is ` +
      `${this.channel}. The version's channel decides which app's updater picks the build up, ` +
      `so this would ship a ${this.channel} build to ${this.versionChannel} users.`
    );
  }
}

export class BuildNumberUnavailableError extends Schema.TaggedError<BuildNumberUnavailableError>()(
  "BuildNumberUnavailableError",
  {
    suggestedVersion: Schema.String,
  },
) {
  override get message(): string {
    return (
      `Could not list releases from ${BK_DESKTOP_RELEASE_REPOSITORY} to pick the next build ` +
      `number. Authenticate with \`gh auth login\`, or pass ` +
      `--build-version ${this.suggestedVersion} explicitly.`
    );
  }
}

export class InvalidBkManagedChannelError extends Schema.TaggedError<InvalidBkManagedChannelError>()(
  "InvalidBkManagedChannelError",
  {
    channel: Schema.String,
  },
) {
  override get message(): string {
    return (
      `--channel must be one of ${Object.keys(BK_MANAGED_ENVIRONMENTS).join(", ")}, got ` +
      `"${this.channel}". Omit it to build an ordinary desktop app whose primary ` +
      `environment is the bundled local backend.`
    );
  }
}

export class ManagedBuildClerkKeyError extends Schema.TaggedError<ManagedBuildClerkKeyError>()(
  "ManagedBuildClerkKeyError",
  {
    channel: Schema.String,
    source: Schema.String,
    variable: Schema.String,
  },
) {
  override get message(): string {
    return (
      `${this.variable} is set (from ${this.source}), but a managed ${this.channel} build must ` +
      `be keyless. Identity and team capability come from the device-bound pairing credential, ` +
      `not Clerk. A publishable key makes apps/web/src/main.tsx mount ElectronClerkProvider, ` +
      `which renders nothing until Clerk's Native API answers — the black-screen/auth failure ` +
      `this fork already hit. Remove it and rebuild; see docs/operations/bk-desktop-build.md.`
    );
  }
}

export class BkDesktopBuildFailedError extends Schema.TaggedError<BkDesktopBuildFailedError>()(
  "BkDesktopBuildFailedError",
  {
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop artifact build failed with exit code ${this.exitCode}.`;
  }
}

const forwardStream = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  output: NodeJS.WriteStream,
): Effect.Effect<void, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => Effect.sync(() => output.write(chunk))),
  );

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (accumulator, chunk) => accumulator + chunk,
    ),
  );

/**
 * Lists existing fork release tags so the build can pick the next counter.
 *
 * Returns `undefined` when `gh` is missing, unauthenticated, or returns something
 * unexpected. That is not fatal here — the caller turns it into an actionable
 * error telling the user to pass --build-version instead.
 */
const listPublishedTags = Effect.fn("listPublishedTags")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const result = yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make("gh", [
        "release",
        "list",
        "--repo",
        BK_DESKTOP_RELEASE_REPOSITORY,
        "--limit",
        "100",
        "--json",
        "tagName",
      ]),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [collectStreamAsString(child.stdout), child.exitCode.pipe(Effect.map(Number))],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return undefined;
    }
    const releases = yield* decodeGhReleaseList(stdout);
    return releases.map((release) => release.tagName);
  }).pipe(Effect.option);

  return Option.getOrUndefined(result);
});

/**
 * Exported so `resolve-bk-desktop-version.ts` — which CI uses to stamp a build
 * before calling this script — computes the version the same way rather than
 * reimplementing the counter rules in shell.
 */
export const resolveBuildVersion = Effect.fn("resolveBuildVersion")(function* (
  requested: Option.Option<string>,
  channel: BkManagedChannel,
) {
  if (Option.isSome(requested)) {
    const version = requested.value.trim();
    const parsed = parseNightlyVersion(version);
    if (!parsed) {
      return yield* new InvalidBkBuildVersionError({ version, channel });
    }
    // A version carries the channel in its first prerelease identifier, so an
    // explicit --build-version can disagree with --channel. That would produce a
    // staging-identity app stamped with a production version, which publishes
    // straight onto the team's channel.
    if (parsed.variant !== channel) {
      return yield* new BuildVersionChannelMismatchError({
        version,
        channel,
        versionChannel: parsed.variant,
      });
    }
    return version;
  }

  const baseVersion = yield* readDesktopBaseVersion(undefined);
  const date = formatBuildDate(yield* DateTime.now);
  const publishedTags = yield* listPublishedTags();
  if (!publishedTags) {
    return yield* new BuildNumberUnavailableError({
      suggestedVersion: composeNightlyVersion(baseVersion, channel, date, 1),
    });
  }

  return composeNightlyVersion(
    baseVersion,
    channel,
    date,
    resolveNextCounter(publishedTags, channel, baseVersion, date),
  );
});

/**
 * Finds a Clerk publishable key that would be baked into a managed build.
 *
 * Checks both places one can arrive from: a repo dotenv file (which is what
 * `loadRepoEnv` folds in, and what CI must never write) and the ambient
 * environment. Any variable mentioning CLERK counts — the point is to catch the
 * accident, not to enumerate the aliases.
 */
const resolveConflictingClerkKey = Effect.fn("resolveConflictingClerkKey")(function* (
  repoEnv: Readonly<Record<string, string | undefined>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;

  for (const file of [".env.local", ".env"]) {
    const contents = yield* fs
      .readFileString(path.join(repoRoot, file))
      .pipe(Effect.orElseSucceed(() => ""));
    const match = /^\s*([A-Z0-9_]*CLERK[A-Z0-9_]*)\s*=\s*\S/m.exec(contents);
    if (match?.[1]) return { source: file, variable: match[1] };
  }

  for (const [key, value] of Object.entries({ ...process.env, ...repoEnv })) {
    if (key.includes("CLERK") && value?.trim()) return { source: "environment", variable: key };
  }

  return undefined;
});

const runBuild = Effect.fn("runBuild")(function* (options: {
  readonly version: string;
  readonly arch: string;
  readonly verbose: boolean;
  readonly managedChannel: BkManagedChannel;
}) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  // loadRepoEnv folds .env/.env.local in and normalises the Clerk aliases, the
  // same way apps/web and apps/desktop resolve them at build time.
  const repoEnv = loadRepoEnv();

  // A managed build must be KEYLESS. Identity and team capability arrive through
  // the device-bound pairing credential (see apps/web/src/fork/
  // managedPrimaryPairing.ts), not through Clerk. A publishable key is not a
  // harmless extra: apps/web/src/main.tsx mounts ElectronClerkProvider whenever
  // one is present, that provider renders nothing until Clerk's Native API
  // answers, and the result is the black-screen/auth failure this fork already
  // hit once. So the key is refused rather than warned about.
  const clerkKey = yield* resolveConflictingClerkKey(repoEnv);
  if (clerkKey) {
    return yield* new ManagedBuildClerkKeyError({
      channel: options.managedChannel,
      source: clerkKey.source,
      variable: clerkKey.variable,
    });
  }
  yield* Console.log(
    `Keyless build: identity comes from the pairing credential, not Clerk. ` +
      `This is expected for a managed ${options.managedChannel} build.`,
  );

  const buildEnv: Record<string, string | undefined> = {
    ...process.env,
    ...repoEnv,
    [DESKTOP_BRAND_ENV_VAR]: BK_DESKTOP_BRAND_ID,
    // Bakes the central server this build orchestrates into the renderer bundle,
    // and — via resolveBkDesktopVariant — selects which of the two fork apps
    // this is: bundle id, product name, user-data directory and updater channel.
    [BK_MANAGED_CHANNEL_ENV_VAR]: options.managedChannel,
    // Points electron-updater at the fork's releases instead of upstream's.
    T3CODE_DESKTOP_UPDATE_REPOSITORY: BK_DESKTOP_UPDATE_REPOSITORY,
    VITE_T3_EXPERIMENTAL_CONTROL_CENTER: "true",
    // Scrubbed, not merely omitted: `...process.env` above would otherwise carry
    // an inherited key straight into the bundle, which is exactly the accident
    // the guard above is meant to make impossible.
    VITE_CLERK_PUBLISHABLE_KEY: undefined,
    T3CODE_CLERK_PUBLISHABLE_KEY: undefined,
    CLERK_PUBLISHABLE_KEY: undefined,
  };

  const args = [
    path.join(repoRoot, "scripts/build-desktop-artifact.ts"),
    "--platform",
    "mac",
    "--target",
    "dmg",
    "--arch",
    options.arch,
    "--build-version",
    options.version,
    ...(options.verbose ? ["--verbose"] : []),
  ];

  const spawnCommand = yield* resolveSpawnCommand("node", args, { env: buildEnv });
  const child = yield* spawner.spawn(
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      cwd: repoRoot,
      env: buildEnv,
      shell: spawnCommand.shell,
    }),
  );
  const [, , exitCode] = yield* Effect.all(
    [
      forwardStream(child.stdout, process.stdout),
      forwardStream(child.stderr, process.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    return yield* new BkDesktopBuildFailedError({ exitCode });
  }
});

const command = Command.make(
  "build-bk-desktop-dmg",
  {
    buildVersion: Flag.string("build-version").pipe(
      Flag.withDescription(
        "Version to stamp, for example 0.0.32-staging-nightly.20260810.1. Must match --channel.",
      ),
      Flag.optional,
    ),
    // Required, because it now selects the app's identity as well as its
    // backend: staging builds are "BK T3 Code (Staging)" with their own bundle
    // id, user-data directory and updater channel. Leaving it implicit is how
    // you accidentally publish a local build onto the team's channel.
    channel: Flag.string("channel").pipe(
      Flag.withDescription(
        "Which fork app to build: staging (expbkt3, from expbkmain) or production " +
          "(bkt3, from bkmain).",
      ),
    ),
    arch: Flag.string("arch").pipe(
      Flag.withDescription("Target architecture (arm64 or x64)."),
      Flag.withDefault("arm64"),
    ),
    verbose: Flag.boolean("verbose").pipe(
      Flag.withDescription("Stream electron-builder output."),
      Flag.withDefault(true),
    ),
  },
  ({ buildVersion, arch, channel, verbose }) =>
    Effect.gen(function* () {
      // Channel first, so a typo is caught anywhere — including from a Linux shell,
      // where the macOS host check below would otherwise mask it.
      const requestedChannel = channel.trim().toLowerCase();
      if (!isBkManagedChannel(requestedChannel)) {
        return yield* new InvalidBkManagedChannelError({ channel: requestedChannel });
      }
      const managedChannel: BkManagedChannel = requestedChannel;
      const brand = BK_DESKTOP_BRANDS[managedChannel];

      const hostPlatform = yield* HostProcessPlatform;
      if (hostPlatform !== "darwin") {
        return yield* new UnsupportedBuildHostError({ hostPlatform });
      }

      const signingIdentity = resolveBkSigningIdentity();
      const version = yield* resolveBuildVersion(buildVersion, managedChannel);
      yield* Console.log(
        `Building ${brand.productName} ${version} (mac/${arch}, ` +
          `${signingIdentity ? `signed as "${signingIdentity}"` : "unsigned"}), ` +
          `orchestrating ${BK_MANAGED_ENVIRONMENTS[managedChannel].httpBaseUrl}...`,
      );
      if (!signingIdentity) {
        // Not fatal — an unsigned build is fine to run locally — but it cannot be
        // published, and finding that out only at the publish step wastes a
        // 10-minute build.
        yield* Console.warn(
          `WARNING: ${BK_SIGNING_IDENTITY_ENV_VAR} is not set, so this build is unsigned and ` +
            `cannot be published: Squirrel.Mac cannot install an unsigned update over a signed ` +
            `app. See docs/operations/bk-desktop-build.md.`,
        );
      }
      yield* runBuild({ version, arch, verbose, managedChannel });
      yield* Console.log(
        `Done. Artifacts are in release/ (installer, update payload, blockmaps and ` +
          `${updateManifestFileName(managedChannel)}). Publish them with:\n` +
          `  node scripts/publish-bk-desktop-dmg.ts --channel ${managedChannel} ` +
          `--build-version ${version}`,
      );
    }),
).pipe(Command.withDescription("Build the Beknown-branded macOS desktop DMG."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
