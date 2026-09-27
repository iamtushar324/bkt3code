import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

export type ConnectionWakeup =
  | "application-active"
  | "application-active-probe"
  | "application-active-reconnect"
  // T3-CUSTOM(expbkt3): reason used by the supervisor's idle heartbeat.
  // Internal to the supervisor: an idle-connection health check, or a
  // subscription reporting that its transport died while the supervisor still
  // believes the lease is healthy. Never emitted by platform wakeup sources,
  // and deliberately not an "application active" wakeup — nobody is waiting on
  // the app, so it must not reset backoff or trigger resubscription on its own.
  | "connection-heartbeat"
  // T3-CUSTOM(expbkt3): a window regained focus after a short absence. The
  // supervisor probes the session (and cuts a retry wait short) like
  // "application-active", but streams are not resubscribed: a quick alt-tab
  // must not rebuild the shell and replay every open thread.
  | "application-focus"
  | "credentials-changed";

export function isApplicationActiveWakeup(reason: ConnectionWakeup): boolean {
  return (
    reason === "application-active" ||
    reason === "application-active-probe" ||
    // T3-CUSTOM(expbkt3): focus wakes count as the user returning.
    reason === "application-active-reconnect" ||
    reason === "application-focus"
  );
}

export function shouldResubscribeAfterWakeup(reason: ConnectionWakeup): boolean {
  return reason === "application-active" || reason === "application-active-probe";
}

export class ConnectionWakeups extends Context.Service<
  ConnectionWakeups,
  {
    readonly changes: Stream.Stream<ConnectionWakeup>;
  }
>()("@t3tools/client-runtime/connection/wakeups/ConnectionWakeups") {}

const make = (service: ConnectionWakeups["Service"]) => ConnectionWakeups.of(service);

export const layer = (service: ConnectionWakeups["Service"]) =>
  Layer.succeed(ConnectionWakeups, make(service));
