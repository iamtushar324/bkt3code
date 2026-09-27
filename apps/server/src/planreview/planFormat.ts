/**
 * T3-CUSTOM(expbkt3): Detect the renderer from provider-authored plan content.
 * Native provider contracts call the field `planMarkdown` even when its value
 * is an HTML document or a self-contained visual HTML fragment.
 */
export function detectPlanFormat(content: string): "md" | "html" {
  const document = content.trim();
  const withoutLeadingComments = document.replace(/^(?:<!--[\s\S]*?-->\s*)*/i, "");
  if (/^(?:<!doctype\s+html(?:\s[^>]*)?>\s*)?<html(?:\s|>)/i.test(withoutLeadingComments)) {
    return "html";
  }

  // Providers such as Claude may emit the entire visual plan as one balanced
  // root fragment instead of adding document-level html/head/body elements.
  // Requiring the matching closing root avoids treating ordinary Markdown
  // containing an inline HTML example as an HTML plan.
  const rootedFragment = /^<(body|main|article|section|div)(?:\s|>)/i.exec(withoutLeadingComments);
  if (rootedFragment) {
    const root = rootedFragment[1];
    if (new RegExp(`</${root}>\\s*$`, "i").test(withoutLeadingComments)) {
      return "html";
    }
  }

  return "md";
}

const LEGACY_REVIEW_MARKER_PATTERN = /<!--\s*t3-plannotator:\/plannotator\/[A-Za-z0-9_-]+\/\s*-->/g;

/**
 * Plans persisted while the retired external review tool was enabled carry a
 * hidden marker comment. Strip it so it never reaches a plan-review document.
 */
export function withoutLegacyReviewMarker(planMarkdown: string): string {
  return planMarkdown.replace(LEGACY_REVIEW_MARKER_PATTERN, "").trimEnd();
}
