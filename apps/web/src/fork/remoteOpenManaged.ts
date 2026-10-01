/**
 * T3-CUSTOM(expbkt3): whether the desktop app manages its own primary backend.
 *
 * Upstream's remote-open resolver treats a desktop renderer's primary
 * environment as "this machine" unconditionally, because in an upstream build
 * the desktop app *is* the primary backend's host — even in wsl-only mode,
 * where the primary binds a non-loopback NAT address.
 *
 * A managed BK build breaks that assumption: its primary points at the central
 * bkt3/expbkt3 server (see {@link isBkManagedPrimary}), which is a different
 * machine entirely. Left unfixed, "Open in <editor>" asks *the server* to spawn
 * an editor — on dev-server-1 that silently launches a headless `cursor` on the
 * server and nothing opens on the viewer's Mac.
 *
 * The bundled local backend is unaffected: it registers as a `local:`-prefixed
 * secondary, which upstream already classifies as local-exec.
 *
 * @module fork/remoteOpenManaged
 */

/**
 * True when the primary environment is a backend this desktop app runs itself,
 * which is what upstream's `isDesktopRenderer` flag actually gates on.
 */
export function desktopManagesPrimaryBackend(input: {
  readonly hasDesktopBridge: boolean;
  readonly isManagedPrimary: boolean;
}): boolean {
  return input.hasDesktopBridge && !input.isManagedPrimary;
}
