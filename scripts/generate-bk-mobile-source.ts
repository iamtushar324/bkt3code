#!/usr/bin/env node

/**
 * T3-CUSTOM(expbkt3): Generates the AltSource document SideStore consumes.
 *
 * This runs in the secretless iOS build job, beside the IPA it describes. The
 * write-token jobs only publish the resulting JSON onto GitHub releases; they
 * never execute branch code while holding contents:write.
 */
// @effect-diagnostics nodeBuiltinImport:off - a release artifact generator, not app runtime code.
// @effect-diagnostics globalConsole:off - plain CLI output, no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  bkMarketingVersion,
  bkArtifactFileName,
  bkReleaseTag,
  BK_MOBILE_APP_NAME,
  BK_MOBILE_BUNDLE_IDENTIFIER,
} from "./lib/bk-mobile.ts";

const SUPPORTED_BRANCHES = ["expbkmain", "bkmain"] as const;
type BkMobileReleaseBranch = (typeof SUPPORTED_BRANCHES)[number];

export interface BkMobileSourceInput {
  readonly branch: BkMobileReleaseBranch;
  readonly repository: string;
  readonly version: string;
  readonly gitSha: string;
  readonly buildNumber: string;
  readonly date: string;
  readonly ipaSize: number;
  readonly ipaSha256: string;
}

interface CliOptions extends Omit<BkMobileSourceInput, "ipaSize" | "ipaSha256"> {
  readonly ipaPath: string;
  readonly outputPath: string;
}

function sourceAssetName(branch: BkMobileReleaseBranch): string {
  return `bk-mobile-${branch}.json`;
}

function sourceReleaseTag(branch: BkMobileReleaseBranch): string {
  return `bk-mobile-source-${branch}`;
}

export function createBkMobileSource(input: BkMobileSourceInput) {
  const shortSha = input.gitSha.slice(0, 7);
  const releaseTag = bkReleaseTag(input.version, input.gitSha);
  const ipaName = bkArtifactFileName("ios", input.version, input.gitSha);
  const releaseRoot = `https://github.com/${input.repository}/releases/download`;
  const iconURL =
    `https://raw.githubusercontent.com/${input.repository}/${input.gitSha}/` +
    "assets/bk/bk-universal-1024.png";
  const downloadURL = `${releaseRoot}/${releaseTag}/${ipaName}`;
  const sourceURL = `${releaseRoot}/${sourceReleaseTag(input.branch)}/${sourceAssetName(input.branch)}`;
  const description =
    `Build ${shortSha} from ${input.branch}. ` +
    "Install the build whose SHA matches the running T3 server.";

  return {
    name: `BK T3 Code · ${input.branch}`,
    identifier: `work.beknown.bkt3code.mobile.source.${input.branch}`,
    subtitle: `SideStore updates built from ${input.branch}`,
    description:
      "Sideloaded BK T3 Code builds published by the Beknown fork's mobile release workflow.",
    sourceURL,
    iconURL,
    website: `https://github.com/${input.repository}`,
    news: [],
    apps: [
      {
        name: BK_MOBILE_APP_NAME,
        bundleIdentifier: BK_MOBILE_BUNDLE_IDENTIFIER,
        developerName: "Beknown",
        subtitle: `Mobile client for the ${input.branch} environment`,
        localizedDescription:
          "A sideloadable T3 Code client built for Beknown. SideStore re-signs each update " +
          "with your Apple Account.",
        iconURL,
        tintColor: "#000000",
        category: "developer",
        // Keep the legacy single-version fields for older SideStore releases.
        // `version` is the IPA's marketing version, base plus run number, so it
        // matches what SideStore reads back from the installed bundle.
        version: bkMarketingVersion(input.version, input.buildNumber),
        versionDate: input.date,
        versionDescription: description,
        downloadURL,
        size: input.ipaSize,
        appPermissions: {
          entitlements: [],
          privacy: {
            NSCameraUsageDescription:
              "Allow T3 Code to access your camera so you can scan pairing QR codes.",
            NSFaceIDUsageDescription: "Allow BKT3Code to access your Face ID biometric data.",
            NSLocalNetworkUsageDescription:
              "Allow T3 Code to connect to T3 Code servers on your local network or tailnet.",
          },
        },
        versions: [
          {
            version: bkMarketingVersion(input.version, input.buildNumber),
            buildVersion: input.buildNumber,
            marketingVersion: `${input.version}+bk.${shortSha}`,
            date: input.date,
            localizedDescription: description,
            downloadURL,
            size: input.ipaSize,
            sha256: input.ipaSha256,
            minOSVersion: "18.0",
          },
        ],
      },
    ],
  };
}

function requiredValue(argv: ReadonlyArray<string>, flag: string): string {
  const index = argv.indexOf(flag);
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
  return value;
}

export function parseArgs(argv: ReadonlyArray<string>): CliOptions {
  const branchValue = requiredValue(argv, "--branch");
  if (!SUPPORTED_BRANCHES.includes(branchValue as BkMobileReleaseBranch)) {
    throw new Error(
      `--branch must be ${SUPPORTED_BRANCHES.join(" or ")} (received "${branchValue}").`,
    );
  }
  const branch = branchValue as BkMobileReleaseBranch;
  const repository = requiredValue(argv, "--repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`--repository must be an owner/name pair (received "${repository}").`);
  }
  const version = requiredValue(argv, "--version");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`--version must be numeric semver (received "${version}").`);
  }
  const gitSha = requiredValue(argv, "--git-sha");
  if (!/^[0-9a-f]{7,40}$/i.test(gitSha)) {
    throw new Error(`--git-sha must be a Git SHA (received "${gitSha}").`);
  }
  const buildNumber = requiredValue(argv, "--build-number");
  if (!/^[1-9]\d*$/.test(buildNumber)) {
    throw new Error(`--build-number must be a positive integer (received "${buildNumber}").`);
  }
  const date = requiredValue(argv, "--date");
  if (!Number.isFinite(Date.parse(date))) {
    throw new Error(`--date must be an ISO-8601 date (received "${date}").`);
  }
  const ipaPath = NodePath.resolve(requiredValue(argv, "--ipa"));
  const outputFlagIndex = argv.indexOf("--output");
  const outputPath =
    outputFlagIndex === -1
      ? NodePath.join(NodePath.dirname(ipaPath), sourceAssetName(branch))
      : NodePath.resolve(requiredValue(argv, "--output"));

  return { branch, repository, version, gitSha, buildNumber, date, ipaPath, outputPath };
}

function sha256(path: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const expectedIpaName = bkArtifactFileName("ios", options.version, options.gitSha);
  if (NodePath.basename(options.ipaPath) !== expectedIpaName) {
    throw new Error(
      `Expected IPA ${expectedIpaName}, received ${NodePath.basename(options.ipaPath)}.`,
    );
  }
  const stats = NodeFS.statSync(options.ipaPath);
  if (!stats.isFile() || stats.size === 0)
    throw new Error(`${options.ipaPath} is not a non-empty IPA.`);

  const source = createBkMobileSource({
    branch: options.branch,
    repository: options.repository,
    version: options.version,
    gitSha: options.gitSha,
    buildNumber: options.buildNumber,
    date: options.date,
    ipaSize: stats.size,
    ipaSha256: sha256(options.ipaPath),
  });
  NodeFS.mkdirSync(NodePath.dirname(options.outputPath), { recursive: true });
  NodeFS.writeFileSync(options.outputPath, `${JSON.stringify(source, null, 2)}\n`);
  console.log(`SideStore source: ${options.outputPath}`);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
