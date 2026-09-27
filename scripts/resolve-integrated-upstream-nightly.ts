// T3-CUSTOM(expbkt3): keeps staging builds identifiable when upstream main
// advances between nightly tags without relabeling them as an exact release.
// @effect-diagnostics nodeBuiltinImport:off - standalone CI release helper.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import { compareSemverVersions } from "@t3tools/shared/semver";

const UPSTREAM_NIGHTLY_TAG = /^upstream-v(\d+\.\d+\.\d+-nightly\.\d{8}\.\d+)$/;
const SHA = /^[0-9a-f]{7,64}$/;

export interface UpstreamNightlyCandidate {
  readonly tag: string;
  readonly commit: string;
  /** Number of commits from the nightly tag to the integrated upstream SHA. */
  readonly distance: number;
}

export interface IntegratedUpstreamNightlyResolution {
  readonly version: string;
  readonly sourceTag: string;
  readonly exact: boolean;
}

function parseNightlyTag(tag: string): string | undefined {
  return UPSTREAM_NIGHTLY_TAG.exec(tag)?.[1];
}

function compareTags(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNightlyTags(left: string, right: string): number {
  const leftVersion = parseNightlyTag(left);
  const rightVersion = parseNightlyTag(right);
  if (leftVersion !== undefined && rightVersion !== undefined) {
    return compareSemverVersions(leftVersion, rightVersion);
  }
  return compareTags(left, right);
}

function requireSha(sha: string): void {
  if (!SHA.test(sha)) {
    throw new Error(`Integrated upstream SHA is invalid: ${sha}`);
  }
}

/**
 * Keeps an exact upstream nightly version intact. Between nightlies, the
 * closest tagged ancestor supplies the base and the integrated SHA becomes an
 * additional SemVer prerelease identifier, so it cannot be mistaken for that
 * prior release.
 */
export function resolveIntegratedUpstreamNightly(input: {
  readonly upstreamSha: string;
  readonly candidates: ReadonlyArray<UpstreamNightlyCandidate>;
}): IntegratedUpstreamNightlyResolution {
  requireSha(input.upstreamSha);
  const exact = input.candidates.filter((candidate) => candidate.commit === input.upstreamSha);
  if (exact.length > 0) {
    const selected = [...exact].sort((left, right) => compareNightlyTags(right.tag, left.tag))[0];
    if (selected === undefined) {
      throw new Error("No exact upstream nightly tag was selected.");
    }
    const version = parseNightlyTag(selected.tag);
    if (version === undefined) {
      throw new Error(`Invalid exact upstream nightly tag: ${selected.tag}`);
    }
    return { version, sourceTag: selected.tag, exact: true };
  }

  const nearestDistance = Math.min(...input.candidates.map((candidate) => candidate.distance));
  if (!Number.isSafeInteger(nearestDistance) || nearestDistance < 1) {
    throw new Error(`No tagged upstream nightly ancestor exists for ${input.upstreamSha}.`);
  }
  const nearest = input.candidates
    .filter((candidate) => candidate.distance === nearestDistance)
    .sort((left, right) => compareNightlyTags(right.tag, left.tag));
  const selected = nearest[0];
  if (selected === undefined) {
    throw new Error(`No tagged upstream nightly ancestor exists for ${input.upstreamSha}.`);
  }
  const version = parseNightlyTag(selected.tag);
  if (version === undefined) {
    throw new Error(`Invalid nearest upstream nightly tag: ${selected.tag}`);
  }
  return {
    // Prefix the abbreviated SHA: a hash made only of digits could otherwise
    // be an invalid SemVer numeric prerelease identifier with a leading zero.
    version: `${version}.upstream.g${input.upstreamSha.slice(0, 12)}`,
    sourceTag: selected.tag,
    exact: false,
  };
}

function git(args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, { encoding: "utf8" }).trim();
}

function resolveCandidates(upstreamSha: string): ReadonlyArray<UpstreamNightlyCandidate> {
  return git(["tag", "--merged", upstreamSha, "--list", "upstream-v*-nightly.*"])
    .split("\n")
    .filter((tag) => tag.length > 0)
    .map((tag) => ({
      tag,
      commit: git(["rev-parse", `${tag}^{commit}`]),
      distance: Number(git(["rev-list", "--count", `${tag}..${upstreamSha}`])),
    }));
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (import.meta.main) {
  const upstreamSha = readFlag("--upstream-sha");
  const githubEnv = readFlag("--github-env");
  if (upstreamSha === undefined || githubEnv === undefined) {
    throw new Error(
      "Usage: resolve-integrated-upstream-nightly --upstream-sha <sha> --github-env <path>",
    );
  }
  const resolution = resolveIntegratedUpstreamNightly({
    upstreamSha,
    candidates: resolveCandidates(upstreamSha),
  });
  NodeFS.appendFileSync(
    githubEnv,
    [
      `APP_VERSION=${resolution.version}`,
      `UPSTREAM_NIGHTLY_SHA=${upstreamSha}`,
      `UPSTREAM_NIGHTLY_TAG=${resolution.sourceTag}`,
      `UPSTREAM_NIGHTLY_EXACT=${resolution.exact}`,
      "",
    ].join("\n"),
  );
  process.stdout.write(
    `Resolved upstream nightly ${resolution.version} from ${resolution.sourceTag} at ${upstreamSha}.\n`,
  );
}
