#!/usr/bin/env node

/**
 * Publishes a built Beknown desktop DMG as a GitHub prerelease teammates can
 * download, and that the in-app updater can then read.
 *
 *   node scripts/publish-bk-desktop-dmg.ts --channel staging \
 *     --build-version 0.0.32-staging-nightly.20260810.1
 *   node scripts/publish-bk-desktop-dmg.ts --channel production ... --dry-run
 *
 * Both fork apps publish into the same repository, separated only by the
 * updater channel, so every guard below is channel-aware. In order — each exists
 * because getting it wrong is expensive:
 *
 * - The tag must be nightly-form, so `.github/workflows/release.yml` cannot fire.
 *   That workflow has no dry-run mode; a wrong tag publishes `t3` to npm, cuts a
 *   public GitHub Release and re-aliases app.t3.codes.
 * - The version's channel must be the channel being published, or the other
 *   app's users get offered this build.
 * - The version must be strictly newer than the newest published one *on this
 *   channel*, or the updater will not offer it.
 * - The build must be code signed, or Squirrel.Mac cannot install it as an
 *   update over an already-installed app.
 * - `<channel>-mac.yml` must be present, or auto-update silently does nothing.
 */

import * as NodeCrypto from "node:crypto";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { BK_DESKTOP_BRANDS } from "./lib/bk-desktop-brand.ts";
import {
  BK_MANAGED_ENVIRONMENTS,
  isBkManagedChannel,
  type BkManagedChannel,
} from "./lib/bk-managed-environment.ts";
import {
  BK_DESKTOP_RELEASE_REPOSITORY,
  compareNightlyVersions,
  isNightlyReleaseAsset,
  isReleaseWorkflowSafeTag,
  parseNightlyVersion,
  resolveNewestNightlyVersion,
  tagFromVersion,
  updateManifestFileName,
} from "./lib/bk-desktop-release.ts";

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

const GhReleaseList = Schema.Array(
  Schema.Struct({ tagName: Schema.String, isDraft: Schema.Boolean }),
);
const decodeGhReleaseList = Schema.decodeUnknownEffect(Schema.fromJsonString(GhReleaseList));

const GhAssetList = Schema.Struct({
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      size: Schema.Number,
      state: Schema.String,
    }),
  ),
});
const decodeGhAssetList = Schema.decodeUnknownEffect(Schema.fromJsonString(GhAssetList));

export class GhCommandFailedError extends Schema.TaggedError<GhCommandFailedError>()(
  "GhCommandFailedError",
  {
    operation: Schema.Literals([
      "list-releases",
      "create-release",
      "view-release",
      "publish-release",
    ]),
    exitCode: Schema.Number,
    stderrTail: Schema.String,
  },
) {
  override get message(): string {
    return `gh ${this.operation} failed with exit code ${this.exitCode}: ${this.stderrTail}`;
  }
}

export class NotANightlyVersionError extends Schema.TaggedError<NotANightlyVersionError>()(
  "NotANightlyVersionError",
  {
    version: Schema.String,
  },
) {
  override get message(): string {
    return (
      `"${this.version}" is not a nightly version (expected X.Y.Z-nightly.YYYYMMDD.N). ` +
      `Only nightly versions reach the fork's updater channel.`
    );
  }
}

export class UnsafeReleaseTagError extends Schema.TaggedError<UnsafeReleaseTagError>()(
  "UnsafeReleaseTagError",
  {
    tag: Schema.String,
  },
) {
  override get message(): string {
    return (
      `Refusing to publish tag "${this.tag}". It could match the v*.*.* trigger in ` +
      `.github/workflows/release.yml, which would publish t3 to npm, cut a public GitHub ` +
      `Release and re-alias app.t3.codes. Only nightly-form tags are excluded from that trigger.`
    );
  }
}

export class ReleaseTagAlreadyExistsError extends Schema.TaggedError<ReleaseTagAlreadyExistsError>()(
  "ReleaseTagAlreadyExistsError",
  {
    tag: Schema.String,
  },
) {
  override get message(): string {
    return `Tag ${this.tag} already exists in ${BK_DESKTOP_RELEASE_REPOSITORY}.`;
  }
}

