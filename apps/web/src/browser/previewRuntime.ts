import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PreviewRuntime, PreviewSessionSnapshot } from "@t3tools/contracts";

import { isElectron } from "~/env";
import { desktopOwnEnvironmentIdAtom } from "~/fork/desktopOwnEnvironment"; // T3-CUSTOM(expbkt3)
import { forkPreviewRuntimeFor } from "~/fork/previewBrowserHost"; // T3-CUSTOM(expbkt3)
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import {
  readEnvironmentSupportsServerBrowser,
  useEnvironmentSupportsServerBrowser,
} from "~/state/entities";

export function previewRuntimeFor(environmentId: EnvironmentId): PreviewRuntime | undefined {
  // T3-CUSTOM(expbkt3): the host's previewBrowser setting can keep tabs in the desktop app.
  return forkPreviewRuntimeFor(environmentId, readEnvironmentSupportsServerBrowser(environmentId));
}

/** Electron hosts its own browser tabs; other clients need the environment to host them. */
export function isPreviewAvailableFor(environmentId: EnvironmentId): boolean {
  return isPreviewSupportedInRuntime() || readEnvironmentSupportsServerBrowser(environmentId);
}

export function usePreviewAvailable(environmentId: EnvironmentId | null): boolean {
  const serverBrowser = useEnvironmentSupportsServerBrowser(environmentId);
  return isPreviewSupportedInRuntime() || serverBrowser;
}

/**
 * Whether this client draws a server tab with its own `<webview>`. The desktop
 * app renders tabs of the server it launched, which drives them over the
 * desktop browser channel; every other client and environment streams them.
 */
export function rendersServerTabNatively(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
): boolean {
  return (
    isElectron &&
    snapshot?.runtime === "server" &&
    primaryEnvironmentId !== null &&
    environmentId === primaryEnvironmentId
  );
}

export function useRendersServerTabNatively(
  environmentId: EnvironmentId,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
): boolean {
  // T3-CUSTOM(expbkt3): a managed build launched `bk-local`, not its dev-server-1 primary.
  const ownEnvironmentId = useAtomValue(desktopOwnEnvironmentIdAtom);
  return rendersServerTabNatively(environmentId, ownEnvironmentId, snapshot);
}
