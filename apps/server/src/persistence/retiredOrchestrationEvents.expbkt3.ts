/**
 * T3-CUSTOM(expbkt3): event types written by retired fork features.
 *
 * The event log is append-only, so long-lived fork databases still hold rows
 * of these types after the features (and their contract schemas) were
 * removed. Reads skip them in SQL, before decoding, so a replay never fails
 * on a type the current contracts no longer know. Nothing projects them.
 */
export const RETIRED_ORCHESTRATION_EVENT_TYPES = [
  // Catch-up summaries.
  "thread.catchup-summary-requested",
  "thread.catchup-summary-updated",
  // Bulk session manager work summaries.
  "thread.work-summary-requested",
  "thread.work-summary-updated",
  // Durable execution: same-turn steer acknowledgement.
  "thread.turn-adopted",
  // Durable thread bootstrap lifecycle.
  "thread.bootstrap-requested",
  "thread.bootstrap-step-updated",
  "thread.bootstrap-stop-requested",
  "thread.bootstrap-retry-requested",
  "thread.bootstrap-continue-requested",
  "thread.bootstrap-completed",
] as const;