export class ReleaseVersionNotNewerError extends Schema.TaggedError<ReleaseVersionNotNewerError>()(
  "ReleaseVersionNotNewerError",
  {
    version: Schema.String,
    newestPublished: Schema.String,
  },
) {
  override get message(): string {
    return (
      `Version ${this.version} is not newer than the newest published ${this.newestPublished}. ` +
      `electron-updater would never offer it; rebuild with a higher build number.`
    );
  }
}

export class NoPublishableArtifactsError extends Schema.TaggedError<NoPublishableArtifactsError>()(
  "NoPublishableArtifactsError",
  {
    version: Schema.String,
    releaseDir: Schema.String,
  },
) {
  override get message(): string {
    return `No publishable artifacts for ${this.version} found in ${this.releaseDir}.`;
  }
}

export class MissingUpdateManifestError extends Schema.TaggedError<MissingUpdateManifestError>()(
  "MissingUpdateManifestError",
  {
    releaseDir: Schema.String,
    manifest: Schema.String,
  },
) {
  override get message(): string {
    return (
      `${this.manifest} is missing from ${this.releaseDir}. Without it auto-update ` +
      `silently does nothing. Rebuild with scripts/build-bk-desktop-dmg.ts, which configures ` +
      `the channel.`
    );
  }
}

export class InvalidSourceShaError extends Schema.TaggedError<InvalidSourceShaError>()(
  "InvalidSourceShaError",
  {
    sourceSha: Schema.String,
  },
) {
  override get message(): string {
    return (
      `--source-sha must be a full 40-character commit SHA, got "${this.sourceSha}". It is the ` +
      `release's tag target; without an exact commit the tag would point at the default branch ` +
      `while the assets contain another branch's code.`
    );
  }
}

export class MalformedUpdateManifestError extends Schema.TaggedError<MalformedUpdateManifestError>()(
  "MalformedUpdateManifestError",
  {
    manifest: Schema.String,
  },
) {
  override get message(): string {
    return `${this.manifest} has no readable url/sha512 pair; electron-updater could not use it.`;
  }
}

export class ManifestPayloadMissingError extends Schema.TaggedError<ManifestPayloadMissingError>()(
  "ManifestPayloadMissingError",
  {
    manifest: Schema.String,
    payload: Schema.String,
  },
) {
  override get message(): string {
    return (
      `${this.manifest} points at ${this.payload}, which is not in the release directory. ` +
      `Clients would download a 404 instead of an update.`
    );
  }
}

export class ManifestPayloadMismatchError extends Schema.TaggedError<ManifestPayloadMismatchError>()(
  "ManifestPayloadMismatchError",
  {
    manifest: Schema.String,
    payload: Schema.String,
    expectedSha: Schema.String,
    actualSha: Schema.String,
  },
) {
  override get message(): string {
    return (
      `${this.manifest} records a different sha512 than ${this.payload} actually has ` +
      `(expected ${this.expectedSha.slice(0, 16)}…, got ${this.actualSha.slice(0, 16)}…). ` +
      `electron-updater verifies this and discards the payload, so every client would download ` +
      `the update and silently refuse it. Usually a stale manifest from an earlier build — ` +
      `clear release/ and rebuild.`
    );
  }
}

export class IncompleteReleaseUploadError extends Schema.TaggedError<IncompleteReleaseUploadError>()(
  "IncompleteReleaseUploadError",
  {
    tag: Schema.String,
    asset: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return (
      `Draft ${this.tag} is missing or truncated: ${this.asset} (${this.detail}). The draft has ` +
      `been left unpublished, so no client can see it. Delete it and re-run.`
    );
  }
}

export class StaleDraftCleanupError extends Schema.TaggedError<StaleDraftCleanupError>()(
  "StaleDraftCleanupError",
  {
    tag: Schema.String,
    stderrTail: Schema.String,
  },
) {
  override get message(): string {
    return (
      `Could not remove the stale draft ${this.tag} left by an earlier failed publish: ` +
      `${this.stderrTail}. Delete it by hand with \`gh release delete ${this.tag} --yes\`; ` +
      `until it is gone this channel cannot publish.`
    );
  }
}

