/**
 * T3-CUSTOM(expbkt3): the "Open links in" answer every upstream reader should use. With
 * `openLinksInIntegratedBrowser` on (the fork's default) links open in the integrated browser
 * whatever Settings → Integrations → Browser says. Kept free of imports so
 * `browser/browserLinkTarget` can depend on it without a cycle.
 *
 * @module fork/effectiveBrowserLinkTarget
 */
import type { BrowserLinkTarget } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";

export function effectiveBrowserLinkTarget(
  settings: Pick<ClientSettings, "browserLinkTarget" | "openLinksInIntegratedBrowser">,
): BrowserLinkTarget {
  return settings.openLinksInIntegratedBrowser ? "app" : settings.browserLinkTarget;
}
