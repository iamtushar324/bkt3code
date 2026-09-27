/**
 * T3-CUSTOM(expbkt3): open pull request links in the integrated browser.
 *
 * Upstream opens a change request link in its own pull request view (the right-panel PR
 * surface, or the /pull-requests page). With `nativePullRequestViewEnabled` off — the fork's
 * default — the same click loads the host's own page in a browser tab beside the thread
 * instead, whatever "Open links in" says: the setting is about where PRs go, not links in
 * general. Without a thread there is nowhere to put that tab, so the link stays an ordinary
 * link and the caller opens it the way it opens any other.
 *
 * @module fork/pullRequestBrowserLinks
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { useCallback } from "react";

import { isWebUrl } from "~/browser/browserLinkTarget";
import { BrowserSettingsReadError, openUrlInPreview } from "~/browser/openFileInPreview";
import { recordVisitForThread } from "~/browserHistoryStore";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

/**
 * "native" leaves the click to upstream's pull request view, "app" opens the in-app browser,
 * "link" hands the click back to the caller as an ordinary link.
 */
export type PullRequestBrowserTarget = "native" | "app" | "link";

export function resolvePullRequestBrowserTarget(input: {
  readonly nativeViewEnabled: boolean;
  readonly url: string;
  readonly hasThread: boolean;
  readonly previewSupported: boolean;
}): PullRequestBrowserTarget {
  if (input.nativeViewEnabled) return "native";
  // Not a change request: upstream already treats it as a plain link, nothing to take over.
  if (parseChangeRequestUrl(input.url) === null) return "native";
  if (!input.hasThread || !input.previewSupported || !isWebUrl(input.url)) return "link";
  return "app";
}

/**
 * Returns an opener for upstream's change request link paths. `undefined` means the native
 * view is on and upstream should carry on; a boolean is the answer upstream would have given —
 * `true` when the link was taken and opened, `false` when the caller should open it itself.
 */
export function useOpenPullRequestInBrowserInstead(
  threadRef: ScopedThreadRef | null | undefined,
): (
  event: { readonly preventDefault: () => void; readonly stopPropagation: () => void },
  url: string,
  targetThreadRef?: ScopedThreadRef,
) => boolean | undefined {
  const nativeViewEnabled = useClientSettings((settings) => settings.nativePullRequestViewEnabled);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  return useCallback(
    (event, url, targetThreadRef) => {
      const resolvedThreadRef = targetThreadRef ?? threadRef ?? undefined;
      const target = resolvePullRequestBrowserTarget({
        nativeViewEnabled,
        url,
        hasThread: resolvedThreadRef !== undefined,
        previewSupported: isPreviewSupportedInRuntime(),
      });
      if (target === "native") return undefined;
      if (target === "link" || resolvedThreadRef === undefined) return false;
      event.preventDefault();
      event.stopPropagation();
      void openUrlInPreview({ threadRef: resolvedThreadRef, url, openPreview }).then((result) => {
        if (isAtomCommandInterrupted(result)) return;
        if (result._tag === "Success") {
          recordVisitForThread(resolvedThreadRef, url);
          return;
        }
        const failure = squashAtomCommandFailure(result);
        // The same fallback "Open links in" uses: the reader asked for the page, so an in-app
        // open that failed still lands in the system browser.
        if (!(failure instanceof BrowserSettingsReadError)) {
          console.error(result.cause);
          const api = readLocalApi();
          if (api) {
            void api.shell.openExternal(url);
            return;
          }
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open pull request link",
            description: failure instanceof Error ? failure.message : "An error occurred.",
          }),
        );
      });
      return true;
    },
    [nativeViewEnabled, openPreview, threadRef],
  );
}
