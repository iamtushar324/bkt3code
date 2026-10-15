/**
 * T3-CUSTOM(expbkt3): one HTML part of a plan, shown like an agent's HTML render.
 *
 * It follows the chat's `HtmlRenderDocument`: the same theme bootstrap and
 * messages, link handling, and a frame that grows to the page's height. The
 * plan's HTML has no stored attachment, so the page loads inline through
 * `srcDoc`. With no `allow-same-origin`, it runs in an opaque origin that
 * cannot reach this app, even when its frame is opened on its own.
 */
import {
  htmlRenderResult,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
} from "@t3tools/shared/htmlRender";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useHtmlRenderTheme } from "../../hooks/useHtmlRenderTheme";
import {
  planHtmlDocument,
  planHtmlFrameHeight,
  planHtmlKey,
  readPlanHtmlHeight,
  rememberPlanHtmlHeight,
} from "./planHtml";

export function PlanHtmlFrame({ html, title }: { readonly html: string; readonly title: string }) {
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const key = useMemo(() => planHtmlKey(html), [html]);
  // The first theme is written into the page so its first paint is themed;
  // later changes are posted to it, which does not reload the page.
  const [initialTheme] = useState(theme);
  const srcDoc = useMemo(() => planHtmlDocument(html, initialTheme), [html, initialTheme]);
  const [contentHeight, setContentHeight] = useState(() => readPlanHtmlHeight(key));
  const [loaded, setLoaded] = useState(false);
  const postTheme = () => {
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  };
  useEffect(postTheme, [theme]);
  // As in the chat: the page asks to open a link, and it opens only while the
  // frame has focus and the reader has just used the app.
  useEffect(() => {
    const openLink = (event: MessageEvent) => {
      const frame = frameRef.current;
      const request = readHtmlRenderLinkRequest(event.data);
      if (
        request === undefined ||
        frame === null ||
        event.source !== frame.contentWindow ||
        document.activeElement !== frame ||
        navigator.userActivation?.isActive === false
      ) {
        return;
      }
      window.open(request.url, "_blank", "noopener,noreferrer");
      frame.contentWindow?.postMessage(htmlRenderResult(request.id), "*");
    };
    window.addEventListener("message", openLink);
    return () => window.removeEventListener("message", openLink);
  }, []);
  // Listen from the commit that inserts the frame, so a fast page's first
  // height report is not missed.
  useLayoutEffect(() => {
    const resize = (event: MessageEvent) => {
      const height = readHtmlRenderContentHeight(event.data);
      if (height !== undefined && event.source === frameRef.current?.contentWindow) {
        rememberPlanHtmlHeight(key, height);
        setContentHeight(height);
      }
    };
    window.addEventListener("message", resize);
    return () => window.removeEventListener("message", resize);
  }, [key]);

  return (
    <div
      className="my-3 min-w-0 first:mt-0 last:mb-0"
      style={{ height: planHtmlFrameHeight(contentHeight) }}
      data-plan-html-frame
    >
      <iframe
        ref={frameRef}
        srcDoc={srcDoc}
        title={title}
        // Never allow-same-origin: the opaque origin keeps the page out of the app's session.
        sandbox="allow-scripts allow-forms"
        loading="lazy"
        referrerPolicy="no-referrer"
        onLoad={() => {
          setLoaded(true);
          // Covers a theme change that landed while the page was loading.
          postTheme();
        }}
        // A frame whose color scheme differs from its document's paints an
        // opaque canvas, so the blank start would flash white in dark mode.
        className="block size-full border-0 scheme-light"
        style={loaded ? { colorScheme: theme.appearance } : undefined}
      />
    </div>
  );
}
