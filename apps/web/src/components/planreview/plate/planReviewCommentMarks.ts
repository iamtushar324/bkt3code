/**
 * T3-CUSTOM(expbkt3): re-locating a saved comment anchor inside the editor.
 *
 * A comment created in this session is marked from the live selection, which is
 * exact. Everything else — reopening the panel, a teammate's comment arriving
 * over the subscription — has only the quoted text the server stored, so the
 * anchor has to be found again.
 *
 * The search runs over the editor's *rendered* text, which is the same domain the
 * quote was captured from, and shares `planReviewAnchorText` with the server so
 * both agree on what makes two lines the same.
 *
 * Kept pure and free of Plate types: the editor supplies a flattened view of its
 * leaves and receives a range back, so all of this is testable with plain
 * objects and none of it needs an editor instance.
 */
import { planReviewAnchorText } from "@t3tools/shared/planReview";

/** One text leaf: where it lives in the tree, and what it reads. */
export interface PlanReviewLeaf {
  readonly path: ReadonlyArray<number>;
  readonly text: string;
}

/** A run of leaves the renderer draws as one line. */
export interface PlanReviewBlock {
  readonly leaves: ReadonlyArray<PlanReviewLeaf>;
}

export interface PlanReviewPoint {
  readonly path: ReadonlyArray<number>;
  readonly offset: number;
}

export interface PlanReviewRange {
  readonly anchor: PlanReviewPoint;
  readonly focus: PlanReviewPoint;
}

/**
 * The minimum of a Slate node this module needs to walk a tree.
 *
 * The index signature is load-bearing rather than laziness: a leaf carries its
 * marks as arbitrary properties, and `stripPlanReviewCommentMarks` exists
 * precisely to read and remove the ones it does not know the names of up front.
 */
export interface PlanReviewNodeLike {
  readonly text?: string;
  readonly children?: ReadonlyArray<PlanReviewNodeLike>;
  readonly [markKey: string]: unknown;
}

function isTextNode(node: PlanReviewNodeLike): boolean {
  return typeof node.text === "string";
}

/**
 * Flattens a node tree into the blocks the reader sees as lines.
 *
 * A block is the deepest element whose own children are text — a paragraph, a
 * heading, or a list item's content. Taking the deepest one matters: a list's
 * top-level node would collapse every item into a single line and destroy the
 * line-by-line matching the anchors rely on.
 */
export function collectPlanReviewBlocks(
  nodes: ReadonlyArray<PlanReviewNodeLike>,
  basePath: ReadonlyArray<number> = [],
): ReadonlyArray<PlanReviewBlock> {
  const blocks: PlanReviewBlock[] = [];

  nodes.forEach((node, index) => {
    const path = [...basePath, index];
    const children = node.children;
    if (children === undefined || children.length === 0) return;

    if (children.every(isTextNode)) {
      blocks.push({
        leaves: children.map((child, childIndex) => ({
          path: [...path, childIndex],
          text: child.text ?? "",
        })),
      });
      return;
    }

    // Mixed children (a paragraph holding an inline link beside plain text) are
    // still one line, so collect the text leaves at this level and recurse into
    // the elements. Both contribute, in document order.
    const nestedBlocks = collectPlanReviewBlocks(children, path);
    const ownLeaves = children.flatMap((child, childIndex) =>
      isTextNode(child) ? [{ path: [...path, childIndex], text: child.text ?? "" }] : [],
    );
    if (ownLeaves.length > 0 && nestedBlocks.length === 0) {
      blocks.push({ leaves: ownLeaves });
      return;
    }
    blocks.push(...nestedBlocks);
  });

  return blocks;
}

function blockText(block: PlanReviewBlock): string {
  return block.leaves.map((leaf) => leaf.text).join("");
}

/**
 * Converts an offset measured across a block's concatenated text into a point in
 * the leaf that actually holds that character.
 *
 * An offset at a leaf boundary resolves to the end of the earlier leaf rather
 * than the start of the next, so a range never begins on a leaf it does not
 * cover — Slate would widen the mark by one leaf.
 */
function toPoint(block: PlanReviewBlock, offset: number): PlanReviewPoint | null {
  let consumed = 0;
  for (const leaf of block.leaves) {
    if (offset <= consumed + leaf.text.length) {
      return { path: leaf.path, offset: offset - consumed };
    }
    consumed += leaf.text.length;
  }
  const lastLeaf = block.leaves.at(-1);
  return lastLeaf ? { path: lastLeaf.path, offset: lastLeaf.text.length } : null;
}

/**
 * Finds where `line` starts inside `text`.
 *
 * Tries the raw text first, so an exact quote marks exactly what was selected,
 * and falls back to the projected form for a quote whose formatting was
 * flattened on the way out. Returns the whole line when neither hits, which is
 * the honest answer for a line the projection matched only as a whole.
 */