export class InvalidPublishChannelError extends Schema.TaggedError<InvalidPublishChannelError>()(
  "InvalidPublishChannelError",
  {
    channel: Schema.String,
  },
) {
  override get message(): string {
    return `--channel must be staging or production, got "${this.channel}".`;
  }
}

export class PublishChannelMismatchError extends Schema.TaggedError<PublishChannelMismatchError>()(
  "PublishChannelMismatchError",
  {
    version: Schema.String,
    channel: Schema.String,
    versionChannel: Schema.String,
  },
) {
  override get message(): string {
    return (
      `${this.version} is a ${this.versionChannel} build, but --channel is ${this.channel}. ` +
      `Publishing it would attach ${this.versionChannel} artifacts to the ${this.channel} ` +
      `channel, and the wrong app's users would be offered it.`
    );
  }
}

export class UnsignedBuildError extends Schema.TaggedError<UnsignedBuildError>()(
  "UnsignedBuildError",
  {
    appPath: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return (
      `${this.appPath} is not code signed (${this.detail}). Squirrel.Mac validates an update ` +
      `against the installed app's designated requirement, so publishing this would break ` +
      `auto-update for everyone already on this channel. Rebuild with ` +
      `T3CODE_BK_SIGNING_IDENTITY set; see docs/operations/bk-desktop-build.md.`
    );
  }
}

export class BuiltAppNotFoundError extends Schema.TaggedError<BuiltAppNotFoundError>()(
  "BuiltAppNotFoundError",
  {
    releaseDir: Schema.String,
  },
) {
  override get message(): string {
    return (
      `Could not extract a signed .app from the update ZIP in ${this.releaseDir}. ` +
      `That ZIP is the Squirrel.Mac payload, so without it there is nothing to verify ` +
      `and nothing worth publishing — rebuild with scripts/build-bk-desktop-dmg.ts.`
    );
  }
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (accumulator, chunk) => accumulator + chunk,
    ),
  );

const runCommand = Effect.fn("runCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawnCommand = yield* resolveSpawnCommand(command, [...args], { env: process.env });
  const child = yield* spawner.spawn(
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: process.env,
      shell: spawnCommand.shell,
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
});

const runGh = (args: ReadonlyArray<string>) => runCommand("gh", args);

/** How many change lines a release body carries before it summarises the rest. */
const CHANGELOG_LIMIT = 15;

/**
 * Turns commit subjects into the short "what changed" list a release body wants.
 *
 * Merge commits are dropped: on this fork every change arrives through a merge,
 * so keeping them would list each change twice — once as "Merge pull request
 * #N", once as the work itself. The conventional-commit prefix is kept because
 * it is the fastest way to see whether a build is a fix or a feature.
 */
export function summarizeCommitSubjects(
  messages: ReadonlyArray<string>,
  limit: number = CHANGELOG_LIMIT,
): ReadonlyArray<string> {
  const subjects = messages
    .map((message) => message.split("\n", 1)[0]?.trim() ?? "")
    .filter((subject) => subject.length > 0 && !subject.startsWith("Merge "));
  const unique = [...new Set(subjects)];
  if (unique.length <= limit) return unique;
  return [...unique.slice(0, limit), `…and ${unique.length - limit} more commits.`];
}

/**
 * The newest published tag belonging to one channel.
 *
 * Keyed on the channel — `staging` / `production` — and not on the brand's
 * `updateChannel`, which is already `staging-nightly`; matching on that produced
 * `-staging-nightly-nightly.`, found nothing, and silently shipped a release with
 * no change list. Same predicate the workflow's already-published check uses.
 *
 * `gh release list` returns newest first, so the first hit is the previous build.
 */
export function findPreviousChannelTag(
  publishedTags: ReadonlyArray<string>,
  variant: BkManagedChannel,
): string | undefined {
  return publishedTags.find((candidate) => candidate.includes(`-${variant}-nightly.`));
}

