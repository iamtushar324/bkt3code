#!/usr/bin/env node

/**
 * T3-CUSTOM(expbkt3): Builds a sideloadable Beknown mobile artifact.
 *
 *   node scripts/build-bk-mobile.ts --platform android   # -> release APK
 *   node scripts/build-bk-mobile.ts --platform ios       # -> UNSIGNED .ipa
 *
 * Both platforms are sideloaded, never store-distributed. The Android APK is
 * signed with the fork keystore (see plugins/withBkAndroidReleaseSigning.cjs)
 * so it upgrades in place; the iOS .ipa ships unsigned and is re-signed on the
 * device by SideStore with the user's free Apple ID.
 *
 * The iOS half must run on macOS. CI does it on a GitHub-hosted macOS runner;
 * the same command is the documented fallback for a real Mac.
 *
 * See docs/operations/bk-mobile-build.md.
 */
// @effect-diagnostics nodeBuiltinImport:off - a build wrapper, not app code.
// @effect-diagnostics globalConsole:off - plain CLI output, no Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  bkAppVersionString,
  bkArtifactFileName,
  bkBuildEnv,
  BK_MOBILE_APP_NAME,
  parseMobileAppVersion,
  type BkMobilePlatform,
} from "./lib/bk-mobile.ts";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const MOBILE_ROOT = NodePath.join(REPO_ROOT, "apps", "mobile");
const DEFAULT_OUTPUT_DIR = NodePath.join(REPO_ROOT, "release", "mobile");

interface Options {
  readonly platform: BkMobilePlatform;
  readonly outputDir: string;
}

export function parseArgs(argv: ReadonlyArray<string>): Options {
  let platform: BkMobilePlatform | null = null;
  let outputDir = DEFAULT_OUTPUT_DIR;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--platform") {
      const value = argv[index + 1];
      if (value !== "android" && value !== "ios") {
        throw new Error(`--platform must be "android" or "ios" (received "${value ?? ""}").`);
      }
      platform = value;
      index += 1;
      continue;
    }
    if (arg === "--output-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--output-dir needs a path.");
      outputDir = NodePath.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument "${arg}".`);
  }

  if (platform === null) {
    throw new Error("--platform is required: android or ios.");
  }
  return { platform, outputDir };
}

/**
 * BK builds must be keyless. A Clerk publishable key makes the app mount the
 * hosted-auth provider, which renders nothing until Clerk answers — identity
 * on this fleet comes from the device-bound pairing credential instead. This
 * mirrors the guard in build-bk-desktop-dmg.ts and the desktop workflow.
 */
export function assertKeylessBuild(
  env: Record<string, string | undefined>,
  dotenvContents: ReadonlyArray<string>,
): void {
  for (const contents of dotenvContents) {
    if (/^\s*[A-Z0-9_]*CLERK/m.test(contents)) {
      throw new Error("A dotenv file sets a Clerk variable. BK mobile builds must be keyless.");
    }
  }
  const offender = Object.keys(env).find((key) => /^[A-Z0-9_]*CLERK[A-Z0-9_]*$/.test(key));
  if (offender !== undefined) {
    throw new Error(`${offender} is set. BK mobile builds must be keyless.`);
  }
}

function run(command: string, args: ReadonlyArray<string>, cwd: string, env: NodeJS.ProcessEnv) {
  console.log(`\n$ ${command} ${args.join(" ")}  (in ${NodePath.relative(REPO_ROOT, cwd) || "."})`);
  const result = NodeChildProcess.spawnSync(command, [...args], {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? "a signal"}.`);
  }
}

function readMobileAppVersion(): string {
  return parseMobileAppVersion(
    NodeFS.readFileSync(NodePath.join(MOBILE_ROOT, "app-version.ts"), "utf8"),
  );
}

function readDotenvFiles(): ReadonlyArray<string> {
  return [".env", ".env.local"]
    .map((name) => NodePath.join(REPO_ROOT, name))
    .filter((path) => NodeFS.existsSync(path))
    .map((path) => NodeFS.readFileSync(path, "utf8"));
}

function resolveGitSha(): string {
  const fromEnv = process.env.BK_GIT_SHA?.trim();
  if (fromEnv) return fromEnv;
  return NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
}

/** The Xcode scheme prebuild generates, derived from the Expo app name. */
export function xcodeSchemeName(appName: string): string {
  return appName.replace(/[^A-Za-z0-9]/g, "");
}

function buildAndroid(env: NodeJS.ProcessEnv, outputPath: string): void {
  run(
    NodePath.join(MOBILE_ROOT, "node_modules", ".bin", "expo"),
    ["prebuild", "--clean", "--platform", "android"],
    MOBILE_ROOT,
    env,
  );

  if (!process.env.BK_ANDROID_KEYSTORE_PATH) {
    console.warn(
      "\n::warning:: BK_ANDROID_KEYSTORE_PATH is unset, so this APK is signed with Expo's " +
        "shared debug keystore. It installs, but it cannot upgrade a properly signed BK build " +
        "in place. Do not distribute it.",
    );
  }

  const androidRoot = NodePath.join(MOBILE_ROOT, "android");
  run("./gradlew", [":app:assembleRelease", "--no-daemon"], androidRoot, env);

  const apk = NodePath.join(
    androidRoot,
    "app",
    "build",
    "outputs",
    "apk",
    "release",
    "app-release.apk",
  );
  if (!NodeFS.existsSync(apk)) {
    throw new Error(`Gradle finished but ${apk} does not exist.`);
  }
  NodeFS.copyFileSync(apk, outputPath);
}

