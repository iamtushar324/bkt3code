import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";

import { trackKeyboardLayout } from "./keyboardLayout";
// T3-CUSTOM(expbkt3): browser-only public setup continuation, without tokens.
import { prepareToolyardSettingsContinuation } from "./fork/toolyardSettingsContinuation";
// T3-CUSTOM(expbkt3): standalone identity mode also loads the lazy auth shell.
import { resolveAppClerkMode, resolveClerkPublishableKey } from "./cloud/publicConfig";
import { isElectron } from "./env";
import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { whenLocaleReady } from "./i18n/runtime";
import { chunkLoadState } from "./lib/chunkReloadGuard";

const stopTrackingKeyboardLayout = trackKeyboardLayout();
import.meta.hot?.dispose(stopTrackingKeyboardLayout);

// T3-CUSTOM(expbkt3): preserve public Toolyard setup drafts before authentication redirects
// and before the router reads the address.
prepareToolyardSettingsContinuation();

const router = startAppServices();

// T3-CUSTOM(expbkt3): identity-only mode also needs the publishable key/mode split.
const clerkPublishableKey = resolveClerkPublishableKey();
const clerkMode = resolveAppClerkMode();

const app = <AppRoot router={router} />;

// T3-CUSTOM(expbkt3): managed or identity-only auth uses the selected lazy runtime.
// Split by runtime to keep Clerk out of local startup and clerk-js out of browser builds.
const managedAuthShellModule =
  clerkPublishableKey && clerkMode !== "disabled"
    ? isElectron
      ? import("./components/clerk/ElectronManagedAuthShell")
      : import("./components/clerk/BrowserManagedAuthShell")
    : null;

export const startup = Promise.all([
  managedAuthShellModule?.then((module) => module.default) ?? null,
  // Chained so settings have usually hydrated; English resolves without a chunk load.
  router.load().then(whenLocaleReady),
])
  .then(([ManagedAuthShell]) => {
    // Route chunk failures resolve router.load() and surface later through the error boundary.
    if (chunkLoadState.reloadScheduled) return;
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        {ManagedAuthShell && clerkPublishableKey ? (
          <ManagedAuthShell publishableKey={clerkPublishableKey}>{app}</ManagedAuthShell>
        ) : (
          app
        )}
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (chunkLoadState.reloadScheduled) return;
    throw error;
  });
