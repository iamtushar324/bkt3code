/**
 * T3-CUSTOM(expbkt3): splits a proposed plan into Markdown and live HTML parts.
 *
 * Providers call the plan field `planMarkdown` even when it holds HTML. A plan
 * card shows three shapes of HTML as a themed page instead of source:
 *
 * - the whole plan is one HTML document or one balanced root element (the same
 *   rule as the server's `detectPlanFormat` in apps/server/src/planreview);
 * - a raw HTML document (`<!doctype html>` or `<html>` at the start of a line,
 *   outside a code fence) inside a Markdown plan, up to its `</html>`;
 * - a fenced block tagged `html-render`, so an agent can mix a chart or mockup
 *   into a Markdown plan. A plain `html` fence stays code: a plan that proposes
 *   markup must still show the markup.
 */

export type PlanSegment =
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "html"; readonly html: string; readonly title: string };

export const PLAN_HTML_FENCE_LANGUAGE = "html-render";

const LEADING_COMMENTS = /^(?:<!--[\s\S]*?-->\s*)*/;
const DOCUMENT_START = /^\s{0,3}(?:<!doctype\s+html(?:\s[^>]*)?>|<html(?:\s|>))/i;

/** Whether the whole plan is HTML rather than Markdown. */
export function isHtmlPlan(content: string): boolean {
  const document = content.trim().replace(LEADING_COMMENTS, "");
  if (/^(?:<!doctype\s+html(?:\s[^>]*)?>\s*)?<html(?:\s|>)/i.test(document)) return true;
  // A balanced root fragment counts; an inline HTML example inside Markdown
  // does not, because it never closes the root at the very end.
  const root = /^<(body|main|article|section|div)(?:\s|>)/i.exec(document)?.[1];
  return root !== undefined && new RegExp(`</${root}>\\s*$`, "i").test(document);
}

const decodeEntities = (text: string) =>
  text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");

/** A readable title for an HTML part: its `<title>`, else its first heading. */
export function planHtmlTitle(html: string): string | null {
  const match =
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) ??
    /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html);
  const text = decodeEntities((match?.[1] ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text.slice(0, 200) : null;
}

function htmlSegment(html: string, fallbackTitle: string): PlanSegment {
  return { kind: "html", html, title: planHtmlTitle(html) ?? fallbackTitle };
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

/** The plan as ordered parts. Markdown parts keep their original text. */
export function splitPlanSegments(planMarkdown: string, fallbackTitle = "Plan"): PlanSegment[] {
  if (isHtmlPlan(planMarkdown)) return [htmlSegment(planMarkdown.trim(), fallbackTitle)];

  const lines = planMarkdown.split(/\r?\n/);
  const segments: PlanSegment[] = [];
  let markdown: string[] = [];
  const flushMarkdown = () => {
    if (markdown.some((line) => line.trim().length > 0)) {
      segments.push({ kind: "markdown", text: markdown.join("\n") });
    }
    markdown = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const close = new RegExp(`^\\s{0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      let end = index + 1;
      while (end < lines.length && !close.test(lines[end]!)) end += 1;
      if (fence[2]!.toLowerCase() === PLAN_HTML_FENCE_LANGUAGE) {
        flushMarkdown();
        segments.push(htmlSegment(lines.slice(index + 1, end).join("\n"), fallbackTitle));
      } else {
        markdown.push(...lines.slice(index, end + 1));
      }
      index = end;
      continue;
    }
    if (DOCUMENT_START.test(line)) {
      let end = index;
      while (end < lines.length && !/<\/html\s*>/i.test(lines[end]!)) end += 1;
      flushMarkdown();
      segments.push(
        htmlSegment(
          lines.slice(index, Math.min(end, lines.length - 1) + 1).join("\n"),
          fallbackTitle,
        ),
      );
      index = end;
      continue;
    }
    markdown.push(line);
  }
  flushMarkdown();
  return segments;
}

/** Whether any part of the plan renders as a page. */
export function planHasHtml(segments: ReadonlyArray<PlanSegment>): boolean {
  return segments.some((segment) => segment.kind === "html");
}