function buildIos(env: NodeJS.ProcessEnv, outputPath: string): void {
  // A plain build wrapper: no Effect runtime to inject HostProcessPlatform from.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- see above.
  const hostPlatform = NodeOS.platform();
  if (hostPlatform !== "darwin") {
    throw new Error(
      `An iOS archive can only be built on macOS (host is "${hostPlatform}"). ` +
        "CI builds this on a GitHub-hosted macOS runner; see docs/operations/bk-mobile-build.md.",
    );
  }

  run(
    NodePath.join(MOBILE_ROOT, "node_modules", ".bin", "expo"),
    ["prebuild", "--clean", "--platform", "ios"],
    MOBILE_ROOT,
    env,
  );

  const iosRoot = NodePath.join(MOBILE_ROOT, "ios");
  const scheme = xcodeSchemeName(BK_MOBILE_APP_NAME);
  let workspace = NodePath.join(iosRoot, `${scheme}.xcworkspace`);
  if (!NodeFS.existsSync(workspace)) {
    // The scheme is derived from the Expo app name by Expo's own sanitiser, so
    // a change to either can drift. Recover when the answer is unambiguous
    // rather than failing a 40-minute build on a naming detail.
    const found = NodeFS.readdirSync(iosRoot).filter((entry) => entry.endsWith(".xcworkspace"));
    if (found.length !== 1) {
      throw new Error(
        `Expected ${scheme}.xcworkspace after prebuild; found ${found.join(", ") || "none"}.`,
      );
    }
    workspace = NodePath.join(iosRoot, found[0]!);
    console.warn(`::warning:: Using ${found[0]} instead of the expected ${scheme}.xcworkspace.`);
  }
  const resolvedScheme = NodePath.basename(workspace, ".xcworkspace");

  const stagingDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bk-ipa-"));
  const archivePath = NodePath.join(stagingDir, "bk.xcarchive");

  // Unsigned on purpose: SideStore re-signs on the device with the user's own
  // free Apple ID, and a signature applied here would only be stripped.
  run(
    "xcodebuild",
    [
      "archive",
      "-workspace",
      workspace,
      "-scheme",
      resolvedScheme,
      "-configuration",
      "Release",
      "-destination",
      "generic/platform=iOS",
      "-archivePath",
      archivePath,
      "CODE_SIGNING_ALLOWED=NO",
      "CODE_SIGNING_REQUIRED=NO",
      "CODE_SIGN_IDENTITY=",
      "EXPANDED_CODE_SIGN_IDENTITY=",
    ],
    iosRoot,
    env,
  );

  const productsDir = NodePath.join(archivePath, "Products", "Applications");
  const apps = NodeFS.readdirSync(productsDir).filter((entry) => entry.endsWith(".app"));
  if (apps.length !== 1) {
    throw new Error(`Expected exactly one .app in the archive, found ${apps.length}.`);
  }

  const payloadDir = NodePath.join(stagingDir, "Payload");
  NodeFS.mkdirSync(payloadDir, { recursive: true });
  // `cp -R` rather than fs.cpSync: an .app is a bundle with symlinks and
  // executable bits that Node's copy does not reliably preserve.
  run("cp", ["-R", NodePath.join(productsDir, apps[0]!), payloadDir], stagingDir, env);
  run("zip", ["-qry", outputPath, "Payload"], stagingDir, env);
  NodeFS.rmSync(stagingDir, { recursive: true, force: true });
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  assertKeylessBuild(process.env, readDotenvFiles());

  const gitSha = resolveGitSha();
  const env: NodeJS.ProcessEnv = { ...process.env, ...bkBuildEnv(gitSha) };

  const baseVersion = readMobileAppVersion();
  NodeFS.mkdirSync(options.outputDir, { recursive: true });
  const outputPath = NodePath.join(
    options.outputDir,
    bkArtifactFileName(options.platform, baseVersion, gitSha),
  );

  console.log(
    `Building ${BK_MOBILE_APP_NAME} ${bkAppVersionString(baseVersion, gitSha)} ` +
      `for ${options.platform}.`,
  );

  if (options.platform === "android") buildAndroid(env, outputPath);
  else buildIos(env, outputPath);

  console.log(`\nArtifact: ${outputPath}`);
  if (process.env.GITHUB_OUTPUT) {
    NodeFS.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `artifact-path=${outputPath}\nartifact-name=${NodePath.basename(outputPath)}\n` +
        `artifact-version=${bkAppVersionString(baseVersion, gitSha)}\n`,
    );
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
