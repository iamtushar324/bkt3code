/**
 * T3-CUSTOM(expbkt3): how long a desktop-local backend may take to describe itself.
 *
 * The platform source builds every registration before it hands any of them
 * to the registry, so the primary environment is not connected until each
 * desktop-local backend has answered. A managed build starts its bundled
 * backend after the window opens, and a backend still starting holds every
 * request until startup finishes. With the default 10 s request timeout, a
 * window opened during that start waited 10 s before it even asked the
 * remote primary for a WebSocket ticket.
 *
 * A ready loopback backend answers in milliseconds. One that misses this
 * deadline is skipped for this poll and retried on the next one, 3 s later.
 */
export const DESKTOP_LOCAL_DESCRIPTOR_TIMEOUT_MS = 1_500;
