/**
 * T3-CUSTOM(expbkt3): Locate and preserve the provider's own transcript files.
 *
 * The digest and message sidecar are T3's view of a session; the provider CLIs
 * keep a richer record — tool outputs, thinking, raw turns — in their own home
 * directories, keyed by the worktree the session ran in. That key dies with the
 * worktree, so the only reliable moment to resolve these files is export time,
 * while the resume cursor and cwd are still on record.
 *
 * Resolution is pure (strings in, candidate paths out) so it can be tested the
 * way `archivePaths` is; only the walk and the copy touch the filesystem.
 * Copies are gzipped: raw transcripts compress ~10x and are read with `zgrep`,
 * which the history README documents.
 */
import * as NodeZlib from "node:zlib";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** How deep the Codex sessions tree is walked (`YYYY/MM/DD/` plus slack). */
const CODEX_WALK_MAX_DEPTH = 4;

/**
 * The provider session id embedded in a persisted resume cursor.
 *
 * Shapes mirror `buildExternalResumeCursor`: Claude resumes by `resume`,
 * Codex by `threadId`. Anything else — a null cursor, an unknown provider, a
 * malformed payload — resolves to null rather than failing the export.
 */
export function parseResumeSessionId(providerName: string, resumeCursor: unknown): string | null {
  if (typeof resumeCursor !== "object" || resumeCursor === null) {
    return null;
  }
  const cursor = resumeCursor as Record<string, unknown>;
  const value =
    providerName === "claudeAgent"
      ? cursor["resume"]
      : providerName === "codex"
        ? cursor["threadId"]
        : null;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The cwd the provider session actually ran in, from the runtime payload. */
export function parseRuntimeCwd(runtimePayload: unknown): string | null {
  if (typeof runtimePayload !== "object" || runtimePayload === null) {
    return null;
  }
  const value = (runtimePayload as Record<string, unknown>)["cwd"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Where Claude Code keeps transcripts for sessions run in `cwd`.
 *
 * `configuredHome` is the instance's `homePath` setting resolved to an absolute
 * path (it doubles as `CLAUDE_CONFIG_DIR`, so `projects` sits directly inside
 * it); null means the setting is blank and the default `~/.claude` applies.
 */
export function claudeProjectsDir(configuredHome: string | null, osHomeDir: string): string {
  return configuredHome !== null ? `${configuredHome}/projects` : `${osHomeDir}/.claude/projects`;
}

/** Codex's sessions root; `configuredHome` is the `.codex`-equivalent dir. */
export function codexSessionsDir(configuredHome: string | null, osHomeDir: string): string {
  return configuredHome !== null ? `${configuredHome}/sessions` : `${osHomeDir}/.codex/sessions`;
}

/** Claude's per-project transcript directory name: the cwd with `/` and `.` replaced by `-`. */
function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * The single file Claude would resume this session from.
 *
 * The resume-chain file carries the full conversation from the first prompt,
 * so one file is the whole record — sibling files in the slug directory are
 * title/branch utility sessions, deliberately not collected.
 */
export function claudeTranscriptCandidate(input: {
  readonly projectsDir: string;
  readonly cwd: string;
  readonly sessionId: string;
}): string {
  return `${input.projectsDir}/${claudeProjectSlug(input.cwd)}/${input.sessionId}.jsonl`;
}

/**
 * Rollout files for a Codex session, wherever they sit under the date tree.
 *
 * Matches by embedded session id and returns the paths, since the caller
 * copies them. Read failures degrade to
 * "found nothing" — a missing transcript is a recorded outcome, not an error.
 */
export const findCodexRolloutFiles = Effect.fn("findCodexRolloutFiles")(function* (input: {
  readonly sessionsDir: string;
  readonly sessionId: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const walk = (dir: string, depth: number): Effect.Effect<ReadonlyArray<string>> =>
    Effect.gen(function* () {
      if (depth > CODEX_WALK_MAX_DEPTH) {
        return [];
      }
      const entries = yield* fs
        .readDirectory(dir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const found: Array<string> = [];
      for (const entry of entries) {
        const child = path.join(dir, entry);
        if (entry.includes(input.sessionId) && entry.endsWith(".jsonl")) {
          found.push(child);
          continue;
        }
        const stat = yield* fs.stat(child).pipe(Effect.result);
        if (stat._tag === "Success" && stat.success.type === "Directory") {
          found.push(...(yield* walk(child, depth + 1)));
        }
      }
      return found;
    });

  return yield* walk(input.sessionsDir, 0);
});

/**
 * Gzip one file into the archive.
 *
 * Whole-file gzip rather than a stream: the largest transcripts observed are
 * tens of megabytes and exports are rare, so simplicity wins over peak memory.
 * Written via temp-and-rename in the target directory so a crash never leaves
 * a truncated `.gz` that looks like a complete copy.
 */
export const copyFileGzipped = Effect.fn("copyFileGzipped")(function* (input: {
  readonly sourcePath: string;
  readonly targetPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const contents = yield* fs.readFile(input.sourcePath);
  const compressed = NodeZlib.gzipSync(contents);

  const targetDirectory = path.dirname(input.targetPath);
  yield* fs.makeDirectory(targetDirectory, { recursive: true });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.targetPath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");
      yield* fs.writeFile(tempPath, new Uint8Array(compressed));
      yield* fs.rename(tempPath, input.targetPath);
    }),
  );
});
