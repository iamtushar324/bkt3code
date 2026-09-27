/**
 * T3-CUSTOM(expbkt3): shared, dependency-free plan-review prompt format.
 *
 * The server builds these blocks and the web transcript parses them, so the
 * format lives here rather than in either app. `<review_comment>` deliberately
 * matches the existing file/diff review format in
 * `apps/web/src/reviewCommentContext.ts` — that parser already renders these
 * blocks as cards, so anchored plan feedback needs no new transcript UI.
 */

export interface PlanReviewAnchoredComment {
  /**
   * 0-based inclusive line indices into the reviewed markdown, or null when the
   * quote could not be located. Null omits the range attributes entirely rather
   * than claiming line 1, which would point the model at the wrong place.
   */
  readonly startIndex: number | null;
  readonly endIndex: number | null;
  /** The lines the reviewer selected, quoted back for the model. */
  readonly quotedText: string;
  /** The reviewer's note. */
  readonly body: string;
  readonly authorLabel: string | null;
}

export interface PlanReviewFeedbackInput {
  readonly documentId: string;
  readonly planTitle: string;
  readonly globalComment: string;
  readonly comments: ReadonlyArray<PlanReviewAnchoredComment>;
  /**
   * Set whenever the reviewer edited the plan. Plate normalizes Markdown
   * source, so the complete document is the only formatting-independent
   * representation of the reviewer's intent.
   */
  readonly fullDocument: string | null;
}

export interface PlanReviewApprovalInput {
  readonly documentId: string;
  readonly planTitle: string;
  readonly notes: string;
  readonly comments: ReadonlyArray<PlanReviewAnchoredComment>;
  /**
   * One complete approved document. Present after any reviewer edit, because
   * Markdown editors normalize source formatting and a source diff can lie
   * about what the reviewer changed. Also present when context was lost.
   */
  readonly fullPlanMarkdown: string | null;
  readonly fullPlanReason: string | null;
  readonly wasEdited: boolean;
}

/**
 * Marks a `<review_comment>` as anchored plan feedback rather than file or diff
 * feedback. The transcript reads it to pick a card: a plan comment quotes prose
 * and names a plan, where a file comment names a path and renders a patch.
 */
export const PLAN_REVIEW_SECTION_ID_PREFIX = "plan:";

export function isPlanReviewSectionId(sectionId: string): boolean {
  return sectionId.startsWith(PLAN_REVIEW_SECTION_ID_PREFIX);
}

/**
 * The plan-review document a `plan:<documentId>` section id refers to.
 *
 * The inverse of the section id `formatPlanReviewComment` writes. Returns null
 * for any other section id, so a caller can treat "not a plan comment" and
 * "malformed plan comment" the same way.
 */
export function planReviewDocumentIdFromSectionId(sectionId: string): string | null {
  if (!isPlanReviewSectionId(sectionId)) return null;
  const documentId = sectionId.slice(PLAN_REVIEW_SECTION_ID_PREFIX.length).trim();
  return documentId.length > 0 ? documentId : null;
}

/**
 * Recovers the plan title from the synthetic `filePath` the block carries.
 *
 * `filePath` exists because the transcript card and the prompt format are shared
 * with file review; for a plan it is the title plus `.md` and never a real path.
 */
