// T3-CUSTOM(expbkt3): which browser hosts a new preview tab.
//
// Upstream's `previewRuntimeFor` sends every tab of an environment with a
// server browser to that server. The fork adds a host setting, `previewBrowser`,
// shared by every user of the host. With `client` (the default), a desktop app
// keeps drawing tabs in its own Electron browser, on the user's machine, as it
// did before the server browser existed. Clients without a browser of their own
// (web, phone) still need the server browser, so they use it in either mode.
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type PreviewBrowserHostSetting,
  type PreviewRuntime,
} from "@t3tools/contracts";

import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentServerConfigsAtom } from "~/state/server";

import { resolvePreviewRuntime } from "./previewBrowserHost.logic";

function readEnvironmentPreviewBrowser(environmentId: EnvironmentId): PreviewBrowserHostSetting {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.settings.previewBrowser ??
    DEFAULT_SERVER_SETTINGS.previewBrowser
  );
}

export function forkPreviewRuntimeFor(
  environmentId: EnvironmentId,
  serverBrowser: boolean,
): PreviewRuntime | undefined {
  return resolvePreviewRuntime({
    serverBrowser,
    desktopBrowser: isPreviewSupportedInRuntime(),
    previewBrowser: readEnvironmentPreviewBrowser(environmentId),
  });
}
