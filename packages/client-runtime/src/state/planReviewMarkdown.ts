// @effect-diagnostics globalDate:off -- Client-side discussion ids are a UI concern; the wall clock only breaks collisions across reloads.
/**
 * T3-CUSTOM(expbkt3): markdown helpers shared by every plan-review surface.
 *
 * Markdown is the canonical form: it is what the agent reads, what versions
 * store, and what diffs are computed from. Each client's editor value is a
 * working cache over it — Plate on web, plain selectable lines on mobile — so
 * everything here is string-level and holds no editor types.
 */
import { planReviewAnchorText } from "@t3tools/shared/planReview";

let planReviewIdSequence = 0;

/**
 * Client-side id for a new discussion. Ids only need to be unique within a
 * session — the server owns durable identity.
 */
export function nextPlanDiscussionId(): string {
  planReviewIdSequence += 1;
  return `plan-discussion:${Date.now()}-${planReviewIdSequence}`;
}

export interface PlanOutlineHeading {
  /** 0-based line index in the plan markdown, so comments can be bucketed. */
  readonly lineIndex: number;
  readonly depth: number;
  readonly text: string;
}

/**
 * Reads the plan's heading structure for the outline rail.
 *
 * ATX headings only, and fenced regions are skipped: a `# comment` inside a shell
 * block is not a section of the plan. Plate emits ATX for every heading it
 * serializes, so setext is not worth carrying.
 */
export function parsePlanOutline(markdown: string): ReadonlyArray<PlanOutlineHeading> {
  const headings: PlanOutlineHeading[] = [];
  let fence: string | null = null;

  markdown
    .replaceAll("\r\n", "\n")
    .split("\n")
    .forEach((line, lineIndex) => {
      const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1]!;
        if (fence === null) fence = marker[0]!;
        else if (marker[0] === fence) fence = null;
        return;
      }
      if (fence !== null) return;

      const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (!match) return;
      const text = planReviewAnchorText(match[2]!);
      if (text.length === 0) return;
      headings.push({ lineIndex, depth: match[1]!.length, text });
    });

  return headings;
}

/**
 * Assigns each located comment to the heading it falls under.
 *
 * Returns counts keyed by heading line index. A comment above the first heading,
 * or one whose anchor could not be located at all, belongs to no section and is
 * simply not counted — the rail still lists it.
 */
export function countPlanOutlineComments(
  headings: ReadonlyArray<PlanOutlineHeading>,
  commentLineIndexes: ReadonlyArray<number | null>,
): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();

  for (const lineIndex of commentLineIndexes) {
    if (lineIndex === null) continue;
    // The last heading at or above the comment owns it.
    let owner: PlanOutlineHeading | null = null;
    for (const heading of headings) {
      if (heading.lineIndex > lineIndex) break;
      owner = heading;
    }
    if (owner === null) continue;
    counts.set(owner.lineIndex, (counts.get(owner.lineIndex) ?? 0) + 1);
  }

  return counts;
}

/** Collapses whitespace so quoted anchors survive editor reformatting. */
export function normalizeQuotedText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Plate normalizes markdown as it loads it (bullet markers, escapes and hard
 * breaks can all change). That normalization is not a reviewer edit.
 */
export function hasPlanReviewEditorChange(input: {
  readonly baselineEditorMarkdown: string;
  readonly editorMarkdown: string;
}): boolean {
  return input.editorMarkdown !== input.baselineEditorMarkdown;
}

/** Preserve the agent's canonical bytes until the reviewer actually edits. */
export function resolveSubmittedPlanMarkdown(input: {
  readonly canonicalMarkdown: string;
  readonly editorMarkdown: string;
  readonly hasReviewerEdits: boolean;
}): string {
  return input.hasReviewerEdits ? input.editorMarkdown : input.canonicalMarkdown;
}