export function planReviewCommentTitle(filePath: string): string {
  return filePath.replace(/\.md$/, "");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Picks a fence long enough to survive backticks inside the content. */
export function planReviewFence(language: string, contents: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(contents.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [`${fence}${language}`, contents.trimEnd(), fence].join("\n");
}

function rangeLabel(startIndex: number, endIndex: number): string {
  const start = startIndex + 1;
  const end = endIndex + 1;
  return start === end ? `L${start}` : `L${start} to L${end}`;
}

/**
 * Projects one line onto the text a reader would select from the rendered plan.
 *
 * Anchors arrive from `window.getSelection().toString()` over rendered Plate
 * output, where markdown syntax is already gone — a reviewer commenting on
 * `1. **Outbound email context**` sends `1. Outbound email context`. Comparing
 * that against the raw source misses every emphasised, code-spanned or linked
 * line, which is most of them. Both sides are projected before comparison so
 * the containment test runs in one domain.
 *
 * Deliberately syntactic and lossy: it only has to make the same two strings
 * agree, never to reconstruct the source.
 *
 * Exported because the editor re-locates the same anchors to restore comment
 * highlights, and the two must agree on what "the same line" means.
 */
export function planReviewAnchorText(line: string): string {
  return (
    line
      // Leading block syntax: heading hashes, blockquote markers, list markers
      // and task checkboxes are all chrome the renderer draws separately, so a
      // selection may or may not carry them.
      .replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/, "")
      // Images before links: `![alt](url)` must not leave a stray `!`.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      // Single-character emphasis last, so `**x**` has already collapsed and
      // cannot be mistaken for two nested italics.
      .replace(/(?<![*_\w])[*_]([^*_]+)[*_](?![*_\w])/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function formatPlanReviewComment(
  documentId: string,
  planTitle: string,
  comment: PlanReviewAnchoredComment,
): string {
  const located = comment.startIndex !== null && comment.endIndex !== null;
  const attributes = [
    `sectionId="${escapeAttribute(`plan:${documentId}`)}"`,
    `sectionTitle="${escapeAttribute("Plan review")}"`,
    `filePath="${escapeAttribute(`${planTitle}.md`)}"`,
    ...(located
      ? [
          `startIndex="${comment.startIndex}"`,
          `endIndex="${comment.endIndex}"`,
          `rangeLabel="${escapeAttribute(rangeLabel(comment.startIndex!, comment.endIndex!))}"`,
        ]
      : [`rangeLabel="${escapeAttribute("quoted text")}"`]),
    // An attribute rather than a `— Name` line appended to the body: the
    // transcript card renders it as a byline, and the body stays the reviewer's
    // words alone.
    ...(comment.authorLabel ? [`author="${escapeAttribute(comment.authorLabel)}"`] : []),
  ].join(" ");

  return [
    `<review_comment ${attributes}>`,
    comment.body.trim(),
    planReviewFence("markdown", comment.quotedText),
    "</review_comment>",
  ].join("\n");
}

const FEEDBACK_HEADER = [
  "Revise the plan you proposed. Respond with the complete revised plan.",
  "Do not modify repository files while planning.",
].join("\n");

/**
 * Builds the revision prompt. The plan body is deliberately absent — the model
 * authored it and still has it in context; only the deltas are sent.
 */
export function buildPlanReviewFeedbackPrompt(input: PlanReviewFeedbackInput): string {
  const sections: string[] = [FEEDBACK_HEADER];

  const globalComment = input.globalComment.trim();
  if (globalComment.length > 0) sections.push(globalComment);

  for (const comment of input.comments) {
    sections.push(formatPlanReviewComment(input.documentId, input.planTitle, comment));
  }

  if (input.fullDocument !== null) {
    sections.push(
      [
        `<plan_edit filePath="${escapeAttribute(`${input.planTitle}.md`)}" mode="full">`,
        "The complete reviewer-edited document follows. Use it as the source of truth.",
        planReviewFence("markdown", input.fullDocument),
        "</plan_edit>",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

/**
 * Builds the approval prompt. The context-efficient policy has three shapes:
 * one line for an unchanged plan, only comments/notes for feedback without an
 * edit, or one complete source-of-truth plan after a reviewer edit. A raw diff
 * is never sent because Markdown normalization makes it untrustworthy.
 */
export function buildPlanReviewApprovalPrompt(input: PlanReviewApprovalInput): string {
  const sections: string[] = [];
  const notes = input.notes.trim();
  /**
   * Approving with comments open is a deliberate act, not an oversight: the
   * reviewer wants implementation to start and has refinements to fold in on the
   * way. Telling the model to implement "exactly as written" and then handing it
   * a list of changes contradicts itself, so the instruction changes instead.
   */
  const hasRefinements = input.comments.length > 0 || notes.length > 0;

  if (input.fullPlanMarkdown !== null) {
    sections.push(
      input.wasEdited
        ? "Plan approved with reviewer edits. Implement this complete revised plan:"
        : "PLEASE IMPLEMENT THIS APPROVED PLAN:",
    );
    sections.push(planReviewFence("markdown", input.fullPlanMarkdown));
    if (input.fullPlanReason !== null) {
      sections.push(`(The full plan is repeated because ${input.fullPlanReason}.)`);
    }
  } else {
    sections.push(
      hasRefinements
        ? "Plan approved — start implementing it now."
        : "Plan approved. Implement the plan you proposed above, exactly as written.",
    );
  }

  if (hasRefinements) {
    sections.push(
      [
        "The reviewer approved the plan and left the refinements below. Treat them as",
        "amendments to the approved plan and apply them as you implement. Do not go back",
        "to planning or wait for another approval.",
      ].join("\n"),
    );
  }

  for (const comment of input.comments) {
    sections.push(formatPlanReviewComment(input.documentId, input.planTitle, comment));
  }

  if (notes.length > 0) {
    sections.push(`Reviewer notes:\n${notes}`);
  }

  return sections.join("\n\n");
}

/**
 * Locates a quoted excerpt in the reviewed markdown and returns its 0-based
 * inclusive line range. Plate anchors comments to document marks, so line
 * numbers are derived at submit time from the quoted text.
 */
export function locateQuotedLineRange(
  markdown: string,
  quotedText: string,
): { readonly startIndex: number; readonly endIndex: number } | null {
  const quoteLines = quotedText
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map(planReviewAnchorText)
    .filter((line) => line.length > 0);
  if (quoteLines.length === 0) return null;

  const documentLines = markdown.replaceAll("\r\n", "\n").split("\n");
  const trimmedDocument = documentLines.map(planReviewAnchorText);

  for (let start = 0; start < trimmedDocument.length; start += 1) {
    if (!trimmedDocument[start]?.includes(quoteLines[0]!)) continue;

    let matched = 1;
    let cursor = start + 1;
    while (matched < quoteLines.length && cursor < trimmedDocument.length) {
      // Blank lines in the document do not break a multi-line quote match.
      if (trimmedDocument[cursor] === "") {
        cursor += 1;
        continue;
      }
      if (!trimmedDocument[cursor]!.includes(quoteLines[matched]!)) break;
      matched += 1;
      cursor += 1;
    }

    if (matched === quoteLines.length) {
      return { startIndex: start, endIndex: cursor - 1 };
    }
  }

  return null;
}
