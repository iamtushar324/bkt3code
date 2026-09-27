/**
 * T3-CUSTOM(expbkt3): Fork marker discipline check.
 *
 * Every fork edit inside an upstream-owned file must sit inside a
 * `T3-CUSTOM(expbkt3)` marker, so that whoever resolves the weekly upstream
 * merge can tell at a glance which side owns each hunk. This script enforces
 * that on newly modified regions while tolerating the existing backlog through
 * a ratchet file that can only shrink.
 *
 * Usage:
 *   node scripts/check-fork-markers.ts              # verify (CI)
 *   node scripts/check-fork-markers.ts --write-baseline [--force]
 *
 * Files ADDED by the fork are fork-owned and skipped. Files MODIFIED relative
 * to the upstream mirror are checked hunk by hunk. Lines identical to the
 * newest upstream commit (`FORK_UPSTREAM_REF`) are upstream's even when the
 * fork has not merged it yet, so `git cherry-pick -x` of an upstream fix needs
 * no markers.
 *
 * Runs under bare `node` in CI with no dependency install, so it deliberately
 * uses node builtins and console rather than the Effect APIs.
 */
// @effect-diagnostics nodeBuiltinImport:off - runs without node_modules in CI.
// @effect-diagnostics globalConsole:off - plain CLI output, no Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MARKER = "T3-CUSTOM(expbkt3)";
const BASELINE_PATH = "scripts/fork-marker-baseline.json";

/** The byte-pure upstream mirror. CI has no `upstream` remote configured. */
const UPSTREAM_REF = process.env.FORK_UPSTREAM_REF ?? "origin/main";

/**
 * Paths exempt from marker discipline: test files (fork behaviour is covered by
 * fork-owned tests, and marking assertions adds noise), generated files, docs,
 * and fork-owned CI/config surfaces.
 */
const EXEMPT_PATTERNS: ReadonlyArray<RegExp> = [
  /\.test\.tsx?$/,
  /\.gen\.ts$/,
  /routeTree\.gen\.ts$/,
  /^docs\//,
  /^AGENTS\.md$/,
  /^\.github\//,
  /^deploy\//,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package\.json$/,
  // JSON cannot carry a marker comment; fork package notices live beside upstream's.
  /^third-party-licenses\.config\.json$/,
  /\.md$/,
];

/** How far above a hunk a single-line marker still counts as covering it. */
const MARKER_LOOKBEHIND_LINES = 3;

/**
 * A comment-only line, which is where the single-line marker form is written.
 * A marker here documents the region beneath it; one trailing a statement
 * documents only that statement. Block-comment continuations (`*`) are
 * deliberately absent: a marker in a file header would otherwise swallow
 * everything down to the first blank line.
 */
const COMMENT_ONLY_LINE = /^\s*(?:\/\/|#|<!--)/;

interface Violation {
  readonly file: string;
  readonly startLine: number;
  readonly lineCount: number;
}

function git(args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", [...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function isExempt(path: string): boolean {
  return EXEMPT_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Line numbers (1-indexed, in the HEAD version of the file) that sit inside a
 * BEGIN/END marker block, carry a single-line marker, or sit in the contiguous
 * run of lines a comment-only marker introduces.
 *
 * That last case is what the error message promises — "put a single-line
 * marker comment directly above it" — and it has to cover more than the
 * comment's own line, because the edit it documents is the code underneath,
 * and the explanation itself usually wraps onto a second and third line. The
 * run ends at the first blank line, which is where a marked region naturally
 * ends in this codebase.
 */
function markedLines(contents: string): ReadonlySet<number> {
  const marked = new Set<number>();
  const lines = contents.split("\n");
  let blockDepth = 0;
  let coversBelow = false;
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const hasMarker = line.includes(MARKER);
    if (hasMarker && line.includes("BEGIN")) {
      blockDepth += 1;
      coversBelow = false;
      marked.add(lineNumber);
      return;
    }
    if (hasMarker && line.includes("END")) {
      marked.add(lineNumber);
      blockDepth = Math.max(0, blockDepth - 1);
      coversBelow = false;
      return;
    }
    if (hasMarker) {
      marked.add(lineNumber);
      coversBelow = COMMENT_ONLY_LINE.test(line);
      return;
    }
    if (blockDepth > 0) {
      marked.add(lineNumber);
      return;
    }
    if (!coversBelow) return;
    if (line.trim() === "") {
      coversBelow = false;
      return;
    }
    marked.add(lineNumber);
  });
  return marked;
}

function changedFiles(base: string): { modified: string[]; added: string[] } {
  const raw = git(["diff", "--name-status", "-z", base, "HEAD"]);
  const parts = raw.split("\0").filter((part) => part.length > 0);
  const modified: string[] = [];
  const added: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const status = parts[index] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      // rename/copy carries two paths; treat the destination as modified
      const destination = parts[index + 2];
      if (destination !== undefined) modified.push(destination);
      index += 2;
      continue;
    }
    const path = parts[index + 1];
    index += 1;
    if (path === undefined) continue;
    if (status === "A") added.push(path);
    else if (status === "M") modified.push(path);
  }
  return { modified, added };
}

