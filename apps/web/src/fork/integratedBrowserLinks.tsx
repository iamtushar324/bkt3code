/**
 * T3-CUSTOM(expbkt3): every link opens in the integrated browser.
 *
 * Upstream sends links to the system browser unless Settings → Integrations → Browser says
 * otherwise, and several surfaces (the sidebar's Linear and pull request chips, plain
 * `target="_blank"` anchors) ignore that setting and always leave the app. With
 * `openLinksInIntegratedBrowser` on — the fork's default — a plain click on any web link opens
 * it in a browser tab beside the open thread instead. Cmd/Ctrl-click still goes to the system
 * browser, and so does any click with no thread to open beside.
 *
 * Three pieces make that hold everywhere:
 * - `effectiveBrowserLinkTarget` (its own module) is what upstream's "Open links in" readers consult, so chat
 *   markdown, `useOpenLink` callers and the terminal all follow the flag.
 * - `IntegratedBrowserLinkInterceptor` catches the remaining anchors after React has run their
 *   own handlers, so a link that already routes itself is left alone.
 * - `useOpenInIntegratedBrowser` is for buttons that open a URL themselves.
 *
 * @module fork/integratedBrowserLinks
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect } from "react";

import { isWebUrl } from "~/browser/browserLinkTarget";
import { useOpenLink } from "~/browser/useOpenLink";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { getClientSettings } from "~/hooks/useSettings";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";

/**
 * Whether a document-level click on `anchor` should be taken over. Only a plain primary click
 * on an http(s) link that leaves the app and that nothing else has already handled.
 */
export function shouldInterceptLinkClick(input: {
  readonly enabled: boolean;
  readonly defaultPrevented: boolean;
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly href: string | null;
  readonly hasDownload: boolean;
  readonly appOrigin: string;
}): boolean {
  if (!input.enabled || input.defaultPrevented || input.button !== 0) return false;
  if (input.metaKey || input.ctrlKey || input.shiftKey || input.altKey) return false;
  if (input.href === null || input.hasDownload || !isWebUrl(input.href)) return false;
  // Same-origin links are the app's own routes.
  return new URL(input.href).origin !== input.appOrigin;
}

/**
 * Whether a click on a link will land in the integrated browser rather than the system one: the
 * flag is on, this client has an integrated browser, and no Cmd/Ctrl escape hatch was used.
 * Callers that navigate to a thread before opening its link use this to leave a Cmd/Ctrl-click
 * where it is.
 */
export function opensInIntegratedBrowser(event?: {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}): boolean {
  if (event?.metaKey || event?.ctrlKey) return false;
  return getClientSettings().openLinksInIntegratedBrowser && isPreviewSupportedInRuntime();
}

/** The thread the open chat route shows; set by the interceptor, read by link buttons. */
let activeThreadRef: ScopedThreadRef | null = null;

/**
 * Opens a URL in the integrated browser beside the open thread (or `fallbackThreadRef` when no
 * thread is open), following the flag and the Cmd/Ctrl escape hatch like every other link.
 */
export function useOpenInIntegratedBrowser(): (
  url: string,
  options?: {
    readonly event?: { readonly metaKey: boolean; readonly ctrlKey: boolean };
    /** Open beside this thread rather than the open one, e.g. a sidebar row just navigated to. */
    readonly threadRef?: ScopedThreadRef | null;
    readonly fallbackThreadRef?: ScopedThreadRef | null;
    readonly failureTitle?: string;
  },
) => void {
  const openLink = useOpenLink(null);
  return useCallback(
    (url, options = {}) => {
      const threadRef =
        options.threadRef ?? activeThreadRef ?? options.fallbackThreadRef ?? undefined;
      void openLink(url, {
        ...(options.event ? { event: options.event } : {}),
        threadRef,
      }).catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: options.failureTitle ?? "Unable to open link",
            description: error instanceof Error ? error.message : "The link could not be opened.",
          }),
        );
      });
    },
    [openLink],
  );
}

/** Mounted once in the chat layout. Renders nothing. */
export function IntegratedBrowserLinkInterceptor({
  threadRef,
}: {
  readonly threadRef: ScopedThreadRef | null;
}) {
  const open = useOpenInIntegratedBrowser();
  useEffect(() => {
    activeThreadRef = threadRef;
    return () => {
      if (activeThreadRef === threadRef) activeThreadRef = null;
    };
  }, [threadRef]);
  useEffect(() => {
    // Bubble phase on the document: React's own handlers (chat markdown, the pull request
    // opener) have already run and marked the event if they took it.
    const onClick = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (
        !shouldInterceptLinkClick({
          enabled: getClientSettings().openLinksInIntegratedBrowser,
          defaultPrevented: event.defaultPrevented,
          button: event.button,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          href: anchor.href || null,
          hasDownload: anchor.hasAttribute("download"),
          appOrigin: window.location.origin,
        })
      )
        return;
      // With no thread there is nowhere to put the tab; the link behaves as it always did.
      if (activeThreadRef === null) return;
      event.preventDefault();
      open(anchor.href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [open]);
  return null;
}
