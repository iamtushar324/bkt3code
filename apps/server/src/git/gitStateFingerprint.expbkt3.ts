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

/** Git config outside the repository (global, system) is not fingerprinted, so it is reread this often. */
export const GIT_STATE_FINGERPRINT_MAX_AGE = Duration.minutes(30);

export interface GitStateFingerprint {
  /** Remote names, remote URLs and remote default branches: shared by every branch of a checkout. */
  readonly repository: string;
  /** Adds the branch's own config section, its local ref and its remote-tracking refs. */
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

interface ParsedConfig {
  readonly sharedVersion: number;
  readonly branches: ReadonlyMap<string, string>;
  readonly remoteNames: ReadonlyArray<string>;
}

interface CheckoutLayout {
  readonly dotGit: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly commonDirFile: string;
}

const LAYOUT_CAPACITY = 2_048;
const CONFIG_CAPACITY = 64;

export const makeGitStateFingerprints = Effect.fn("makeGitStateFingerprints")(function* (services: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const { fileSystem, path } = services;

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

  // Versions come from one counter, so an evicted repository can never reuse an old version.
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

  /** Null when the checkout's layout is not one this fingerprint covers; lookups then keep their TTL. */
  const read = Effect.fn("GitStateFingerprint.read")(function* (cwd: string, branch: string) {
    const dotGitInfo = yield* fileSystem.stat(path.join(cwd, ".git")).pipe(Effect.option);
    if (Option.isNone(dotGitInfo)) return null;
    const layout = yield* resolveLayout(cwd, dotGitInfo.value);
    if (layout === null) return null;
    const configPath = path.join(layout.commonDir, "config");
    const [config, reftable, commonDirFile] = yield* Effect.all(
      [
        statSignature(configPath),
        statSignature(path.join(layout.commonDir, "reftable"), false),
        layout.commonDir === layout.gitDir
          ? Effect.succeed("-")
          : statSignature(path.join(layout.gitDir, "commondir")),
      ],
      { concurrency: "unbounded" },
    );
    if (commonDirFile !== layout.commonDirFile) {
      layouts.delete(cwd);
      return null;
    }
    if (config === "-" || reftable !== "-") return null;
    const parsed = yield* parseConfig(configPath, config);
    if (parsed === null) return null;
    const refs = path.join(layout.commonDir, "refs");
    const [head, worktreeConfig, localRef, packedRefs, remoteRefsDir, ...remoteSignatures] =
      yield* Effect.all(
        [
          statSignature(path.join(layout.gitDir, "HEAD")),
          statSignature(path.join(layout.gitDir, "config.worktree")),
          statSignature(path.join(refs, "heads", branch)),
          statSignature(path.join(layout.commonDir, "packed-refs")),
          statSignature(path.join(refs, "remotes")),
          ...parsed.remoteNames.flatMap((remote) => [
            statSignature(path.join(refs, "remotes", remote, "HEAD")),
            statSignature(path.join(refs, "remotes", remote, branch)),
          ]),
        ],
        { concurrency: "unbounded" },
      );
    if (head === "-") return null;
    const repository = [
      layout.dotGit,
      layout.commonDir,
      head,
      worktreeConfig,
      `config:${parsed.sharedVersion}`,
      ...parsed.remoteNames.map((remote, index) => `${remote}=${remoteSignatures[index * 2]}`),
    ].join("\u0000");
    return {
      repository,
      branch: [
        repository,
        parsed.branches.get(branch) ?? "",
        localRef,
        packedRefs,
        remoteRefsDir,
        ...parsed.remoteNames.map(
          (remote, index) => `${remote}=${remoteSignatures[index * 2 + 1]}`,
        ),
      ].join("\u0000"),
      unchanged: statSignature(configPath).pipe(Effect.map((current) => current === config)),
    } satisfies GitStateFingerprint;
  });

  return { read };
});