/** Added-line hunks of `file`, as [startLineInHead, lineCount]. */
function addedHunks(base: string, file: string): ReadonlyArray<readonly [number, number]> {
  const diff = git(["diff", "-U0", base, "HEAD", "--", file]);
  const hunks: Array<readonly [number, number]> = [];
  for (const line of diff.split("\n")) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match === null) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    // count === 0 is a pure deletion: nothing in HEAD to mark.
    if (count > 0) hunks.push([start, count]);
  }
  return hunks;
}

/**
 * The lines of one added hunk that still need a marker.
 *
 * Blank lines carry no ownership and cannot hold a marker. `git diff -U0`
 * routinely folds the blank line that separates a new marked block from its
 * neighbours into the same hunk, so counting whitespace as fork code fails an
 * edit that is in fact marked correctly.
 */
function unmarkedInHunk(
  lines: ReadonlyArray<string>,
  marked: ReadonlySet<number>,
  start: number,
  count: number,
): number[] {
  return Array.from({ length: count }, (_, offset) => start + offset).filter(
    (line) => !marked.has(line) && (lines[line - 1] ?? "").trim() !== "",
  );
}

/** Every HEAD line number covered by `hunks`. */
function hunkLines(hunks: ReadonlyArray<readonly [number, number]>): ReadonlySet<number> {
  const lines = new Set<number>();
  for (const [start, count] of hunks) {
    for (let offset = 0; offset < count; offset += 1) lines.add(start + offset);
  }
  return lines;
}

/**
 * Drops unmarked lines that are identical to the upstream tip's version of the
 * file. A `git cherry-pick -x` of an upstream fix the fork has not merged yet
 * differs from the merge-base, but it is upstream's code, not a fork edit, and
 * wrapping it in markers would only create conflicts in the merge that brings
 * the same commit in. `changedFromTip` holds the HEAD lines that differ from
 * the tip; `null` means there is no separate tip to compare with.
 */
function withoutUpstreamLines(
  unmarked: ReadonlyArray<number>,
  changedFromTip: ReadonlySet<number> | null,
): number[] {
  return changedFromTip === null
    ? [...unmarked]
    : unmarked.filter((line) => changedFromTip.has(line));
}

function findViolations(
  base: string,
  files: ReadonlyArray<string>,
  upstreamTip: string | null = null,
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (isExempt(file) || !NodeFS.existsSync(file)) continue;
    // Ownership comes from git status, never from content: an upstream-owned
    // file often carries a marked fork import near the top, and sniffing for
    // that would exempt the entire file from the check.
    const contents = NodeFS.readFileSync(file, "utf8");
    const lines = contents.split("\n");
    const marked = markedLines(contents);
    const changedFromTip = upstreamTip === null ? null : hunkLines(addedHunks(upstreamTip, file));
    for (const [start, count] of addedHunks(base, file)) {
      const unmarked = withoutUpstreamLines(
        unmarkedInHunk(lines, marked, start, count),
        changedFromTip,
      );
      if (unmarked.length === 0) continue;
      const first = unmarked[0] ?? start;
      const lookbehind = Array.from(
        { length: MARKER_LOOKBEHIND_LINES },
        (_, offset) => first - offset - 1,
      ).some((line) => marked.has(line));
      if (lookbehind) continue;
      const last = unmarked[unmarked.length - 1] ?? first;
      violations.push({ file, startLine: first, lineCount: last - first + 1 });
    }
  }
  return violations;
}

function readBaseline(): ReadonlySet<string> {
  if (!NodeFS.existsSync(BASELINE_PATH)) return new Set();
  const parsed: unknown = JSON.parse(NodeFS.readFileSync(BASELINE_PATH, "utf8"));
  const files = (parsed as { files?: unknown }).files;
  return new Set(
    Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [],
  );
}

/**
 * A marker comment in JSX *children* position is rendered by React as literal
 * text. A 2026-08-27 upstream merge shipped four of them into the composer's
 * traits chip and the settings model row, where users saw
 * "// T3-CUSTOM(expbkt3): ..." printed beside the model picker.
 *
 * Markers between a JSX element's attributes are legal, so the scan first walks
 * back to decide whether the comment sits inside an unterminated opening tag.
 */
function isInsideOpeningTag(lines: ReadonlyArray<string>, index: number): boolean {
  for (let cursor = index - 1; cursor >= 0 && cursor > index - 40; cursor -= 1) {
    const line = lines[cursor]?.trim() ?? "";
    if (line.length === 0 || line.startsWith("//")) continue;
    if (
      line.endsWith(">") ||
      line.endsWith("/>") ||
      line.endsWith(")") ||
      line.endsWith(";") ||
      line.endsWith("{") ||
      line.endsWith(",")
    ) {
      return false;
    }
    if (/<[A-Za-z][\w.]*$/.test(line)) return true;
  }
  return false;
}

