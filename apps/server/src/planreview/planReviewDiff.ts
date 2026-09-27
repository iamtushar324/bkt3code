/**
 * T3-CUSTOM(expbkt3): line diff for plan versions.
 *
 * Deliberately dependency-free. jsdiff is BSD-3 and `@pierre/diffs` parses
 * diffs rather than producing them, so the ~80 lines of LCS here buy us a
 * unified diff the existing diff viewer can render without a new licence.
 */

export interface UnifiedDiffStats {
  readonly added: number;
  readonly removed: number;
  /** Changed lines as a fraction of the larger side, 0–1. */
  readonly changeRatio: number;
}

export interface UnifiedDiffResult {
  readonly diff: string;
  readonly stats: UnifiedDiffStats;
}

type Op = { readonly kind: "context" | "add" | "remove"; readonly line: string };

function splitLines(value: string): ReadonlyArray<string> {
  const normalized = value.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  // A trailing newline yields a final empty element that is not a real line.
  return lines.length > 1 && lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

/**
 * Longest common subsequence over whole lines. Plans are at most a few hundred
 * lines, so the O(n*m) table is fine and keeps the implementation obvious.
 */
function diffOps(before: ReadonlyArray<string>, after: ReadonlyArray<string>): ReadonlyArray<Op> {
  const rows = before.length;
  const cols = after.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    Array.from<number>({ length: cols + 1 }).fill(0),
  );

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i]![j] =
        before[i] === after[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      ops.push({ kind: "context", line: before[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: "remove", line: before[i]! });
      i += 1;
    } else {
      ops.push({ kind: "add", line: after[j]! });
      j += 1;
    }
  }
  while (i < rows) {
    ops.push({ kind: "remove", line: before[i]! });
    i += 1;
  }
  while (j < cols) {
    ops.push({ kind: "add", line: after[j]! });
    j += 1;
  }
  return ops;
}

interface Hunk {
  readonly beforeStart: number;
  readonly beforeCount: number;
  readonly afterStart: number;
  readonly afterCount: number;
  readonly lines: ReadonlyArray<string>;
}

const CONTEXT_LINES = 3;

function buildHunks(ops: ReadonlyArray<Op>): ReadonlyArray<Hunk> {
  const changedIndices = ops.flatMap((op, index) => (op.kind === "context" ? [] : [index]));
  if (changedIndices.length === 0) return [];

  // Group changes that sit within 2*CONTEXT_LINES of each other into one hunk.
  const groups: Array<{ start: number; end: number }> = [];
  for (const index of changedIndices) {
    const last = groups.at(-1);
    if (last && index - last.end <= CONTEXT_LINES * 2) {
      last.end = index;
      continue;
    }
    groups.push({ start: index, end: index });
  }

  const hunks: Hunk[] = [];
  for (const group of groups) {
    const from = Math.max(0, group.start - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, group.end + CONTEXT_LINES);

    let beforeLine = 1;
    let afterLine = 1;
    for (let index = 0; index < from; index += 1) {
      const op = ops[index]!;
      if (op.kind !== "add") beforeLine += 1;
      if (op.kind !== "remove") afterLine += 1;
    }

    let beforeCount = 0;
    let afterCount = 0;
    const lines: string[] = [];
    for (let index = from; index <= to; index += 1) {
      const op = ops[index]!;
      if (op.kind === "context") {
        beforeCount += 1;
        afterCount += 1;
        lines.push(` ${op.line}`);
      } else if (op.kind === "remove") {
        beforeCount += 1;
        lines.push(`-${op.line}`);
      } else {
        afterCount += 1;
        lines.push(`+${op.line}`);
      }
    }

    hunks.push({
      beforeStart: beforeLine,
      beforeCount,
      afterStart: afterLine,
      afterCount,
      lines,
    });
  }
  return hunks;
}

/** Builds a unified diff between two markdown documents. Empty when identical. */
export function buildUnifiedDiff(before: string, after: string): UnifiedDiffResult {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const ops = diffOps(beforeLines, afterLines);

  const added = ops.filter((op) => op.kind === "add").length;
  const removed = ops.filter((op) => op.kind === "remove").length;
  const denominator = Math.max(beforeLines.length, afterLines.length, 1);
  const stats: UnifiedDiffStats = {
    added,
    removed,
    // A modified line shows up as one add and one remove, so summing them would
    // report twice the fraction of the document that actually moved — and fire
    // the "send the whole document" guard at half its stated threshold.
    changeRatio: Math.min(1, Math.max(added, removed) / denominator),
  };

  const hunks = buildHunks(ops);
  if (hunks.length === 0) return { diff: "", stats };

  const body = hunks
    .map((hunk) =>
      [
        `@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@`,
        ...hunk.lines,
      ].join("\n"),
    )
    .join("\n");

  return { diff: body, stats };
}

/**
 * Wraps a unified diff in git headers so `@pierre/diffs` can render it as a
 * file diff. `fileName` is cosmetic — plans have no path on disk.
 */
export function toRenderableFileDiff(fileName: string, diff: string): string {
  if (diff.trim().length === 0) return "";
  const safeName = fileName.replaceAll("\\", "/");
  return [
    `diff --git a/${safeName} b/${safeName}`,
    `--- a/${safeName}`,
    `+++ b/${safeName}`,
    diff,
  ].join("\n");
}
