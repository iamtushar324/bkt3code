/**
 * T3-CUSTOM(expbkt3): the right panel's layout is a workspace habit, not a
 * property of one thread.
 *
 * Upstream tracks "is the right panel maximized" as a per-thread key held in
 * component state, so it resets on reload and on every thread switch: open a
 * plan full-screen in one thread, open a plan in the next, and it comes back
 * side-by-side. People pick a working shape once (full-screen for reading a
 * plan, side-by-side for editing next to the chat) and expect it to stick.
 *
 * The panel's *width* is already durable — PreviewPanelShell persists it under
 * `t3code:preview-panel-width` for every surface that does not override the
 * key — so only the maximized/side-by-side choice needs a home. Keeping that
 * here rather than inline in ChatView.tsx keeps the upstream merge surface to a
 * handful of marked lines.
 *
 * @module rightPanelLayoutPreference
 */
import * as Schema from "effect/Schema";

import { useLocalStorage } from "./hooks/useLocalStorage";

export const RIGHT_PANEL_MAXIMIZED_STORAGE_KEY = "t3code:right-panel-maximized";

/**
 * Whether a right-panel surface should open full-screen. Defaults to false, so
 * a first-time user still gets upstream's side-by-side layout.
 */
export function useRightPanelMaximizedPreference() {
  return useLocalStorage(RIGHT_PANEL_MAXIMIZED_STORAGE_KEY, false, Schema.Boolean);
}
