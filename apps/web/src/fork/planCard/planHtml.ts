/**
 * T3-CUSTOM(expbkt3): the page and frame size for one HTML part of a plan.
 *
 * Pure, so it is testable without the React frame that shows it.
 */
import {
  HTML_RENDER_MIN_HEIGHT,
  injectHtmlRenderBootstrap,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";

// A plan page can be long. The cap only stops a page with viewport-based
// heights from growing its frame without end.
const PLAN_HTML_MAX_HEIGHT = 16_000;
const PLAN_HTML_INITIAL_HEIGHT = 320;

// The chat's base style paints the thread background; a plan page sits on the
// card instead, so it starts transparent. The page's own CSS still wins.
const PLAN_PAGE_STYLE = "<style>html{background:transparent}</style>";
const THEME_STYLE_OPEN = '<style id="t3-theme">';

// The same declaration the bootstrap writes, with the same value cleaning.
function themeRule(theme: HtmlRenderTheme): string {
  const declarations = Object.entries(theme.variables)
    .filter(([name]) => /^--[a-z0-9-]+$/.test(name))
    .map(([name, value]) => `${name}:${String(value).replace(/[;{}<>]/g, "")};`)
    .join("");
  return `:root{color-scheme:${theme.appearance === "light" ? "light" : "dark"};${declarations}}`;
}

/**
 * The page as the frame loads it: the chat's theme bootstrap, the reader's
 * current theme (an inline frame has no URL fragment to carry it), then the
 * plan's base style. A later theme change rewrites the whole theme style.
 */
export function planHtmlDocument(html: string, theme?: HtmlRenderTheme): string {
  const document = injectHtmlRenderBootstrap(html);
  const open = document.indexOf(THEME_STYLE_OPEN);
  if (open === -1) return document;
  const close = document.indexOf("</style>", open);
  const scriptEnd = document.indexOf("</script>", open);
  if (close === -1 || scriptEnd === -1) return document;
  const at = scriptEnd + "</script>".length;
  return (
    document.slice(0, close) +
    (theme ? themeRule(theme) : "") +
    document.slice(close, at) +
    PLAN_PAGE_STYLE +
    document.slice(at)
  );
}

export function planHtmlFrameHeight(contentHeight: number | undefined): number {
  return Math.min(
    PLAN_HTML_MAX_HEIGHT,
    Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(contentHeight ?? PLAN_HTML_INITIAL_HEIGHT)),
  );
}

// Plan rows are virtualised, so a frame remounts as it scrolls back into view.
// Starting it at the height it last reported keeps the list from jumping.
const MEASURED_HEIGHT_LIMIT = 200;
const measuredHeights = new Map<string, number>();

/** A short, stable key for one page's markup. */
export function planHtmlKey(html: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < html.length; index += 1) {
    hash = Math.imul(hash ^ html.charCodeAt(index), 0x01000193);
  }
  return `${html.length}:${(hash >>> 0).toString(36)}`;
}

export function readPlanHtmlHeight(key: string): number | undefined {
  return measuredHeights.get(key);
}

export function rememberPlanHtmlHeight(key: string, height: number): void {
  measuredHeights.delete(key);
  measuredHeights.set(key, height);
  if (measuredHeights.size > MEASURED_HEIGHT_LIMIT) {
    const oldest = measuredHeights.keys().next().value;
    if (oldest !== undefined) measuredHeights.delete(oldest);
  }
}