const GhCompare = Schema.Struct({
  commits: Schema.Array(Schema.Struct({ commit: Schema.Struct({ message: Schema.String }) })),
});
const decodeGhCompare = Schema.decodeUnknownEffect(Schema.fromJsonString(GhCompare));

const GhReleaseTarget = Schema.Struct({ targetCommitish: Schema.String });
const decodeGhReleaseTarget = Schema.decodeUnknownEffect(Schema.fromJsonString(GhReleaseTarget));

/**
 * The commits between the previous build of this channel and this one.
 *
 * Resolved through the compare API rather than `git log` because the publish job
 * checks out at depth 1 and has no history to walk.
 *
 * Never fails the publish. A release that ships without its change list is a
 * cosmetic loss; a release that does not ship because the notes could not be
 * assembled is an outage of the update channel.
 */
const collectChangelog = Effect.fn("collectChangelog")(function* (
  previousTag: string | undefined,
  targetSha: string,
) {
  if (previousTag === undefined) return [] as ReadonlyArray<string>;

  const viewed = yield* runGh([
    "release",
    "view",
    previousTag,
    "--repo",
    BK_DESKTOP_RELEASE_REPOSITORY,
    "--json",
    "targetCommitish",
  ]);
  if (viewed.exitCode !== 0) return [] as ReadonlyArray<string>;

  const target = yield* decodeGhReleaseTarget(viewed.stdout).pipe(Effect.orElseSucceed(() => null));
  const previousSha = target?.targetCommitish;
  if (!previousSha || previousSha === targetSha) return [] as ReadonlyArray<string>;

  const compared = yield* runGh([
    "api",
    `repos/${BK_DESKTOP_RELEASE_REPOSITORY}/compare/${previousSha}...${targetSha}`,
  ]);
  if (compared.exitCode !== 0) return [] as ReadonlyArray<string>;

  const parsed = yield* decodeGhCompare(compared.stdout).pipe(Effect.orElseSucceed(() => null));
  if (parsed === null) return [] as ReadonlyArray<string>;

  return summarizeCommitSubjects(parsed.commits.map((entry) => entry.commit.message));
});

const listPublishedTags = Effect.fn("listPublishedTags")(function* () {
  const result = yield* runGh([
    "release",
    "list",
    "--repo",
    BK_DESKTOP_RELEASE_REPOSITORY,
    "--limit",
    "100",
    "--json",
    "tagName,isDraft",
  ]);
  if (result.exitCode !== 0) {
    return yield* new GhCommandFailedError({
      operation: "list-releases",
      exitCode: result.exitCode,
      stderrTail: result.stderr.trim(),
    });
  }

  return yield* decodeGhReleaseList(result.stdout);
});

const collectAssets = Effect.fn("collectAssets")(function* (
  releaseDir: string,
  version: string,
  variant: BkManagedChannel,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = updateManifestFileName(variant);

  // A missing directory is the ordinary "you have not built yet" case, so it
  // becomes an empty asset list and the caller's actionable error, not an ENOENT.
  const entries = yield* fs.readDirectory(releaseDir).pipe(Effect.orElseSucceed(() => []));
  const assets: string[] = [];
  for (const entry of entries) {
    if (!isNightlyReleaseAsset(entry, variant)) continue;
    // Guard against stale artifacts from an earlier build sharing the directory —
    // including a build of the *other* fork app, whose manifest sits right beside
    // this one's. The manifest is exempt from the version check because
    // electron-builder names it by channel, not version, so it is matched by its
    // exact channel-specific name instead.
    if (entry !== manifest && !entry.includes(version)) continue;
    const stat = yield* fs
      .stat(path.join(releaseDir, entry))
      .pipe(Effect.orElseSucceed(() => null));
    if (!stat || stat.type !== "File") continue;
    assets.push(path.join(releaseDir, entry));
  }
  return assets;
});

