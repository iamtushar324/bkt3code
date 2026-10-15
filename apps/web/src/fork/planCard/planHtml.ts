/**
 * T3-CUSTOM(expbkt3): the page and frame size for one HTML part of a plan.
 *
 * Pure, so it is testable without the React frame that shows it.
 */
import { HTML_RENDER_MIN_HEIGHT, injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";

// A plan page can be long. The cap only stops a page with viewport-based
// heights from growing its frame without end.
const PLAN_HTML_MAX_HEIGHT = 16_000;
const PLAN_HTML_INITIAL_HEIGHT = 320;

// The chat's base style paints the thread background; a plan page sits on the
// card instead, so it starts transparent. The page's own CSS still wins.
const PLAN_PAGE_STYLE = "<style>html{background:transparent}</style>";

/** The page as the frame loads it: the chat's theme bootstrap, then the plan's base style. */
export function planHtmlDocument(html: string): string {
  const document = injectHtmlRenderBootstrap(html);
  const theme = document.indexOf('<style id="t3-theme">');
  const scriptEnd = theme === -1 ? -1 : document.indexOf("</script>", theme);
  if (scriptEnd === -1) return document;
  const at = scriptEnd + "</script>".length;
  return document.slice(0, at) + PLAN_PAGE_STYLE + document.slice(at);
}

export function planHtmlFrameHeight(contentHeight: number | undefined): number {
  return Math.min(
    PLAN_HTML_MAX_HEIGHT,
    Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(contentHeight ?? PLAN_HTML_INITIAL_HEIGHT)),
  );
}