function neighbourLine(
  lines: ReadonlyArray<string>,
  index: number,
  step: 1 | -1,
  skipComments: boolean,
): string {
  for (let cursor = index + step; cursor >= 0 && cursor < lines.length; cursor += step) {
    const line = lines[cursor]?.trim() ?? "";
    if (line.length === 0) continue;
    if (skipComments && line.startsWith("//")) continue;
    return line;
  }
  return "";
}

/** Every `.tsx` file in the repo, minus vendored and generated trees. */
function tsxFiles(): string[] {
  return git(["ls-files", "*.tsx"])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith(".repos/"));
}

export function findRenderedMarkers(): Violation[] {
  const violations: Violation[] = [];
  for (const file of tsxFiles()) {
    if (!NodeFS.existsSync(file)) continue;
    const lines = NodeFS.readFileSync(file, "utf8").split("\n");
    lines.forEach((rawLine, index) => {
      if (!rawLine.trim().startsWith(`// ${MARKER}`)) return;
      if (isInsideOpeningTag(lines, index)) return;
      const previous = neighbourLine(lines, index, -1, true);
      const next = neighbourLine(lines, index, 1, false);
      const closesJsx =
        previous.endsWith(">") || previous.endsWith("<>") || previous.endsWith(")}");
      const opensJsx = next.startsWith("<") || next.startsWith("{");
      if (closesJsx && opensJsx) {
        violations.push({ file, startLine: index + 1, lineCount: 1 });
      }
    });
  }
  return violations;
}

function main(): number {
  const argv = new Set(process.argv.slice(2));
  const writeBaseline = argv.has("--write-baseline");
  const force = argv.has("--force");

  const base = git(["merge-base", "HEAD", UPSTREAM_REF]).trim();
  const tip = git(["rev-parse", UPSTREAM_REF]).trim();
  const { modified, added } = changedFiles(base);
  const violations = findViolations(base, modified, tip === base ? null : tip);
  const offending = new Set(violations.map((violation) => violation.file));

  if (writeBaseline) {
    const previous = readBaseline();
    const next = [...offending].filter((file) => force || previous.has(file)).sort();
    NodeFS.writeFileSync(BASELINE_PATH, `${JSON.stringify({ files: next }, null, 2)}\n`);
    console.log(
      `Wrote ${BASELINE_PATH} with ${next.length} file(s)` +
        (force ? " (--force: existing violations adopted)" : ""),
    );
    return 0;
  }

  // Rendered markers are never baselined: they are a visible product defect,
  // not merge debt, and the fix is always to delete or move one comment.
  const rendered = findRenderedMarkers();
  if (rendered.length > 0) {
    console.error(
      `\n${MARKER} comments in JSX children position are rendered to users as text.\n` +
        "Delete them, or move them into the element's attribute list.\n",
    );
    for (const violation of rendered) {
      console.error(`  ${violation.file}:${violation.startLine}`);
    }
  }

  const baseline = readBaseline();
  const unmarked = [...offending].filter((file) => !baseline.has(file)).sort();
  const nowClean = [...baseline].filter((file) => !offending.has(file)).sort();

  if (unmarked.length > 0) {
    console.error(
      `\nFork edits to upstream-owned files must sit inside ${MARKER} markers.\n` +
        `Wrap each region with "// ${MARKER}: BEGIN" / "// ${MARKER}: END",\n` +
        `or put a single-line "// ${MARKER}: <why>" comment directly above it.\n`,
    );
    for (const file of unmarked) {
      console.error(`  ${file}`);
      for (const violation of violations.filter((entry) => entry.file === file)) {
        const end = violation.startLine + violation.lineCount - 1;
        console.error(`    lines ${violation.startLine}-${end} are unmarked`);
      }
    }
  }

  if (nowClean.length > 0) {
    console.error(
      `\nThese files are now fully marked — remove them from ${BASELINE_PATH}\n` +
        "so the ratchet cannot loosen again:\n",
    );
    for (const file of nowClean) console.error(`  ${file}`);
  }

  if (unmarked.length === 0 && nowClean.length === 0 && rendered.length === 0) {
    const skipped = baseline.size;
    console.log(
      `Fork marker check passed. ${modified.length} modified upstream file(s), ` +
        `${added.length} fork-owned file(s) added, ${skipped} file(s) still in the baseline.`,
    );
    return 0;
  }
  return 1;
}

// Only run when invoked directly, so the test can import the helpers.
const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  NodePath.resolve(invokedPath) === NodePath.resolve(import.meta.dirname, "check-fork-markers.ts")
) {
  process.exit(main());
}

export { isExempt, markedLines, unmarkedInHunk, withoutUpstreamLines };
