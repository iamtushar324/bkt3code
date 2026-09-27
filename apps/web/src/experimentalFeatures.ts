/**
 * T3-CUSTOM(expbkt3): Single feature-flag boundary for every experimental
 * control-center UI seam. Keep upstream-facing additions gated through this
 * constant so they remain easy to locate and merge.
 */
export const EXPERIMENTAL_CONTROL_CENTER_ENABLED =
  import.meta.env.VITE_T3_EXPERIMENTAL_CONTROL_CENTER?.trim().toLowerCase() === "true";

/**
 * T3-CUSTOM(expbkt3): background deepening of each thread's cached history.
 *
 * On by default — a thin cache is what makes an offline handoff weak — with an
 * escape hatch, because this is the one seam here that spends host round-trips
 * and client memory in the background. Set the variable to "false" to isolate
 * it if a huge thread ever misbehaves.
 */
export const OFFLINE_HISTORY_SYNC_ENABLED =
  import.meta.env.VITE_T3_OFFLINE_HISTORY_SYNC?.trim().toLowerCase() !== "false";
