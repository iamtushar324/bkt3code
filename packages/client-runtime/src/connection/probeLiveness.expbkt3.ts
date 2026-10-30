/**
 * How the supervisor reads a late health probe (TEC-1837).
 *
 * Production servers stall for 3-14 s under load. Replacing every socket that
 * is slow to answer turned each stall into a reconnect storm: each new session
 * reloads the full shell and reopens every subscription. A late probe is only
 * proof of a dead socket when no frame arrived while it ran.
 */

/** A retried probe, and every probe started by a quick signal, waits this long. */
export const QUICK_PROBE_TIMEOUT = "8 seconds";

/** Silent late probes in a row that end a session no signal marked as a path change. */
export const SILENT_PROBE_TIMEOUTS_BEFORE_TEARDOWN = 2;

/** Upper bound of the random wait before reconnecting after a probe timeout. */
export const PROBE_TIMEOUT_RECONNECT_JITTER_MAX_MS = 2_000;

export type ProbeTimeoutOutcome =
  | {
      /** Keep the session, show it as slow, and probe again. */
      readonly _tag: "Degraded";
      readonly silentTimeouts: number;
    }
  | { readonly _tag: "TearDown" };

/**
 * - A frame arrived while the probe ran: the socket reaches a busy server.
 *   Keep it, and restart the silent count.
 * - No frame, and a signal said the network path changed (or the user asked
 *   to retry): the old socket is likely dead. End it now.
 * - No frame otherwise: one more chance, then end it.
 */
export function probeTimeoutOutcome(input: {
  readonly framesDuringProbe: boolean;
  readonly silentTimeoutsBefore: number;
  readonly decisive: boolean;
}): ProbeTimeoutOutcome {
  if (input.framesDuringProbe) {
    return { _tag: "Degraded", silentTimeouts: 0 };
  }
  const silentTimeouts = input.silentTimeoutsBefore + 1;
  return input.decisive || silentTimeouts >= SILENT_PROBE_TIMEOUTS_BEFORE_TEARDOWN
    ? { _tag: "TearDown" }
    : { _tag: "Degraded", silentTimeouts };
}

/**
 * Spreads the reconnects of many clients that saw the same server stall, so
 * they do not all arrive at once. `random` is in [0, 1).
 */
export function probeTimeoutReconnectJitterMs(random: number): number {
  const bounded = Math.min(Math.max(random, 0), 1);
  return Math.round(bounded * PROBE_TIMEOUT_RECONNECT_JITTER_MAX_MS);
}
