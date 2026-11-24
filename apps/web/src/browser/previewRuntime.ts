import { useAtomValue } from "@effect/atom-react";
import {
  allowsPreviewTunnel,
  type EnvironmentId,
  type PreviewRuntime,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "~/connection/catalog";
import { isElectron } from "~/env";
import { desktopOwnEnvironmentIdAtom } from "~/fork/desktopOwnEnvironment"; // T3-CUSTOM(expbkt3)
import { forkPreviewRuntimeFor } from "~/fork/previewBrowserHost"; // T3-CUSTOM(expbkt3)
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import {
  readEnvironmentSupportsServerBrowser,
  useEnvironmentSupportsServerBrowser,
} from "~/state/entities";
import { environmentServerConfigsAtom } from "~/state/server";

import { tunnelsEnvironmentLoopback } from "./browserTargetResolver";

/** Whether this desktop loads the environment's localhost itself: it is local, or its tunnel is on. */
const desktopLoadsLoopbackAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const target = get(environmentCatalog.catalogValueAtom).entries.get(environmentId)?.target;
    if (!tunnelsEnvironmentLoopback(target)) return true;
    const config = get(environmentServerConfigsAtom).get(environmentId);
    return config !== undefined && allowsPreviewTunnel(config);
  }).pipe(Atom.withLabel(`preview:desktop-loads-loopback:${environmentId}`)),
);

export function previewRuntimeFor(environmentId: EnvironmentId): PreviewRuntime | undefined {
  // T3-CUSTOM(expbkt3): the host's previewBrowser setting can keep tabs in the desktop app.
  const serverBrowser = readEnvironmentSupportsServerBrowser(environmentId);
  const runtime = forkPreviewRuntimeFor(environmentId, serverBrowser);
  // Without its tunnel, another environment's tabs stream from it, as on the web.
  if (
    runtime === undefined &&
    serverBrowser &&
    environmentId !== appAtomRegistry.get(primaryEnvironmentIdAtom) &&
    !appAtomRegistry.get(desktopLoadsLoopbackAtom(environmentId))
  ) {
    return "server";
  }
  return runtime;
}

export function alternatePreviewRuntime(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  serverBrowser: boolean,
  desktopLoadsLoopback: boolean,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
): PreviewRuntime | null {
  if (!snapshot || !serverBrowser || !isPreviewSupportedInRuntime()) return null;
  if (environmentId === primaryEnvironmentId) return null;
  if (snapshot.runtime === "server") return desktopLoadsLoopback ? "desktop" : null;
  return "server";
}

export function useDesktopLoadsLoopback(environmentId: EnvironmentId): boolean {
  return useAtomValue(desktopLoadsLoopbackAtom(environmentId));
}

export function isPreviewAvailableFor(environmentId: EnvironmentId): boolean {
  return isPreviewSupportedInRuntime() || readEnvironmentSupportsServerBrowser(environmentId);
}

export function usePreviewAvailable(environmentId: EnvironmentId | null): boolean {
  const serverBrowser = useEnvironmentSupportsServerBrowser(environmentId);
  return isPreviewSupportedInRuntime() || serverBrowser;
}

export function rendersServerTabNatively(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "headless"> | null | undefined,
): boolean {
  return (
    isElectron &&
    snapshot?.runtime === "server" &&
    !snapshot.headless &&
    primaryEnvironmentId !== null &&
    environmentId === primaryEnvironmentId
  );
}

export function useRendersServerTabNatively(
  environmentId: EnvironmentId,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "headless"> | null | undefined,
): boolean {
  // T3-CUSTOM(expbkt3): a managed build launched `bk-local`, not its dev-server-1 primary.
  const ownEnvironmentId = useAtomValue(desktopOwnEnvironmentIdAtom);
  return rendersServerTabNatively(environmentId, ownEnvironmentId, snapshot);
}
