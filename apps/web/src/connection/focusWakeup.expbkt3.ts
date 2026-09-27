/**
 * T3-CUSTOM(expbkt3): decides what a window `focus` should wake.
 *
 * The desktop window never emits `visibilitychange` after a sleep, so the fork
 * treats `focus` as a wakeup. Emitting a full "application-active" on every
 * focus made each alt-tab rebuild the shell and replay every open thread, so:
 *
 * - focus after the window was blurred or hidden for at least a minute is a
 *   real return: "application-active" (probe + resubscribe);
 * - any shorter absence only probes the connection: "application-focus".
 *
 * Waking from sleep does not rely on this: the desktop shell forwards the OS
 * resume/unlock event, which reconnects at once.
 *
 * One return to the window usually fires several of these at once: focus,
 * `visibilitychange`, and `online` after a network blip. Each full
 * "application-active" restarts every open subscription and discards the
 * catch-up the previous one had in flight, so after the first resync (or
 * reconnect) any "application-active" inside `RETURN_COALESCE_MS` only probes.
 */
import * as Stream from "effect/Stream";
import { Wakeups } from "@t3tools/client-runtime/connection";

export const FOCUS_RESYNC_AFTER_MS = 60_000;
export const RETURN_COALESCE_MS = 5_000;

export type FocusWakeup = "application-active" | "application-focus";

export function makeFocusWakeupTracker(now: () => number = Date.now) {
  let inactiveSinceMs: number | null = null;
  return {
    /** The window lost focus or was hidden; the earliest moment wins. */
    markInactive: (): void => {
      inactiveSinceMs ??= now();
    },
    /** A visibility-driven "application-active" already covers this return. */
    markResynced: (): void => {
      inactiveSinceMs = null;
    },
    onFocus: (): FocusWakeup => {
      const since = inactiveSinceMs;
      inactiveSinceMs = null;
      return since !== null && now() - since >= FOCUS_RESYNC_AFTER_MS
        ? "application-active"
        : "application-focus";
    },
  };
}

export function makeReturnWakeupCoalescer(now: () => number = Date.now) {
  let lastResyncAtMs: number | null = null;
  return (wakeup: Wakeups.ConnectionWakeup): Wakeups.ConnectionWakeup => {
    if (wakeup !== "application-active" && wakeup !== "application-active-reconnect") {
      return wakeup;
    }
    const at = now();
    if (
      wakeup === "application-active" &&
      lastResyncAtMs !== null &&
      at - lastResyncAtMs < RETURN_COALESCE_MS
    ) {
      return "application-focus";
    }
    lastResyncAtMs = at;
    return wakeup;
  };
}

/** The platform wakeup layer, with one resync per return to the window. */
export const coalescedWakeupsLayer = (service: Wakeups.ConnectionWakeups["Service"]) =>
  Wakeups.layer({
    changes: Stream.suspend(() => Stream.map(service.changes, makeReturnWakeupCoalescer())),
  });
