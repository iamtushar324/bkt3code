/**
 * T3-CUSTOM(expbkt3): CSS custom highlights for review-comment quotes.
 *
 * One `Highlight` per kind lives in `CSS.highlights` for the page's lifetime;
 * each message adds and removes its own ranges. Keeping the registry entries
 * around (rather than deleting them at size zero, as upstream's citation
 * highlight does) makes add/remove from many messages order-independent.
 */
import "./threadComments.css";

import { THREAD_COMMENT_ACTIVE_HIGHLIGHT } from "./model";

const highlights = new Map<string, Highlight>();

export function highlightsSupported(): boolean {
  return typeof Highlight !== "undefined" && typeof CSS !== "undefined" && Boolean(CSS.highlights);
}

export function highlightFor(name: string): Highlight | null {
  if (!highlightsSupported()) return null;
  let highlight = highlights.get(name);
  if (!highlight || CSS.highlights.get(name) !== highlight) {
    highlight = new Highlight();
    // The emphasised range paints over the kind colour beneath it.
    if (name === THREAD_COMMENT_ACTIVE_HIGHLIGHT) highlight.priority = 1;
    CSS.highlights.set(name, highlight);
    highlights.set(name, highlight);
  }
  return highlight;
}

export function removeRangeFromHighlights(range: Range): void {
  for (const highlight of highlights.values()) highlight.delete(range);
}