/**
 * Refuses to publish an unsigned build, checking the ZIP rather than the
 * packaged directory beside it.
 *
 * This is the guard that keeps auto-update working: an unsigned app has no
 * designated requirement, so Squirrel.Mac cannot validate an update against it —
 * the download succeeds, the install silently does not, and the only symptom is
 * teammates quietly staying on an old version.
 *
 * The **ZIP** is the right thing to check, for two independent reasons. It is
 * what Squirrel.Mac actually consumes (the DMG is only for first install), so it
 * is the artifact whose signature has to be good. And it is the only one that
 * survives CI: `actions/upload-artifact` re-zips its payload, which does not
 * preserve a `.app` bundle's symlinks and executable bits, so a packaged
 * directory handed between jobs would fail verification for reasons that have
 * nothing to do with signing.
 *
 * Extraction uses `ditto`, not `unzip`, because only `ditto` restores the
 * bundle's macOS metadata faithfully enough for `codesign` to agree with it.
 */
const assertSignedBuild = Effect.fn("assertSignedBuild")(function* (
  releaseDir: string,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const entries = yield* fs.readDirectory(releaseDir).pipe(Effect.orElseSucceed(() => []));
  const zipName = entries.find((entry) => entry.endsWith(".zip") && entry.includes(version));
  if (!zipName) {
    return yield* new BuiltAppNotFoundError({ releaseDir });
  }

  const extractedDir = yield* fs.makeTempDirectoryScoped();
  const extracted = yield* runCommand("ditto", [
    "-x",
    "-k",
    path.join(releaseDir, zipName),
    extractedDir,
  ]);
  if (extracted.exitCode !== 0) {
    return yield* new BuiltAppNotFoundError({ releaseDir });
  }

  const unpacked = yield* fs.readDirectory(extractedDir).pipe(Effect.orElseSucceed(() => []));
  const appName = unpacked.find((entry) => entry.endsWith(".app"));
  if (!appName) {
    return yield* new BuiltAppNotFoundError({ releaseDir });
  }
  const appPath = path.join(extractedDir, appName);

  const result = yield* runCommand("codesign", ["--verify", "--deep", "--strict", appPath]);
  if (result.exitCode !== 0) {
    return yield* new UnsignedBuildError({
      appPath: zipName,
      detail: result.stderr.trim().split("\n").at(-1) ?? `codesign exited ${result.exitCode}`,
    });
  }
  return appPath;
});

/**
 * Stable, non-identifying fingerprint of a designated requirement.
 *
 * Normalises away the `Executable=` suffix `codesign -dr -` appends, which is
 * the build machine's temp path and differs on every run — including it would
 * make two identical identities look different, and leak a runner path.
 */
export function fingerprintDesignatedRequirement(requirement: string): string {
  const withoutExecutable = requirement.split(/\s*Executable=/)[0]?.trim() ?? requirement.trim();
  return NodeCrypto.createHash("sha256").update(withoutExecutable).digest("hex").slice(0, 16);
}

/**
 * Fingerprints the designated requirement, for the release notes.
 *
 * The *requirement* is the load-bearing value, not the CDHash: Squirrel.Mac
 * validates an update by checking it satisfies the installed app's designated
 * requirement. So when an update refuses to install, "did this change between
 * builds?" is the first question, and the answer belongs in the release rather
 * than only on somebody's laptop.
 *
 * Deliberately not `CDHash`, which `codesign -dv` also prints: that is a hash of
 * the code directory and changes with every build, so recording it as though it
 * identified the certificate would mislead exactly when it matters.
 *
 * Published as a HASH, never the raw string. This repository is public, and an
 * Apple-issued certificate embeds the developer's email and Team ID in its
 * common name — which the raw requirement would then publish on every release.
 * A hash answers "did the signing identity change?" without putting personal
 * data in a public place. The raw string is still one `codesign -dr -` away for
 * anyone actually debugging an install.
 */
const describeSignature = Effect.fn("describeSignature")(function* (appPath: string) {
  const requirement = yield* runCommand("codesign", ["-dr", "-", appPath]);
  const designated =
    /designated\s*=>\s*(.+)/s
      .exec(`${requirement.stdout}\n${requirement.stderr}`)?.[1]
      ?.trim()
      .replace(/\s+/g, " ") ?? "unknown";

  return { fingerprint: fingerprintDesignatedRequirement(designated) };
});

