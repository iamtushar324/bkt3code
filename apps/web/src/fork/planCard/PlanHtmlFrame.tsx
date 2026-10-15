/**
 * T3-CUSTOM(expbkt3): one HTML part of a plan, shown like an agent's HTML render.
 *
 * It reuses the chat's `HtmlRenderDocument`, so the page gets the same sandbox,
 * the app's theme variables before first paint, live theme changes, link
 * handling, and a frame that grows to the page's height. The plan's HTML has
 * no stored attachment, so the bootstrapped page is served from a blob URL that
 * lives as long as the frame.
 */
import { useEffect, useState } from "react";

import { HtmlRenderDocument } from "../../components/files/BrowserDocumentFrame";
import { planHtmlDocument, planHtmlFrameHeight } from "./planHtml";

export function PlanHtmlFrame({ html, title }: { readonly html: string; readonly title: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [contentHeight, setContentHeight] = useState<number>();
  useEffect(() => {
    const url = URL.createObjectURL(
      new Blob([planHtmlDocument(html)], { type: "text/html;charset=utf-8" }),
    );
    // oxlint-disable-next-line react/set-state-in-effect -- The URL exists only while this effect owns it.
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [html]);

  return (
    <div
      className="my-3 min-w-0 first:mt-0 last:mb-0"
      style={{ height: planHtmlFrameHeight(contentHeight) }}
      data-plan-html-frame
    >
      {src !== null ? (
        <HtmlRenderDocument
          // A new page needs a new frame: the document keeps its first URL.
          key={src}
          src={src}
          title={title}
          className="block size-full"
          onContentHeight={setContentHeight}
        />
      ) : null}
    </div>
  );
}
