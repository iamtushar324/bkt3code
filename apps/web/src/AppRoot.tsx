import { RouterProvider } from "@tanstack/react-router";

import { BrowserProfileReporter } from "./browser/BrowserProfileReporter";
import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
// T3-CUSTOM(expbkt3): connect the built-in toolyard integration once per app load.
import { ToolyardAutoConnect } from "./fork/toolyardAutoConnect";

/**
 * The Electron browser host intentionally sits outside the router so its
 * webviews survive route transitions, but it must share the same atom registry
 * as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <ElectronBrowserHost />
      <BrowserProfileReporter />
      <QuitHoldOverlay />
      {/* T3-CUSTOM(expbkt3): needs the registry above, which the Clerk shell wraps. */}
      <ToolyardAutoConnect />
    </AppAtomRegistryProvider>
  );
}
