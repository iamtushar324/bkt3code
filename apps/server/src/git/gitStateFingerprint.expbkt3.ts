/**
 * T3-CUSTOM(expbkt3): a cheap stand-in for rerunning git in branch pull-request lookups.
 * It stats the files those git reads depend on, so unchanged worktrees start no git process.
 */
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import {
  CurrentSourceControlExecutionEnvironment,
  mergeSourceControlEnvironment,
  type SourceControlExecutionEnvironment,
} from "../sourceControl/SourceControlExecutionEnvironment.ts";

/** Config the fingerprint cannot see (a system file under another install prefix) is reread this often. */
export const GIT_STATE_FINGERPRINT_MAX_AGE = Duration.minutes(30);

export interface GitStateFingerprint {
  /** Remote names, remote URLs and remote default branches: shared by every branch of a checkout. */
  readonly repository: string;
  /** Adds the branch's own config sections, its refs and the history boundaries ancestry reads. */
  readonly branch: string;
  /** Config is compared by content, so a rewrite after this fingerprint was taken must not be stored under it. */
  readonly unchanged: Effect.Effect<boolean>;
}

/** Remembered lookup keys that read repository-wide state; every other key uses the branch fingerprint. */
export const gitStateFingerprintToken = (fingerprint: GitStateFingerprint, key: string): string =>
  key === "remotes" ||
  key.startsWith("defaultBranch\u0000") ||
  key.startsWith("config\u0000remote.")
    ? fingerprint.repository
    : fingerprint.branch;

export interface SplitGitConfig {
  readonly shared: string;
  readonly branches: ReadonlyMap<string, string>;
  readonly remoteNames: ReadonlyArray<string>;
}