/**
 * Confirms the channel manifest describes the ZIP sitting next to it.
 *
 * electron-updater verifies the downloaded payload's sha512 against the
 * manifest and discards it on mismatch — silently, from the user's point of
 * view. That happens when a stale manifest from an earlier build survives in
 * `release/`, which is exactly the state a rebuilt-but-not-cleaned directory is
 * in.
 */
const assertManifestMatchesPayload = Effect.fn("assertManifestMatchesPayload")(function* (
  releaseDir: string,
  manifest: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const manifestText = yield* fs.readFileString(path.join(releaseDir, manifest));
  const referencedZip = /url:\s*(\S+\.zip)\s*$/m.exec(manifestText)?.[1];
  const expectedSha = /sha512:\s*(\S+)\s*$/m.exec(manifestText)?.[1];
  if (!referencedZip || !expectedSha) {
    return yield* new MalformedUpdateManifestError({ manifest });
  }

  const zipPath = path.join(releaseDir, decodeURIComponent(referencedZip));
  if (!(yield* fs.exists(zipPath))) {
    return yield* new ManifestPayloadMissingError({ manifest, payload: referencedZip });
  }

  const zipBytes = yield* fs.readFile(zipPath);
  const actualSha = NodeCrypto.createHash("sha512").update(zipBytes).digest("base64");
  if (actualSha !== expectedSha) {
    return yield* new ManifestPayloadMismatchError({
      manifest,
      payload: referencedZip,
      expectedSha,
      actualSha,
    });
  }
});

/**
 * Confirms the draft holds every asset, at the size it has on disk.
 *
 * A truncated upload still produces an asset entry, so presence alone is not
 * enough — size is what distinguishes "uploaded" from "partly uploaded".
 */
const assertDraftAssetsComplete = Effect.fn("assertDraftAssetsComplete")(function* (
  tag: string,
  assets: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const result = yield* runGh([
    "release",
    "view",
    tag,
    "--repo",
    BK_DESKTOP_RELEASE_REPOSITORY,
    "--json",
    "assets",
  ]);
  if (result.exitCode !== 0) {
    return yield* new GhCommandFailedError({
      operation: "view-release",
      exitCode: result.exitCode,
      stderrTail: result.stderr.trim(),
    });
  }

  const uploaded = yield* decodeGhAssetList(result.stdout);
  const byName = new Map(uploaded.assets.map((asset) => [asset.name, asset]));
  for (const asset of assets) {
    const name = path.basename(asset);
    const remote = byName.get(name);
    if (!remote) {
      return yield* new IncompleteReleaseUploadError({ tag, asset: name, detail: "missing" });
    }
    const stat = yield* fs.stat(asset);
    const localSize = Number(stat.size);
    if (remote.size !== localSize) {
      return yield* new IncompleteReleaseUploadError({
        tag,
        asset: name,
        detail: `uploaded ${remote.size} bytes, expected ${localSize}`,
      });
    }
    if (remote.state !== "uploaded") {
      return yield* new IncompleteReleaseUploadError({
        tag,
        asset: name,
        detail: `state is "${remote.state}"`,
      });
    }
  }
});