function findLineSpan(text: string, line: string): { start: number; end: number } {
  const rawIndex = text.indexOf(line);
  if (rawIndex >= 0) return { start: rawIndex, end: rawIndex + line.length };

  const projectedIndex = planReviewAnchorText(text).indexOf(line);
  if (projectedIndex >= 0) {
    const leadingLength = text.length - text.trimStart().length;
    return { start: leadingLength, end: text.length };
  }

  return { start: 0, end: text.length };
}

/**
 * Locates quoted text in the editor and returns the range to mark, or null.
 *
 * Mirrors `locateQuotedLineRange` in `@t3tools/shared/planReview`: same
 * projection, same containment test, same tolerance for blank lines between
 * quoted lines. It differs only in what it returns — a range into the tree
 * rather than line indices into markdown.
 */
export function locatePlanReviewQuoteRange(
  blocks: ReadonlyArray<PlanReviewBlock>,
  quotedText: string,
): PlanReviewRange | null {
  const quoteLines = quotedText
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map(planReviewAnchorText)
    .filter((line) => line.length > 0);
  if (quoteLines.length === 0) return null;

  const projected = blocks.map((block) => planReviewAnchorText(blockText(block)));

  for (let start = 0; start < projected.length; start += 1) {
    if (!projected[start]!.includes(quoteLines[0]!)) continue;

    let matched = 1;
    let cursor = start + 1;
    while (matched < quoteLines.length && cursor < projected.length) {
      if (projected[cursor] === "") {
        cursor += 1;
        continue;
      }
      if (!projected[cursor]!.includes(quoteLines[matched]!)) break;
      matched += 1;
      cursor += 1;
    }
    if (matched !== quoteLines.length) continue;

    const startBlock = blocks[start]!;
    const endBlock = blocks[cursor - 1]!;
    const startSpan = findLineSpan(blockText(startBlock), quoteLines[0]!);
    const endSpan =
      startBlock === endBlock
        ? startSpan
        : findLineSpan(blockText(endBlock), quoteLines[quoteLines.length - 1]!);

    const anchor = toPoint(startBlock, startSpan.start);
    const focus = toPoint(endBlock, endSpan.end);
    if (anchor === null || focus === null) return null;
    return { anchor, focus };
  }

  return null;
}

/**
 * Returns the document as it would read with no comments on it.
 *
 * Plate serializes a commented leaf as an MDX JSX element, which
 * `mdast-util-to-markdown` cannot stringify — inside a table cell it throws
 * outright. The editor treats "cannot serialize" as a reviewer edit, so simply
 * highlighting a sentence used to mark the plan dirty and make the panel re-send
 * the entire document as a reviewer edit. Stripping the marks first means a
 * comment can never influence what the agent is told changed.
 *
 * Leaves that `split: true` fragmented are merged back when nothing else
 * distinguishes them, so the serialized text matches the unmarked document
 * exactly rather than merely closely.
 */
export function stripPlanReviewCommentMarks<T>(nodes: ReadonlyArray<T>): ReadonlyArray<T> {
  return nodes.map((node) => stripNode(node as PlanReviewNodeLike) as T);
}

function isCommentProperty(key: string): boolean {
  return key === "comment" || key.startsWith("comment_") || key === "commentTransient";
}

function stripNode(node: PlanReviewNodeLike): PlanReviewNodeLike {
  const children = node.children;
  if (children === undefined) {
    return stripLeaf(node);
  }
  return { ...node, children: mergeAdjacentLeaves(children.map(stripNode)) };
}

function stripLeaf(leaf: PlanReviewNodeLike): PlanReviewNodeLike {
  const entries = Object.entries(leaf).filter(([key]) => !isCommentProperty(key));
  return Object.fromEntries(entries) as PlanReviewNodeLike;
}

/** Two leaves merge when their text is the only thing that differs. */
function sameFormatting(left: PlanReviewNodeLike, right: PlanReviewNodeLike): boolean {
  if (left.children !== undefined || right.children !== undefined) return false;
  const key = (node: PlanReviewNodeLike) =>
    JSON.stringify(
      Object.entries(node)
        .filter(([name]) => name !== "text")
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  return key(left) === key(right);
}

function mergeAdjacentLeaves(
  nodes: ReadonlyArray<PlanReviewNodeLike>,
): ReadonlyArray<PlanReviewNodeLike> {
  const merged: PlanReviewNodeLike[] = [];
  for (const node of nodes) {
    const previous = merged.at(-1);
    if (previous !== undefined && sameFormatting(previous, node)) {
      merged[merged.length - 1] = { ...previous, text: (previous.text ?? "") + (node.text ?? "") };
      continue;
    }
    merged.push(node);
  }
  return merged;
}
