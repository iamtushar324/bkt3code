import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
// T3-CUSTOM(expbkt3): connect the built-in toolyard integration once per app load.
import { ToolyardAutoConnect } from "./fork/toolyardAutoConnect";

// Keep webviews outside the router but inside its atom registry so route changes preserve them.
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <ElectronBrowserHost />
      <QuitHoldOverlay />
      {/* T3-CUSTOM(expbkt3): needs the registry above, which the Clerk shell wraps. */}
      <ToolyardAutoConnect />
    </AppAtomRegistryProvider>
  );
}