const SECTION_HEADER = /^\s*\[([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\]\s*(?:[#;].*)?$/u;

/**
 * Splits config text into `[branch "<name>"]` sections and everything else, so another branch's
 * upstream can change without invalidating this branch. Null for syntax the split cannot follow:
 * continuation lines, includes (their files are not fingerprinted), or an unusual section header.
 */
export const splitGitConfig = (text: string): SplitGitConfig | null => {
  const shared: Array<string> = [];
  const branches = new Map<string, Array<string>>();
  const remoteNames: Array<string> = [];
  let current = shared;
  for (const line of text.split("\n")) {
    // Appending a section moves the file's trailing blank line, so blank lines must not count.
    if (line.trim() === "") continue;
    if (/\\\s*$/u.test(line)) return null;
    if (/^\s*\[/u.test(line)) {
      const header = SECTION_HEADER.exec(line);
      if (header === null) return null;
      const name = header[1]!.toLowerCase();
      const subsection = header[2]?.replace(/\\(.)/gu, "$1");
      if (name === "include" || name === "includeif") return null;
      if (name === "branch" && subsection !== undefined) {
        current = branches.get(subsection) ?? [];
        branches.set(subsection, current);
      } else {
        if (name === "remote" && subsection !== undefined && !remoteNames.includes(subsection)) {
          remoteNames.push(subsection);
        }
        current = shared;
      }
    }
    current.push(line);
  }
  return {
    shared: shared.join("\n"),
    branches: new Map([...branches].map(([branch, lines]) => [branch, lines.join("\n")])),
    remoteNames,
  };
};

// These point git at another repository, ref namespace or history, which the fingerprint cannot follow.
const UNSUPPORTED_ENVIRONMENT_KEYS = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE",
  "GIT_REPLACE_REF_BASE",
];
const GIT_FALSE_VALUES = new Set(["", "0", "false", "no", "off"]);

interface GitEnvironment {
  /** Every variable that selects git's config files or adds config of its own. */
  readonly token: string;
  /** System and global config files in git's read order; a relative path resolves against the cwd. */
  readonly externalConfigPaths: ReadonlyArray<string>;
}

interface ParsedConfig {
  readonly sharedVersion: number;
  readonly branches: ReadonlyMap<string, string>;
  readonly remoteNames: ReadonlyArray<string>;
}

interface ConfigSource {
  readonly path: string;
  readonly signature: string;
  readonly parsed: ParsedConfig | null;
}

interface CheckoutLayout {
  readonly dotGit: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly commonDirFile: string;
}

const LAYOUT_CAPACITY = 2_048;
// Common, worktree, global and system config for every checkout the sweep visits.
const CONFIG_CAPACITY = 512;
const EMPTY_CONFIG: ParsedConfig = { sharedVersion: 0, branches: new Map(), remoteNames: [] };

export const makeGitStateFingerprints = Effect.fn("makeGitStateFingerprints")(function* (services: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  /** What spawned git inherits before a source-control profile's environment is merged over it. */
  readonly environment: NodeJS.ProcessEnv;
}) {
  const { fileSystem, path } = services;

  const gitEnvironmentOf = (environment: NodeJS.ProcessEnv): GitEnvironment | null => {
    if (UNSUPPORTED_ENVIRONMENT_KEYS.some((key) => (environment[key] ?? "") !== "")) return null;
    const token = Object.keys(environment)
      .filter(
        (key) =>
          key.startsWith("GIT_CONFIG") ||
          key === "GIT_NO_REPLACE_OBJECTS" ||
          key === "HOME" ||
          key === "USERPROFILE" ||
          key === "XDG_CONFIG_HOME",
      )
      .sort()
      .map((key) => `${key}=${environment[key] ?? ""}`)
      .join("\u0001");
    const externalConfigPaths: Array<string> = [];
    if (GIT_FALSE_VALUES.has((environment.GIT_CONFIG_NOSYSTEM ?? "").toLowerCase())) {
      externalConfigPaths.push(environment.GIT_CONFIG_SYSTEM ?? "/etc/gitconfig");
    }
    const home = environment.HOME ?? environment.USERPROFILE ?? "";
    if (environment.GIT_CONFIG_GLOBAL !== undefined) {
      externalConfigPaths.push(environment.GIT_CONFIG_GLOBAL);
    } else {
      const xdgConfigHome = environment.XDG_CONFIG_HOME ?? "";
      if (xdgConfigHome !== "") externalConfigPaths.push(path.join(xdgConfigHome, "git", "config"));
      else if (home !== "") externalConfigPaths.push(path.join(home, ".config", "git", "config"));
      if (home !== "") externalConfigPaths.push(path.join(home, ".gitconfig"));
    }
    return {
      token,
      externalConfigPaths: externalConfigPaths.filter((target) => target !== ""),
    };
  };
  const baseEnvironment = gitEnvironmentOf(services.environment);
  // A profile's environment is merged the way VcsProcess merges it before spawning git.
  const profileEnvironments = new WeakMap<object, GitEnvironment | null>();
  const environmentFor = (execution: SourceControlExecutionEnvironment | null) => {
    if (execution === null) return baseEnvironment;
    const cached = profileEnvironments.get(execution.environment);
    if (cached !== undefined) return cached;
    const environment = gitEnvironmentOf(
      mergeSourceControlEnvironment(services.environment, execution.environment),
    );
    profileEnvironments.set(execution.environment, environment);
    return environment;
  };

  // A directory's mtime moves with every lock file inside it, so `.git` itself is identified by inode only.
  const signatureOf = (info: FileSystem.File.Info, withMtime: boolean) =>
    [
      info.type,
      String(info.dev),
      Option.getOrElse(Option.map(info.ino, String), () => "?"),
      ...(withMtime
        ? [
            String(info.size),
            Option.getOrElse(
              Option.map(info.mtime, (mtime) => String(mtime.getTime())),
              () => "?",
            ),
          ]
        : []),
    ].join(":");
  const statSignature = (target: string, withMtime = true) =>
    fileSystem.stat(target).pipe(
      Effect.map((info) => signatureOf(info, withMtime)),
      Effect.orElseSucceed(() => "-"),
    );
  // Only regular files hold config; anything else (such as /dev/null) is compared by kind alone.
  const configSignature = (target: string) =>
    fileSystem.stat(target).pipe(
      Effect.map((info) => (info.type === "File" ? signatureOf(info, true) : info.type)),
      Effect.orElseSucceed(() => "-"),
    );

  // Listed on every read: these directories are rare, and an mtime has only millisecond precision.
  const hasEntries = (target: string, signature: string) =>
    signature === "-"
      ? Effect.succeed(false)
      : fileSystem.readDirectory(target).pipe(
          Effect.map((names) => names.length > 0),
          Effect.orElseSucceed(() => true),
        );

  const layouts = new Map<string, CheckoutLayout>();
  const resolveLayout = Effect.fnUntraced(function* (
    cwd: string,
    dotGitInfo: FileSystem.File.Info,
  ) {
    const dotGitPath = path.join(cwd, ".git");
    if (dotGitInfo.type === "Directory") {
      return {
        dotGit: signatureOf(dotGitInfo, false),
        gitDir: dotGitPath,
        commonDir: dotGitPath,
        commonDirFile: "-",
      } satisfies CheckoutLayout;
    }
    if (dotGitInfo.type !== "File") return null;
    const dotGit = signatureOf(dotGitInfo, true);
    const cached = layouts.get(cwd);
    if (cached !== undefined && cached.dotGit === dotGit) return cached;
    const gitDirLine = yield* fileSystem.readFileString(dotGitPath).pipe(
      Effect.map((text) => /^gitdir:\s*(.+?)\s*$/mu.exec(text)?.[1] ?? null),
      Effect.orElseSucceed(() => null),
    );
    if (gitDirLine === null) return null;
    const gitDir = path.resolve(cwd, gitDirLine);
    const commonDirPath = path.join(gitDir, "commondir");
    const [commonDirText, commonDirFile] = yield* Effect.all(
      [fileSystem.readFileString(commonDirPath).pipe(Effect.option), statSignature(commonDirPath)],
      { concurrency: "unbounded" },
    );
    const layout = {
      dotGit,
      gitDir,
      commonDir: Option.match(commonDirText, {
        onNone: () => gitDir,
        onSome: (text) => path.resolve(gitDir, text.trim()),
      }),
      commonDirFile,
    } satisfies CheckoutLayout;
    layouts.delete(cwd);
    if (layouts.size >= LAYOUT_CAPACITY) {
      const oldest = layouts.keys().next().value;
      if (oldest !== undefined) layouts.delete(oldest);
    }
    layouts.set(cwd, layout);
    return layout;
  });

  // Versions come from one counter, so an evicted file can never reuse an old version.
  let nextSharedVersion = 0;
  const sharedVersions = new Map<string, { readonly shared: string; readonly version: number }>();
  const sharedVersionFor = (configPath: string, shared: string) => {
    const previous = sharedVersions.get(configPath);
    if (previous !== undefined && previous.shared === shared) return previous.version;
    nextSharedVersion += 1;
    sharedVersions.delete(configPath);
    if (sharedVersions.size >= CONFIG_CAPACITY) {
      const oldest = sharedVersions.keys().next().value;
      if (oldest !== undefined) sharedVersions.delete(oldest);
    }
    sharedVersions.set(configPath, { shared, version: nextSharedVersion });
    return nextSharedVersion;
  };
  // Keyed by path and stat signature: every worktree of a repository shares one parse per config write.
  const parsedConfigs = yield* Cache.makeWith(
    (key: string) => {
      const configPath = key.slice(0, key.indexOf("\u0000"));
      return fileSystem.readFileString(configPath).pipe(
        Effect.map((text): ParsedConfig | null => {
          const split = splitGitConfig(text);
          if (split === null) return null;
          return {
            sharedVersion: sharedVersionFor(configPath, split.shared),
            branches: split.branches,
            remoteNames: split.remoteNames,
          };
        }),
        Effect.orElseSucceed(() => null),
      );
    },
    { capacity: CONFIG_CAPACITY },
  );
  // A config write leaves its previous parse unreachable; drop it rather than hold it to eviction.
  const parsedConfigKeys = new Map<string, string>();
  const parseConfig = Effect.fnUntraced(function* (configPath: string, signature: string) {
    const key = `${configPath}\u0000${signature}`;
    const parsed = yield* Cache.get(parsedConfigs, key);
    const previousKey = parsedConfigKeys.get(configPath);
    if (previousKey !== key) {
      parsedConfigKeys.delete(configPath);
      if (parsedConfigKeys.size >= CONFIG_CAPACITY) {
        const oldest = parsedConfigKeys.keys().next().value;
        if (oldest !== undefined) parsedConfigKeys.delete(oldest);
      }
      parsedConfigKeys.set(configPath, key);
      if (previousKey !== undefined) yield* Cache.invalidate(parsedConfigs, previousKey);
    }
    return parsed;
  });
  // A missing file reads as empty config; a file the split cannot follow has no parse (null).
  const readConfigSource = Effect.fnUntraced(function* (target: string) {
    const signature = yield* configSignature(target);
    const parsed = signature.startsWith("File:")
      ? yield* parseConfig(target, signature)
      : EMPTY_CONFIG;
    return { path: target, signature, parsed } satisfies ConfigSource;
  });

  /** Null when the checkout's layout is not one this fingerprint covers; lookups then keep their TTL. */
  const read = Effect.fn("GitStateFingerprint.read")(function* (cwd: string, branch: string) {
    const environment = environmentFor(yield* CurrentSourceControlExecutionEnvironment);
    if (environment === null) return null;
    const dotGitInfo = yield* fileSystem.stat(path.join(cwd, ".git")).pipe(Effect.option);
    if (Option.isNone(dotGitInfo)) return null;
    const layout = yield* resolveLayout(cwd, dotGitInfo.value);
    if (layout === null) return null;
    const inCommonDir = (...segments: ReadonlyArray<string>) =>
      path.join(layout.commonDir, ...segments);
    const configPaths = [
      inCommonDir("config"),
      path.join(layout.gitDir, "config.worktree"),
      ...environment.externalConfigPaths.map((target) => path.resolve(cwd, target)),
    ];
    const [commonDirFile, reftable, grafts, replaceRefs, legacyRemotes, legacyBranches, configs] =
      yield* Effect.all(
        [
          layout.commonDir === layout.gitDir
            ? Effect.succeed("-")
            : statSignature(path.join(layout.gitDir, "commondir")),
          statSignature(inCommonDir("reftable"), false),
          statSignature(inCommonDir("info", "grafts"), false),
          statSignature(inCommonDir("refs", "replace")),
          statSignature(inCommonDir("remotes")),
          statSignature(inCommonDir("branches")),
          Effect.all(configPaths.map(readConfigSource), { concurrency: "unbounded" }),
        ],
        { concurrency: "unbounded" },
      );
    if (commonDirFile !== layout.commonDirFile) {
      layouts.delete(cwd);
      return null;
    }
    if (reftable !== "-" || grafts !== "-" || !configs[0]?.signature.startsWith("File:")) {
      return null;
    }
    const sources: Array<ConfigSource & { readonly parsed: ParsedConfig }> = [];
    for (const source of configs) {
      if (source.parsed === null) return null;
      sources.push({ ...source, parsed: source.parsed });
    }
    // Replace refs rewrite ancestry; legacy remote files declare remotes outside the config.
    const outsideConfig = yield* Effect.all(
      [
        hasEntries(inCommonDir("refs", "replace"), replaceRefs),
        hasEntries(inCommonDir("remotes"), legacyRemotes),
        hasEntries(inCommonDir("branches"), legacyBranches),
      ],
      { concurrency: "unbounded" },
    );
    if (outsideConfig.some(Boolean)) return null;
    const remoteNames = [...new Set(sources.flatMap((source) => source.parsed.remoteNames))];
    const refs = inCommonDir("refs");
    const [head, localRef, packedRefs, remoteRefsDir, shallow, ...remoteSignatures] =
      yield* Effect.all(
        [
          statSignature(path.join(layout.gitDir, "HEAD")),
          statSignature(path.join(refs, "heads", branch)),
          statSignature(inCommonDir("packed-refs")),
          statSignature(path.join(refs, "remotes")),
          statSignature(inCommonDir("shallow")),
          ...remoteNames.flatMap((remote) => [
            statSignature(path.join(refs, "remotes", remote, "HEAD")),
            statSignature(path.join(refs, "remotes", remote, branch)),
          ]),
        ],
        { concurrency: "unbounded" },
      );
    if (head === "-") return null;
    const repository = [
      environment.token,
      layout.dotGit,
      layout.commonDir,
      head,
      legacyRemotes,
      legacyBranches,
      ...sources.map((source) => `${source.path}=${source.parsed.sharedVersion}`),
      ...remoteNames.map((remote, index) => `${remote}=${remoteSignatures[index * 2]}`),
    ].join("\u0000");
    return {
      repository,
      branch: [
        repository,
        ...sources.map((source) => source.parsed.branches.get(branch) ?? ""),
        localRef,
        packedRefs,
        remoteRefsDir,
        shallow,
        replaceRefs,
        ...remoteNames.map((remote, index) => `${remote}=${remoteSignatures[index * 2 + 1]}`),
      ].join("\u0000"),
      unchanged: Effect.all(
        sources.map((source) => configSignature(source.path)),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((current) =>
          current.every((signature, index) => signature === sources[index]?.signature),
        ),
      ),
    } satisfies GitStateFingerprint;
  });

  return { read };
});
