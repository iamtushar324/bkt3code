// T3-CUSTOM(expbkt3): the environment whose server this desktop app launched.
//
// Upstream draws a server tab natively (in the desktop's own `<webview>`, driven
// by the server over the desktop browser channel) only for "the server the
// desktop launched", and assumes that is the primary environment. A managed BK
// build breaks that assumption: its primary is the central server on
// dev-server-1, and the server it launched is the bundled `bk-local` secondary.
// Without this, a dev-server-1 tab renders as a local webview nobody drives,
// and a `bk-local` tab streams instead of rendering natively.
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "~/connection/catalog";
import { desktopLocalBackendId } from "~/connection/desktopLocal";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { BK_BUNDLED_BACKEND_ID, isBkManagedPrimary } from "./managedEnvironment";

export const desktopOwnEnvironmentIdAtom = Atom.make((get) => {
  if (!isBkManagedPrimary()) return get(primaryEnvironmentIdAtom);
  for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
    if (desktopLocalBackendId(entry.target) === BK_BUNDLED_BACKEND_ID) return environmentId;
  }
  return null;
}).pipe(Atom.withLabel("web-desktop-own-environment-id"));
