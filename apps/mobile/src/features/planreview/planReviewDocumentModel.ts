// T3-CUSTOM(expbkt3): turns a plan-review snapshot into what the screen renders.
//
// Kept pure and separate from the view so the awkward parts — which version is
// current, where a discussion's quote sits now, which comments belong to it —
// are testable without a renderer.
//
// Anchoring is by quoted text, not line number: the server stores the excerpt a
// reviewer selected, and its position is re-derived against whichever version
// is on screen. A quote whose lines the agent has since rewritten simply stops
// locating, and the discussion is still listed as unanchored rather than
// silently dropped or pinned to the wrong paragraph.
import type {
  PlanReviewComment,
  PlanReviewDiscussion,
  PlanReviewSnapshotResult,
  PlanReviewVersion,
} from "@t3tools/contracts";
import { locateQuotedLineRange } from "@t3tools/shared/planReview";

export interface PlanReviewLineRow {
  /** 0-based index into the current version's markdown. */
  readonly lineIndex: number;
  readonly text: string;
  /** Discussion ids anchored to a range covering this line. */
  readonly discussionIds: ReadonlyArray<string>;
}

export interface PlanReviewDiscussionThread {
  readonly discussion: PlanReviewDiscussion;
  /** Oldest first, which is how a conversation reads. */
  readonly comments: ReadonlyArray<PlanReviewComment>;
  /** Null when the quote no longer matches the version on screen. */
  readonly startIndex: number | null;
  readonly endIndex: number | null;
}

export interface PlanReviewView {
  readonly markdown: string;
  readonly lines: ReadonlyArray<PlanReviewLineRow>;
  readonly currentVersion: PlanReviewVersion | null;
  readonly threads: ReadonlyArray<PlanReviewDiscussionThread>;
  readonly unresolvedCount: number;
}

/**
 * The version the reviewer is looking at.
 *
 * Prefers the revision the document names as current; falls back to the highest
 * revision present so a snapshot that arrives mid-write still renders something
 * rather than an empty plan.
 */
export function resolveCurrentPlanVersion(
  snapshot: Pick<PlanReviewSnapshotResult, "document" | "versions">,
): PlanReviewVersion | null {
  let fallback: PlanReviewVersion | null = null;
  for (const version of snapshot.versions) {
    if (version.revision === snapshot.document.currentRevision) return version;
    if (fallback === null || version.revision > fallback.revision) fallback = version;
  }
  return fallback;
}

function sortCommentsByCreation(
  comments: ReadonlyArray<PlanReviewComment>,
): ReadonlyArray<PlanReviewComment> {
  return [...comments].sort((left, right) => {
    const leftMs = Date.parse(left.createdAt);
    const rightMs = Date.parse(right.createdAt);
    if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) return 0;
    return leftMs - rightMs;
  });
}

/** Everything the plan-review screen renders, derived from one snapshot. */
export function buildPlanReviewView(snapshot: PlanReviewSnapshotResult): PlanReviewView {
  const currentVersion = resolveCurrentPlanVersion(snapshot);
  const markdown = currentVersion?.contentMarkdown ?? "";
  const textLines = markdown.replaceAll("\r\n", "\n").split("\n");

  const commentsByDiscussion = new Map<string, PlanReviewComment[]>();
  for (const comment of snapshot.comments) {
    const bucket = commentsByDiscussion.get(comment.discussionId);
    if (bucket) bucket.push(comment);
    else commentsByDiscussion.set(comment.discussionId, [comment]);
  }

  const threads: PlanReviewDiscussionThread[] = [];
  const discussionIdsByLine = new Map<number, string[]>();

  for (const discussion of snapshot.discussions) {
    const located = locateQuotedLineRange(markdown, discussion.quotedText);
    threads.push({
      discussion,
      comments: sortCommentsByCreation(commentsByDiscussion.get(discussion.discussionId) ?? []),
      startIndex: located?.startIndex ?? null,
      endIndex: located?.endIndex ?? null,
    });

    // Resolved discussions locate but do not decorate: the gutter should show
    // what still needs attention, not the full history of the review.
    if (located === null || discussion.isResolved) continue;
    for (let line = located.startIndex; line <= located.endIndex; line += 1) {
      const bucket = discussionIdsByLine.get(line);
      if (bucket) bucket.push(discussion.discussionId);
      else discussionIdsByLine.set(line, [discussion.discussionId]);
    }
  }

  const lines = textLines.map((text, lineIndex) => ({
    lineIndex,
    text,
    discussionIds: discussionIdsByLine.get(lineIndex) ?? [],
  }));

  return {
    markdown,
    lines,
    currentVersion,
    threads,
    unresolvedCount: snapshot.discussions.filter((discussion) => !discussion.isResolved).length,
  };
}

/**
 * The excerpt to store for a selected line range.
 *
 * The raw source lines are kept verbatim, because `locateQuotedLineRange`
 * normalizes both sides when it matches and the reviewer should see back what
 * they actually selected.
 */
export function quotedTextForLineRange(
  lines: ReadonlyArray<PlanReviewLineRow>,
  startIndex: number,
  endIndex: number,
): string {
  return lines
    .slice(startIndex, endIndex + 1)
    .map((line) => line.text)
    .join("\n");
}
