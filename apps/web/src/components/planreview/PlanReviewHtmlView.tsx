/**
 * T3-CUSTOM(expbkt3): read-only surface for an HTML plan.
 *
 * Providers sometimes emit the whole plan as a styled HTML document — charts,
 * animations and all. Rendering that inside the editor is not possible and not
 * desirable, so it goes into a sandboxed iframe instead. The reviewer can still
 * approve or send feedback; anchored comments inside the HTML need a
 * postMessage bridge and are deliberately not here yet.
 */
import { memo, useMemo } from "react";

interface PlanReviewHtmlViewProps {
  readonly html: string;
  readonly title: string;
}

function PlanReviewHtmlViewImpl({ html, title }: PlanReviewHtmlViewProps) {
  // `srcDoc` on an unmodified sandbox gives the document an opaque origin: its
  // scripts run so charts and animations work, but it cannot reach this page,
  // our cookies, or the network as us.
  const srcDoc = useMemo(() => {
    const hasDocumentShell = /<html[\s>]/i.test(html);
    if (hasDocumentShell) return html;
    return [
      "<!doctype html>",
      '<html><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      "<style>body{margin:0;padding:16px;font-family:system-ui,sans-serif}</style>",
      "</head><body>",
      html,
      "</body></html>",
    ].join("");
  }, [html]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <iframe
        // Keying on the content forces a fresh document when the version
        // changes; iframes do not re-run scripts on a srcDoc mutation alone.
        key={srcDoc.length}
        title={`${title} (HTML plan)`}
        srcDoc={srcDoc}
        className="min-h-0 w-full flex-1 border-0 bg-white"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

export const PlanReviewHtmlView = memo(PlanReviewHtmlViewImpl);
