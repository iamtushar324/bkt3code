// T3-CUSTOM(expbkt3): the pure rule behind `forkPreviewRuntimeFor`.
import type { PreviewBrowserHostSetting, PreviewRuntime } from "@t3tools/contracts";

/**
 * The runtime a new tab asks for. `undefined` is the desktop runtime: the
 * Electron app hosts the tab itself.
 */
export function resolvePreviewRuntime(input: {
  readonly serverBrowser: boolean;
  readonly desktopBrowser: boolean;
  readonly previewBrowser: PreviewBrowserHostSetting;
}): PreviewRuntime | undefined {
  if (!input.serverBrowser) return undefined;
  if (input.previewBrowser === "client" && input.desktopBrowser) return undefined;
  return "server";
}