const command = Command.make(
  "publish-bk-desktop-dmg",
  {
    buildVersion: Flag.string("build-version").pipe(
      Flag.withDescription(
        "Version that was built, for example 0.0.32-staging-nightly.20260810.1.",
      ),
    ),
    channel: Flag.string("channel").pipe(
      Flag.withDescription(
        "Which fork app is being published: staging or production. Must match the version.",
      ),
    ),
    // Required. Without --target, `gh release create` tags the repository's
    // DEFAULT branch, so the tag would point at `main` while the assets contain
    // expbkmain code — a release that lies about what is inside it.
    sourceSha: Flag.string("source-sha").pipe(
      Flag.withDescription(
        "Full commit SHA the artifacts were built from. In Actions, ${{ github.sha }}.",
      ),
    ),
    releaseDir: Flag.string("release-dir").pipe(
      Flag.withDescription("Directory holding the built artifacts."),
      Flag.withDefault("release"),
    ),
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Run every check and print the gh command without publishing."),
      Flag.withDefault(false),
    ),
  },
  ({ buildVersion, channel, sourceSha, releaseDir, dryRun }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = yield* RepoRoot;
      const version = buildVersion.trim();
      const tag = tagFromVersion(version);

      const targetSha = sourceSha.trim().toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(targetSha)) {
        return yield* new InvalidSourceShaError({ sourceSha });
      }

      const requestedChannel = channel.trim().toLowerCase();
      if (!isBkManagedChannel(requestedChannel)) {
        return yield* new InvalidPublishChannelError({ channel: requestedChannel });
      }
      const variant: BkManagedChannel = requestedChannel;
      const brand = BK_DESKTOP_BRANDS[variant];
      const manifest = updateManifestFileName(variant);

      const parsed = parseNightlyVersion(version);
      if (!parsed) {
        return yield* new NotANightlyVersionError({ version });
      }

      // Guard 1: the tag must not be able to trigger release.yml.
      if (!isReleaseWorkflowSafeTag(tag)) {
        return yield* new UnsafeReleaseTagError({ tag });
      }

      // Guard 2: the version's channel decides which app picks this up, so it
      // has to be the channel being published.
      if (parsed.variant !== variant) {
        return yield* new PublishChannelMismatchError({
          version,
          channel: variant,
          versionChannel: parsed.variant,
        });
      }

      const releases = yield* listPublishedTags();
      const existing = releases.find((release) => release.tagName.trim() === tag);
      if (existing && !existing.isDraft) {
        return yield* new ReleaseTagAlreadyExistsError({ tag });
      }
      if (existing?.isDraft) {
        // A draft holding this tag is the wreckage of an earlier failed publish,
        // not a real release: drafts create no git tag, and nothing has ever been
        // visible to a client. Left alone it wedges the channel permanently,
        // because the version resolver in the build job runs with `contents: read`
        // and GitHub hides drafts from callers without push access — so it keeps
        // handing out this same version, and this guard keeps rejecting it.
        // Clear it and continue; the assets are re-uploaded below either way.
        yield* Console.log(`Removing a stale draft left by an earlier failed publish: ${tag}`);
        const removed = yield* runGh([
          "release",
          "delete",
          tag,
          "--repo",
          BK_DESKTOP_RELEASE_REPOSITORY,
          "--yes",
        ]);
        if (removed.exitCode !== 0) {
          return yield* new StaleDraftCleanupError({
            tag,
            stderrTail: removed.stderr.trim() || removed.stdout.trim(),
          });
        }
      }

      const publishedTags = releases
        .filter((release) => !release.isDraft)
        .map((release) => release.tagName);

      // Guard 3: the version must be strictly newer *within its own channel*, or
      // the updater ignores it. The other app's releases are irrelevant here.
      const newest = resolveNewestNightlyVersion(publishedTags, variant);
      // The most recent published build of *this* channel is what the reader is
      // upgrading from, so it is the right base for "what changed".
      const previousTag = findPreviousChannelTag(publishedTags, variant);
      if (newest && compareNightlyVersions(parsed, newest) <= 0) {
        return yield* new ReleaseVersionNotNewerError({
          version,
          newestPublished: `${newest.baseVersion}-${brand.updateChannel}.${newest.date}.${newest.counter}`,
        });
      }

      const resolvedReleaseDir = path.resolve(repoRoot, releaseDir);

      // Guard 4: an unsigned build cannot be installed as an update.
      const signedAppPath = yield* assertSignedBuild(resolvedReleaseDir, version);

      const assets = yield* collectAssets(resolvedReleaseDir, version, variant);
      if (assets.length === 0) {
        return yield* new NoPublishableArtifactsError({
          version,
          releaseDir: resolvedReleaseDir,
        });
      }

      // Guard 5: without the manifest, the app can never see the update.
      if (!assets.some((asset) => path.basename(asset) === manifest)) {
        return yield* new MissingUpdateManifestError({
          releaseDir: resolvedReleaseDir,
          manifest,
        });
      }

      // Guard 6: the manifest must describe the ZIP we are about to upload. A
      // mismatched sha512 means every client downloads the payload and then
      // rejects it, which looks exactly like "auto-update is broken".
      yield* assertManifestMatchesPayload(resolvedReleaseDir, manifest);

      const signature = yield* describeSignature(signedAppPath);
      const sourceBranch = variant === "staging" ? "expbkmain" : "bkmain";
      const changelog = yield* collectChangelog(previousTag, targetSha);
      const notes = [
        `Beknown fork desktop build — **${brand.productName}**.`,
        ``,
        ...(changelog.length > 0
          ? [`**What changed**`, ``, ...changelog.map((line) => `- ${line}`), ``]
          : []),
        `| | |`,
        `|---|---|`,
        `| Source branch | \`${sourceBranch}\` |`,
        `| Commit | \`${targetSha}\` |`,
        `| Managed server | ${BK_MANAGED_ENVIRONMENTS[variant].httpBaseUrl} |`,
        `| Bundle id | \`${brand.appId}\` |`,
        `| Updater channel | \`${brand.updateChannel}\` |`,
        `| Architecture | arm64 (Apple Silicon) |`,
        `| Signing identity | \`${signature.fingerprint}\` (designated-requirement fingerprint) |`,
        ``,
        `Keyless build: identity comes from the device-bound pairing credential, not Clerk.`,
        ``,
        `Code signed but not notarised, so macOS quarantines it on first install:`,
        ``,
        "```sh",
        `xattr -dr com.apple.quarantine "/Applications/${brand.productName}.app"`,
        "```",
        ``,
        `Later builds arrive through the in-app updater, which notifies you when one is ready.`,
      ].join("\n");

      yield* Console.log(`Signature verified (identity fingerprint ${signature.fingerprint}).`);
      yield* Console.log(`Assets (${assets.length}):`);
      for (const asset of assets) {
        yield* Console.log(`  ${path.basename(asset)}`);
      }

      if (dryRun) {
        yield* Console.log(`\nDry run — would publish prerelease ${tag} targeting ${targetSha}.`);
        return;
      }

      // Published in three steps so a partial upload is never visible.
      //
      // `gh release create --prerelease <assets>` uploads assets *after* the
      // release exists, so a client polling the feed can see the release before
      // its manifest or ZIP is there and get a 404 mid-update. A draft is not
      // in the feed at all, so the window closes.
      yield* Console.log(`Creating draft ${tag} at ${targetSha}...`);
      const created = yield* runGh([
        "release",
        "create",
        tag,
        "--repo",
        BK_DESKTOP_RELEASE_REPOSITORY,
        "--draft",
        // Without this the tag is cut from the default branch, not the commit
        // these artifacts were built from.
        "--target",
        targetSha,
        "--title",
        `${brand.productName} ${version}`,
        "--notes",
        notes,
        ...assets,
      ]);
      if (created.exitCode !== 0) {
        return yield* new GhCommandFailedError({
          operation: "create-release",
          exitCode: created.exitCode,
          stderrTail: created.stderr.trim() || created.stdout.trim(),
        });
      }

      yield* assertDraftAssetsComplete(tag, assets);

      yield* Console.log(`Draft verified. Publishing ${tag}...`);
      const published = yield* runGh([
        "release",
        "edit",
        tag,
        "--repo",
        BK_DESKTOP_RELEASE_REPOSITORY,
        "--draft=false",
        "--prerelease",
      ]);
      if (published.exitCode !== 0) {
        return yield* new GhCommandFailedError({
          operation: "publish-release",
          exitCode: published.exitCode,
          stderrTail: published.stderr.trim() || published.stdout.trim(),
        });
      }

      yield* Console.log(published.stdout.trim());
      yield* Console.log(
        `\nPublished prerelease ${tag} at ${targetSha}. Confirm release.yml did not run:\n` +
          `  gh run list --repo ${BK_DESKTOP_RELEASE_REPOSITORY} --workflow release.yml -L 3`,
      );
    }),
).pipe(Command.withDescription("Publish the Beknown desktop DMG as a GitHub prerelease."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
