/**
 * T3-CUSTOM(expbkt3): list only the transcript files that can hold one
 * thread's usage.
 *
 * `threadUsage.get` (the chat header's cost chip) used to walk every
 * transcript modified since the thread started and parse each one, then keep
 * the records whose session id matched: 7.6 s on average, 21 s at worst, in
 * prod. The provider session id is in the file layout, so the walk can skip
 * everything else before any stat or parse:
 *
 * - Claude: `<projects>/<cwd-slug>/<sessionId>.jsonl`, plus subagent
 *   transcripts under `<projects>/<cwd-slug>/<sessionId>/` (they carry the
 *   parent's session id).
 * - Codex: `<sessions>/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl`.
 * - Grok: the layout is not keyed by id here, so it keeps the full
 *   `updates.jsonl` walk.
 */
// @effect-diagnostics nodeBuiltinImport:off - mirrors usageTranscriptReader's plain fs walk.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { UsageProviderKind } from "@t3tools/contracts";

import { listTranscriptFiles, type TranscriptFile } from "./usageTranscriptReader.ts";

const statIfRecent = async (path: string, sinceMs: number): Promise<TranscriptFile | null> => {
  try {
    const stats = await NodeFSP.stat(path);
    return stats.isFile() && stats.mtimeMs >= sinceMs
      ? { path, size: stats.size, mtimeMs: stats.mtimeMs }
      : null;
  } catch {
    return null;
  }
};

const readDirEntries = async (dir: string) => {
  try {
    return await NodeFSP.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** Recursive `.jsonl` walk that only stats files whose name passes `accept`. */
const walk = async (
  dir: string,
  sinceMs: number,
  accept: (name: string) => boolean,
  found: TranscriptFile[],
): Promise<void> => {
  for (const entry of await readDirEntries(dir)) {
    const child = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(child, sinceMs, accept, found);
    } else if (entry.name.endsWith(".jsonl") && accept(entry.name)) {
      const file = await statIfRecent(child, sinceMs);
      if (file !== null) found.push(file);
    }
  }
};

export async function listThreadTranscriptFiles(input: {
  readonly provider: UsageProviderKind;
  readonly dir: string;
  readonly fileName?: string | undefined;
  readonly sessionIds: ReadonlyArray<string>;
  readonly sinceMs: number;
}): Promise<readonly TranscriptFile[]> {
  const ids = [...new Set(input.sessionIds.filter((id) => id.length > 0 && !id.includes("/")))];
  if (ids.length === 0) return [];
  const found: TranscriptFile[] = [];

  if (input.provider === "claude") {
    for (const project of await readDirEntries(input.dir)) {
      if (!project.isDirectory()) continue;
      const projectDir = NodePath.join(input.dir, project.name);
      for (const id of ids) {
        const main = await statIfRecent(NodePath.join(projectDir, `${id}.jsonl`), input.sinceMs);
        if (main !== null) found.push(main);
        await walk(NodePath.join(projectDir, id), input.sinceMs, () => true, found);
      }
    }
    return found;
  }

  if (input.provider === "codex") {
    const suffixes = ids.map((id) => `-${id}.jsonl`);
    await walk(
      input.dir,
      input.sinceMs,
      (name) => suffixes.some((suffix) => name.endsWith(suffix)),
      found,
    );
    return found;
  }

  return listTranscriptFiles(
    input.dir,
    input.sinceMs,
    input.fileName === undefined ? undefined : { fileName: input.fileName },
  );
}

/** A thread read rewrites the whole scan cache file at most this often. */
export const THREAD_USAGE_PERSIST_INTERVAL_MS = 5 * 60 * 1000;

export const shouldPersistAfterThreadRead = (
  lastPersistMs: number | null,
  nowMs: number,
): boolean => lastPersistMs === null || nowMs - lastPersistMs >= THREAD_USAGE_PERSIST_INTERVAL_MS;
